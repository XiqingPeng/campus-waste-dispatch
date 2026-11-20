import { Camera, CircleAlert, Film, Image as ImageIcon, ScanLine, Upload, Video, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { errorText, request } from './api';
import { categories, sampleKeys, samples } from './domain';
import type { Result, Sample } from './domain';

type Input =
  | { kind: 'sample'; sample: Sample }
  | { kind: 'image'; label: string; data: string }
  | { kind: 'video'; label: string; url: string }
  | { kind: 'camera' };

function toJpeg(source: CanvasImageSource, width: number, height: number) {
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
  context.drawImage(source, (canvas.width - scaledWidth) / 2, (canvas.height - scaledHeight) / 2, scaledWidth, scaledHeight);
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

export function Capture({ onResult, visible }: { onResult: (result: Result | null) => void; visible: boolean }) {
  const [input, setInput] = useState<Input>({ kind: 'sample', sample: 'bottle' });
  const [pending, setPending] = useState(false);
  const [openingCamera, setOpeningCamera] = useState(false);
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const videoUrl = useRef<string | null>(null);
  const sequence = useRef(0);

  function releaseMedia() {
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    if (videoUrl.current) URL.revokeObjectURL(videoUrl.current);
    videoUrl.current = null;
  }

  useEffect(() => () => {
    sequence.current += 1;
    releaseMedia();
  }, []);

  useEffect(() => {
    if (input.kind === 'camera' && video.current) video.current.srcObject = stream.current;
  }, [input]);

  useEffect(() => {
    if (!visible && (input.kind === 'camera' || openingCamera)) {
      sequence.current += 1;
      releaseMedia();
      setOpeningCamera(false);
      setPending(false);
      setInput({ kind: 'sample', sample: 'bottle' });
    }
  }, [visible, input.kind, openingCamera]);

  function startNewInput() {
    sequence.current += 1;
    releaseMedia();
    onResult(null);
    setPending(false);
    setOpeningCamera(false);
    setError('');
    return sequence.current;
  }

  function chooseSample(sample: Sample) {
    startNewInput();
    setInput({ kind: 'sample', sample });
  }

  async function loadFile(file: File | undefined) {
    if (!file) return;
    const version = startNewInput();
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
    const version = startNewInput();
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

  async function recognize() {
    const version = ++sequence.current;
    setPending(true);
    setError('');
    onResult(null);
    try {
      let body: { image: string; mode: 'live' } | { sample: Sample; mode: 'replay' };
      if (input.kind === 'sample') {
        body = { sample: input.sample, mode: 'replay' };
      } else if (input.kind === 'image') {
        body = { image: input.data, mode: 'live' };
      } else {
        const current = video.current;
        if (!current || current.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
          throw new Error('等画面出现后再截帧识别。');
        }
        current.pause();
        const data = toJpeg(current, current.videoWidth, current.videoHeight);
        if (input.kind === 'camera') {
          releaseMedia();
          setInput({ kind: 'image', label: '相机截图', data });
        }
        body = { image: data, mode: 'live' };
      }
      const result = await request<Result>('/api/recognize', body);
      if (sequence.current === version) onResult(result);
    } catch (cause) {
      if (sequence.current === version) setError(errorText(cause));
    } finally {
      if (sequence.current === version) setPending(false);
    }
  }

  const sample = input.kind === 'sample' ? samples[input.sample] : null;
  const SampleIcon = sample ? categories[sample.category].icon : null;
  const currentLabel = sample?.label ?? (input.kind === 'camera' ? '摄像头' : 'label' in input ? input.label : '');
  const uploaded = input.kind === 'image' || input.kind === 'video';

  return (
    <section className="panel capture-panel" aria-labelledby="capture-title">
      <div className="panel-heading">
        <span className="section-icon"><ScanLine size={21} /></span>
        <div>
          <h2 id="capture-title">物品识别</h2>
          <p>每次拍摄或上传一件物品</p>
        </div>
      </div>

      <div className="media-tabs" aria-label="图像来源">
        <button className={sample ? 'active' : ''} aria-pressed={Boolean(sample)} onClick={() => chooseSample('bottle')}>
          <ImageIcon size={17} /> 样例回放
        </button>
        <button className={uploaded ? 'active' : ''} aria-pressed={uploaded} onClick={() => fileInput.current?.click()}>
          <Upload size={17} /> 上传文件
        </button>
        <button className={input.kind === 'camera' ? 'active' : ''} aria-pressed={input.kind === 'camera'} onClick={() => void openCamera()} disabled={openingCamera}>
          <Camera size={17} /> {openingCamera ? '正在打开' : '摄像头'}
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="image/*,video/*"
          aria-label="选择图片或视频"
          hidden
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            void loadFile(file);
          }}
        />
      </div>

      <div className={'media-window' + (sample ? ' media-demo' : '')}>
        {sample && (
          'image' in sample
            ? <img className="sample-photo" src={sample.image} alt="投放物品公开样例" />
            : <div className="sample-placeholder">
                {SampleIcon && <SampleIcon size={51} strokeWidth={1.3} aria-hidden />}
                <span>{sample.label}</span>
              </div>
        )}
        {input.kind === 'image' && <img src={input.data} alt="当前待识别的物品" />}
        {input.kind === 'video' && (
          <video
            ref={video}
            src={input.url}
            controls
            playsInline
            preload="metadata"
            onPlay={() => { sequence.current += 1; setPending(false); onResult(null); }}
            onSeeking={() => { sequence.current += 1; setPending(false); onResult(null); }}
            onError={() => setError('浏览器无法播放该视频，请上传 MP4 文件。')}
          />
        )}
        {input.kind === 'camera' && <video ref={video} playsInline autoPlay muted aria-label="摄像头实时画面" />}
        <span className="media-tag">{sample ? <Film size={14} /> : <Video size={14} />}
          {sample ? ('image' in sample ? '公开样例 · 演示回放' : '样例 · 演示回放') : 'JEV 实时推理'}
        </span>
        {input.kind === 'camera' && (
          <button className="media-close" aria-label="关闭摄像头" onClick={() => chooseSample('bottle')}><X size={16} /></button>
        )}
        {(input.kind === 'sample' || input.kind === 'camera') && <div className="viewfinder" aria-hidden><i /><i /><i /><i /></div>}
        {input.kind !== 'video' && <span className="media-caption">{currentLabel}</span>}
      </div>

      {sample ? (
        <div className="sample-row" aria-label="选择演示样例">
          {sampleKeys.map((key) => (
            <button key={key} aria-pressed={input.kind === 'sample' && input.sample === key} onClick={() => chooseSample(key)}>
              {samples[key].label}
            </button>
          ))}
        </div>
      ) : (
        <p className="media-note">
          {input.kind === 'video' ? '把进度条拉到物品清楚的画面，再点击截帧识别。' : '点击识别后，单张图像将发送至 JEV 接口。'}
        </p>
      )}

      {error && <div className="callout error" role="status"><CircleAlert size={17} /><span>{error}</span></div>}
      <button className="primary recognize" onClick={() => void recognize()} disabled={pending || openingCamera}>
        <ScanLine size={20} /> {pending ? '处理中…' : sample ? '识别样例' : input.kind === 'video' || input.kind === 'camera' ? '截帧识别' : '识别图片'}
      </button>
    </section>
  );
}
