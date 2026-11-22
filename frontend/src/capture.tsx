import { Camera, CircleAlert, Image as ImageIcon, ScanLine, Upload, Video, X } from 'lucide-react';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { errorText, request } from './api';
import { sampleKeys, samples } from './domain';
import type { ContentsAnswer, RecognitionFollowup, Result, Sample } from './domain';
import { useLocale } from './locale';

type Input =
  | { kind: 'sample'; sample: Sample }
  | { kind: 'image'; label: string; data: string }
  | { kind: 'video'; label: string; url: string }
  | { kind: 'camera' };

function toJpeg(source: CanvasImageSource, width: number, height: number, x = 0, y = 0) {
  if (!width || !height) throw new Error('还没有可用画面，请稍候或播放视频。');
  const scale = Math.min(1200 / Math.max(width, height), 1);
  const scaledWidth = Math.max(1, Math.round(width * scale));
  const scaledHeight = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(280, scaledWidth);
  canvas.height = Math.max(280, scaledHeight);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('浏览器无法处理图像。');
  context.fillStyle = '#f0f3f1';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, x, y, width, height, (canvas.width - scaledWidth) / 2, (canvas.height - scaledHeight) / 2, scaledWidth, scaledHeight);
  return canvas.toDataURL('image/jpeg', 0.86);
}

async function readImage(file: File) {
  const bitmap = await createImageBitmap(file);
  try {
    return toJpeg(bitmap, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

function frameArea(video: HTMLVideoElement, inViewfinder = false) {
  const { videoWidth, videoHeight, clientWidth, clientHeight } = video;
  const scale = Math.min(clientWidth / videoWidth, clientHeight / videoHeight);
  const width = Math.min(videoWidth, inViewfinder ? clientWidth * 0.54 / scale : videoWidth * 0.7);
  const height = Math.min(videoHeight, inViewfinder ? clientHeight * 0.62 / scale : videoHeight * 0.7);
  return { x: (videoWidth - width) / 2, y: (videoHeight - height) / 2, width, height };
}

function frameSampler() {
  const canvas = document.createElement('canvas');
  canvas.width = 48;
  canvas.height = 36;
  const { width, height } = canvas;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('浏览器无法处理图像。');

  return (video: HTMLVideoElement, { x, y, width: sourceWidth, height: sourceHeight }: ReturnType<typeof frameArea>) => {
    context.drawImage(video, x, y, sourceWidth, sourceHeight, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height).data;
    const luma = new Uint8Array(width * height);
    let detail = 0;
    let clipped = 0;
    for (let i = 0; i < luma.length; i += 1) {
      const offset = i * 4;
      const level = Math.round(pixels[offset] * 0.3 + pixels[offset + 1] * 0.59 + pixels[offset + 2] * 0.11);
      luma[i] = level;
      if (i % width) detail += Math.abs(level - luma[i - 1]);
      if (i >= width) detail += Math.abs(level - luma[i - width]);
      if (level < 18 || level > 245) clipped += 1;
    }
    return { luma, score: (detail - 30 * clipped) / luma.length };
  };
}

function changeRatio(first: Uint8Array, second: Uint8Array) {
  let changed = 0;
  for (let i = 0; i < first.length; i += 1) {
    if (Math.abs(first[i] - second[i]) >= 24) changed += 1;
  }
  return changed / first.length;
}

function waitForVideo(video: HTMLVideoElement, event: 'loadeddata' | 'seeked', signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    function cleanup() {
      video.removeEventListener(event, ready);
      video.removeEventListener('error', failed);
      signal.removeEventListener('abort', failed);
    }
    function ready() {
      cleanup();
      resolve();
    }
    function failed() {
      cleanup();
      reject(signal.reason ?? new Error('浏览器无法播放该视频，请上传 MP4 文件。'));
    }
    video.addEventListener(event, ready);
    video.addEventListener('error', failed);
    signal.addEventListener('abort', failed);
  });
}

async function bestVideoFrame(url: string, currentTime: number, signal: AbortSignal) {
  const decoder = document.createElement('video');
  decoder.muted = true;
  decoder.preload = 'auto';
  try {
    const loaded = waitForVideo(decoder, 'loadeddata', signal);
    decoder.src = url;
    await loaded;
    const times = new Set([0, -0.4, 0.4, -0.8, 0.8].map((offset) =>
      Math.max(0, Math.min(currentTime + offset, decoder.duration - 0.04)),
    ));
    const measure = frameSampler();
    let bestTime = decoder.currentTime;
    let bestScore = -Infinity;
    for (const time of times) {
      if (Math.abs(decoder.currentTime - time) > 0.005) {
        const sought = waitForVideo(decoder, 'seeked', signal);
        decoder.currentTime = time;
        await sought;
      }
      const { score } = measure(decoder, frameArea(decoder));
      if (score > bestScore) {
        bestScore = score;
        bestTime = decoder.currentTime;
      }
    }
    if (decoder.currentTime !== bestTime) {
      const sought = waitForVideo(decoder, 'seeked', signal);
      decoder.currentTime = bestTime;
      await sought;
    }
    return { image: toJpeg(decoder, decoder.videoWidth, decoder.videoHeight), time: bestTime };
  } finally {
    decoder.removeAttribute('src');
    decoder.load();
  }
}

export function Capture({ onResult, visible, result }: {
  onResult: (result: Result | null) => void; visible: boolean; result: Result | null;
}) {
  const { t, text } = useLocale();
  const [input, setInput] = useState<Input>({ kind: 'sample', sample: 'bottle' });
  const [pending, setPending] = useState(false);
  const [openingCamera, setOpeningCamera] = useState(false);
  const [liveConfigured, setLiveConfigured] = useState<boolean>();
  const [autoCamera, setAutoCamera] = useState(false);
  const [selectedTime, setSelectedTime] = useState<number | null>(null);
  const [confirmationImage, setConfirmationImage] = useState<string | null>(null);
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const captureButton = useRef<HTMLButtonElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const videoUrl = useRef<string | null>(null);
  const sequence = useRef(0);
  const processing = useRef(false);
  const selection = useRef<AbortController | null>(null);
  const cameraCaptured = useRef(false);
  const needsRetake = result?.source === 'jev' && !result.category && result.status !== 'unresolved';

  function invalidate() {
    sequence.current += 1;
    selection.current?.abort();
    selection.current = null;
    processing.current = false;
  }

  function releaseMedia() {
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    if (videoUrl.current) URL.revokeObjectURL(videoUrl.current);
    videoUrl.current = null;
  }

  useEffect(() => () => {
    invalidate();
    releaseMedia();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let active = true;
    void request<{ live_vision: boolean }>('/api/health').then(
      ({ live_vision }) => { if (active) setLiveConfigured(live_vision); },
      () => { if (active) setLiveConfigured(undefined); },
    );
    return () => { active = false; };
  }, [visible]);

  useEffect(() => {
    if (input.kind === 'camera' && video.current) video.current.srcObject = stream.current;
  }, [input]);

  useEffect(() => {
    if (!visible) {
      invalidate();
      setPending(false);
      setConfirmationImage(null);
      if (input.kind !== 'camera' && !openingCamera) return;
      releaseMedia();
      setOpeningCamera(false);
      setAutoCamera(false);
      setInput({ kind: 'sample', sample: 'bottle' });
    }
  }, [visible, input.kind, openingCamera]);

  function startNewInput(keepResult = false) {
    invalidate();
    releaseMedia();
    if (!keepResult) onResult(null);
    setPending(false);
    setOpeningCamera(false);
    setAutoCamera(false);
    setSelectedTime(null);
    setConfirmationImage(null);
    setError('');
    return sequence.current;
  }

  function chooseSample(sample: Sample) {
    startNewInput();
    setInput({ kind: 'sample', sample });
  }

  async function loadFile(file: File | undefined) {
    if (!file) return;
    const version = startNewInput(needsRetake);
    setInput({ kind: 'sample', sample: 'bottle' });
    try {
      if (file.type.startsWith('image/')) {
        setPending(true);
        const data = await readImage(file);
        if (sequence.current === version) setInput({ kind: 'image', label: file.name, data });
      } else if (file.type.startsWith('video/')) {
        const url = URL.createObjectURL(file);
        videoUrl.current = url;
        setInput({ kind: 'video', label: file.name, url });
      } else {
        throw new Error('请选择浏览器可读取的图片或视频文件。');
      }
    } catch {
      if (sequence.current === version) setError('无法打开该文件，请试试 JPEG、PNG 或 MP4。');
    } finally {
      if (sequence.current === version) setPending(false);
    }
  }

  async function openCamera() {
    const version = startNewInput(needsRetake);
    setInput({ kind: 'sample', sample: 'bottle' });
    setOpeningCamera(true);
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('摄像头需要通过 localhost 或 HTTPS 访问，也可上传图片或录像。');
      }
      const media = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' } },
      });
      if (sequence.current !== version) {
        media.getTracks().forEach((track) => track.stop());
        return;
      }
      stream.current = media;
      setInput({ kind: 'camera' });
    } catch (cause) {
      if (sequence.current === version) {
        setError(cause instanceof DOMException
          ? '无法使用摄像头，请检查授权和设备，或上传图片和视频。'
          : errorText(cause));
      }
    } finally {
      if (sequence.current === version) setOpeningCamera(false);
    }
  }

  function resetVideoResult() {
    invalidate();
    setPending(false);
    setSelectedTime(null);
    setConfirmationImage(null);
    if (!needsRetake) onResult(null);
  }

  async function recognize({ selectFrame, automaticFrame, answer }: {
    selectFrame?: boolean; automaticFrame?: string; answer?: ContentsAnswer;
  } = {}) {
    if (processing.current || (answer && !confirmationImage)) return;
    const retake = needsRetake && !answer && !automaticFrame && input.kind !== 'sample';
    processing.current = true;
    const version = ++sequence.current;
    setPending(true);
    setError('');
    if (!answer) {
      setSelectedTime(null);
      setConfirmationImage(null);
      if (!retake) onResult(null);
    }
    try {
      let body: { image: string; mode: 'live'; followup?: RecognitionFollowup } | { sample: Sample; mode: 'replay' };
      if (answer && confirmationImage) {
        body = { image: confirmationImage, mode: 'live', followup: { kind: 'confirm', field: 'contents', value: answer } };
      } else if (input.kind === 'sample') {
        body = { sample: input.sample, mode: 'replay' };
      } else if (input.kind === 'image') {
        body = { image: input.data, mode: 'live' };
      } else {
        const current = video.current;
        if (!current || current.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
          throw new Error('等画面出现后再截帧识别。');
        }
        let data = automaticFrame;
        if (input.kind === 'video') {
          current.pause();
          if (selectFrame) {
            const controller = new AbortController();
            selection.current = controller;
            const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(4000)]);
            try {
              const frame = await bestVideoFrame(input.url, current.currentTime, signal);
              if (sequence.current !== version) return;
              data = frame.image;
              setSelectedTime(frame.time);
            } catch {
              if (sequence.current === version) setError('无法自动选帧，请暂停视频后手动截帧。');
              return;
            } finally {
              if (selection.current === controller) selection.current = null;
            }
          }
        }
        data ??= toJpeg(current, current.videoWidth, current.videoHeight);
        if (input.kind === 'camera' && autoCamera) cameraCaptured.current = true;
        if (input.kind === 'camera' && !autoCamera) {
          releaseMedia();
          setInput({ kind: 'image', label: '相机截图', data });
        }
        body = { image: data, mode: 'live' };
      }
      if (body.mode === 'live' && retake) body.followup = { kind: 'retake' };
      const response = await request<Result>('/api/recognize', body);
      if (sequence.current === version) {
        setConfirmationImage(response.status === 'confirm' && body.mode === 'live' ? body.image : null);
        onResult(response);
      }
    } catch (cause) {
      if (sequence.current === version) setError(errorText(cause));
    } finally {
      if (sequence.current === version) {
        processing.current = false;
        setPending(false);
      }
    }
  }

  const submitAutomaticFrame = useEffectEvent((image: string) => void recognize({ automaticFrame: image }));

  useEffect(() => {
    if (!visible || input.kind !== 'camera' || !autoCamera) return;
    const current = video.current;
    if (!current) return;
    const measure = frameSampler();
    let background: Uint8Array | undefined;
    let previous: Uint8Array | undefined;
    let clearSince: number | undefined;
    let stableSince: number | undefined;
    let best: { image: string; score: number } | undefined;
    cameraCaptured.current = false;

    const timer = window.setInterval(() => {
      if (current.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
      const area = frameArea(current, true);
      const { luma, score } = measure(current, area);
      background ??= luma;
      const foreground = changeRatio(background, luma);
      const moving = previous && changeRatio(previous, luma) > 0.04;
      previous = luma;
      const now = performance.now();

      if (foreground < 0.035) {
        clearSince ??= now;
        if (now - clearSince >= 500) cameraCaptured.current = false;
      } else {
        clearSince = undefined;
      }
      if (cameraCaptured.current || processing.current || foreground < 0.08 || foreground > 0.65 || moving || score <= 0) {
        stableSince = undefined;
        best = undefined;
        return;
      }
      stableSince ??= now;
      if (!best || best.score < score) {
        best = { image: toJpeg(current, area.width, area.height, area.x, area.y), score };
      }
      if (now - stableSince >= 600) submitAutomaticFrame(best.image);
    }, 125);

    return () => window.clearInterval(timer);
  }, [visible, input.kind, autoCamera]);

  const sample = input.kind === 'sample' ? samples[input.sample] : null;
  const currentLabel = sample?.label ?? (input.kind === 'camera' ? '摄像头' : 'label' in input ? input.label : '');
  const uploaded = input.kind === 'image' || input.kind === 'video';

  return (
    <section className="panel capture-panel" aria-labelledby="capture-title">
      <div className="panel-heading">
        <span className="section-icon"><ScanLine size={21} /></span>
        <div>
          <h2 id="capture-title">{t('物品识别')}</h2>
          <p>{t('每次拍摄或上传一件物品')}</p>
        </div>
      </div>

      <div className="media-tabs" aria-label={t('图像来源')}>
        <button className={sample ? 'active' : ''} aria-pressed={Boolean(sample)} onClick={() => chooseSample('bottle')}>
          <ImageIcon size={17} /> {t('样例')}
        </button>
        <button className={uploaded ? 'active' : ''} aria-pressed={uploaded} onClick={() => fileInput.current?.click()}>
          <Upload size={17} /> {t(needsRetake ? '上传补拍' : '上传文件')}
        </button>
        <button className={input.kind === 'camera' ? 'active' : ''} aria-pressed={input.kind === 'camera'} onClick={() => void openCamera()} disabled={openingCamera}>
          <Camera size={17} /> {t(openingCamera ? '正在打开' : needsRetake && input.kind !== 'camera' ? '换角度补拍' : '摄像头')}
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="image/*,video/*"
          aria-label={t('选择图片或视频')}
          hidden
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            void loadFile(file);
          }}
        />
      </div>

      <div className={'media-window' + (sample ? ' media-demo' : '')}>
        {input.kind === 'sample' && (
          <div className={'sample-photo sample-' + input.sample} role="img" aria-label={t(samples[input.sample].label)} />
        )}
        {input.kind === 'image' && <img src={input.data} alt={t('当前待识别的物品')} />}
        {input.kind === 'video' && (
          <video
            ref={video}
            src={input.url}
            controls
            playsInline
            preload="metadata"
            onPlay={resetVideoResult}
            onSeeking={resetVideoResult}
            onError={() => setError('浏览器无法播放该视频，请上传 MP4 文件。')}
          />
        )}
        {input.kind === 'camera' && <video ref={video} playsInline autoPlay muted aria-label={t('摄像头实时画面')} />}
        {!sample && liveConfigured === true && <span className="media-tag"><Video size={14} /> {t('JEV 实时推理')}</span>}
        {input.kind === 'camera' && (
          <button className="media-close" aria-label={t('关闭摄像头')} onClick={() => chooseSample('bottle')}><X size={16} /></button>
        )}
        {input.kind === 'camera' && <div className="viewfinder" aria-hidden><i /><i /><i /><i /></div>}
        {!sample && input.kind !== 'video' && <span className="media-caption">{text(currentLabel)}</span>}
      </div>

      {sample ? (
        <div className="sample-row" role="group" aria-label={t('选择样例')}>
          {sampleKeys.map((key) => (
            <button key={key} aria-pressed={input.kind === 'sample' && input.sample === key} onClick={() => chooseSample(key)}>
              <span className={'sample-photo sample-' + key} aria-hidden />
              <span>{t(samples[key].label)}</span>
            </button>
          ))}
        </div>
      ) : liveConfigured !== false && (
        <p className="media-note">
          {selectedTime !== null ? t('已选取第 {time} 秒的画面。', { time: selectedTime.toFixed(1) })
            : input.kind === 'video' ? t('把进度条拉到物品附近，可自动选帧或手动截帧。')
            : input.kind === 'camera' ? t(autoCamera ? '将物品放进框内并稳住，尽量让手留在框外。移开物品后可识别下一件。' : '开启自动抓拍前，请固定摄像头并移开框内的手和物品。')
            : t('点击识别后，单张图像将发送至 JEV 接口。')}
          {needsRetake && <> {result.question ? text(result.question) : t('请换个角度拍清材质、标签或内容物，再识别同一件物品。')}</>}
        </p>
      )}

      {liveConfigured === false && !error && (
        <p className="media-note" role="status">{t('实时 JEV 尚未启用，可先使用样例。')}</p>
      )}
      {error && <div className="callout error" role="status"><CircleAlert size={17} /><span>{text(error)}</span></div>}
      {confirmationImage && (
        <div className="confirmation-actions">
          <button className="outline" onClick={() => void recognize({ answer: 'present' })} disabled={pending}>{t('有剩液')}</button>
          <button className="outline" onClick={() => void recognize({ answer: 'empty' })} disabled={pending}>{t('已倒空')}</button>
          <button className="outline" disabled={pending} onClick={() => {
            setConfirmationImage(null);
            if (input.kind === 'camera' || input.kind === 'video') captureButton.current?.focus();
            else void openCamera();
          }}>{t('看不清，换角度拍')}</button>
        </div>
      )}
      <div className="capture-actions">
        <button ref={captureButton} className="primary recognize" onClick={() => void recognize()} disabled={pending || openingCamera}>
          <ScanLine size={20} /> {t(pending ? '处理中…' : needsRetake && input.kind === 'camera' ? '补拍并识别'
            : input.kind === 'video' || input.kind === 'camera' ? '截帧识别' : '识别图片')}
        </button>
        {input.kind === 'video' && (
          <button className="outline recognize" onClick={() => void recognize({ selectFrame: true })} disabled={pending}>
            {t('自动选帧并识别')}
          </button>
        )}
        {input.kind === 'camera' && (
          <button className="outline recognize" onClick={() => setAutoCamera(!autoCamera)} disabled={pending && !autoCamera}>
            {t(autoCamera ? '关闭自动抓拍' : '开启自动抓拍')}
          </button>
        )}
      </div>
    </section>
  );
}
