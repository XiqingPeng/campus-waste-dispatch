from dataclasses import dataclass
import hashlib
import json
import logging
from pathlib import Path
from threading import Event, RLock, Thread
from time import monotonic

import cv2

from .demo import DEMO_DEVICE, DEMO_REGIONS, scene
from .store import utc_now
from .vision import (DropDetector, FullnessClassifier, FullnessTracker, HandLandmarks,
                     Reading, decode_jpg, encode_jpg, validate_regions)

log = logging.getLogger("waste-monitor")


@dataclass(frozen=True)
class Settings:
    sample_seconds: float = 5.0
    confirm_samples: int = 3
    clear_samples: int = 3
    motion_ratio: float = 0.025
    cooldown_seconds: float = 2.0

    @classmethod
    def load(cls, config):
        raw = json.loads(config.read_text(encoding="utf-8-sig"))
        result = cls(**raw)
        if not (1.0 <= result.sample_seconds <= 60 and
                type(result.confirm_samples) is int and 2 <= result.confirm_samples <= 10 and
                type(result.clear_samples) is int and 2 <= result.clear_samples <= 10 and
                0.003 <= result.motion_ratio <= 0.35 and
                0.5 <= result.cooldown_seconds <= 8):
            raise ValueError("config.json contains values outside the supported ranges.")
        return result


def replay_key(path):
    st = path.stat()
    topic = f"{path.resolve()}:{st.st_size}:{st.st_mtime_ns}"
    return hashlib.sha256(topic.encode()).hexdigest()[:20]


class Monitor:
    def __init__(self, store, settings, model_file, mode="live", video=None):
        self.store, self.settings = store, settings
        self.model_file, self.mode, self.video = Path(model_file), mode, video
        self.lock = RLock()
        self.stop_signal, self.wake = Event(), Event()
        self.worker = None
        self.hand_detector = None
        self.hand_error = None
        self.camera = None
        self.device = None
        self.calibration = None
        self.calibration_error = None
        self.preview = None
        self.latest = None
        self.latest_clean_refs = {}
        self.reference_epoch = 0
        self.capture_state = "WAITING"
        self.message = "正在等待相机画面。"
        self.reading = Reading("UNKNOWN", "等待有效画面")
        self.last_seen_at = None
        self.engine = None
        self.drop = None
        self.tracker = None
        self.next_sample = 0.0
        self.preview_at = -float("inf")
        self.last_drop_id = None
        self.replay_paused = False
        self.restart_requested = False
        if mode == "demo" and not self.store.get_calibration(DEMO_DEVICE):
            self.store.save_calibration(DEMO_DEVICE, "DEMO-01", DEMO_REGIONS,
                                        encode_jpg(scene(0)[0]), encode_jpg(scene(8)[0]))

    def start(self):
        self.worker = Thread(target=self.run, name="camera-monitor", daemon=True)
        self.worker.start()

    def stop(self):
        self.stop_signal.set()
        self.wake.set()
        if self.worker:
            self.worker.join(timeout=4)

    def _wait(self, timeout):
        self.wake.wait(max(0, timeout))
        self.wake.clear()

    def _disconnect(self, message, state="WAITING"):
        with self.lock:
            self.capture_state, self.message = state, message
            self.latest = None
            self.reading = Reading("UNKNOWN", message)
            self.latest_clean_refs.clear()
            self.reference_epoch += 1
            if self.drop:
                self.drop.reset()
            if self.tracker:
                self.tracker.reset_counts()
            self.next_sample = 0.0

    def snapshot(self):
        with self.lock:
            config = None
            if self.calibration:
                config = {k: self.calibration[k] for k in ("label", "version", "regions", "saved_at")}
            active = self.store.active_fullness(self.device) if self.device else None
            return {
                "mode": self.mode, "state": self.capture_state, "message": self.message,
                "device": self.device, "camera": self.camera,
                "camera_preference": self.store.get_setting("camera_index"),
                "calibration": config, "calibration_error": self.calibration_error,
                "reference_epoch": self.reference_epoch, "references": sorted(self.latest_clean_refs),
                "last_seen_at": self.last_seen_at, "has_preview": self.preview is not None,
                "fullness": vars(self.reading), "active_fullness": active,
                "hand_error": self.hand_error, "last_drop_id": self.last_drop_id,
                "sample_seconds": self.settings.sample_seconds,
                "confirm_samples": self.settings.confirm_samples, "paused": self.replay_paused,
            }

    def set_camera(self, index):
        if self.mode != "live":
            raise ValueError("只可在摄像头模式切换设备。")
        value = "auto" if index is None else str(index)
        with self.lock:
            self.store.set_setting("camera_index", value)
            self.store.set_setting("last_camera_index", "")
            self.restart_requested = True
            self._disconnect("正在切换摄像头。")
            self.device = self.camera = None
            self.preview = None
            self.calibration = self.engine = self.drop = self.tracker = None
        self.wake.set()

    def set_replay(self, action):
        if self.mode == "live":
            raise ValueError("相机实时模式不支持回放控制。")
        with self.lock:
            if action == "restart":
                self.restart_requested = True
                self.replay_paused = False
            else:
                self.replay_paused = action == "pause"
        self.wake.set()

    def _need_restart(self):
        with self.lock:
            result, self.restart_requested = self.restart_requested, False
            return result

    def capture_ref(self, name, device, epoch):
        with self.lock:
            self._validate_current_source(device, epoch)
            now = monotonic()
            if self.latest is None or (self.mode == "live" and now - self.latest[1] > 2.5):
                raise ValueError("没有新画面。请先等待摄像头连通。")
            self.latest_clean_refs[name] = encode_jpg(self.latest[0], 91)
            return sorted(self.latest_clean_refs)

    def get_ref(self, name):
        with self.lock:
            return self.latest_clean_refs.get(name)

    def _validate_current_source(self, device, epoch):
        if self.capture_state not in ("ONLINE", "PAUSED") or self.device != device or self.reference_epoch != epoch:
            raise ValueError("画面来源已变化，请从当前画面重新采集参考图。")

    def calibrate(self, device, epoch, label, regions):
        validate_regions(regions)
        with self.lock:
            self._validate_current_source(device, epoch)
            if not {"empty", "full"} <= self.latest_clean_refs.keys():
                raise ValueError("请分别采集空桶和接近满载参考图。")
            empty, full = self.latest_clean_refs["empty"], self.latest_clean_refs["full"]
            self._make_classifier(regions, empty, full)
            self.store.save_calibration(device, label.strip(), regions, empty, full)
            self._use_calibration(self.store.get_calibration(device))
            return self.calibration["version"]

    def _make_classifier(self, regions, empty, full):
        return FullnessClassifier(regions, decode_jpg(empty), decode_jpg(full))

    def _use_calibration(self, calibration):
        self.calibration = calibration
        self.calibration_error = None
        self.drop = self.engine = self.tracker = None
        self.next_sample = 0.0
        self.reading = Reading("UNKNOWN", "等待首个满载采样" if calibration else "请先标定摄像头与垃圾桶")
        if not calibration:
            return
        try:
            self.engine = self._make_classifier(calibration["regions"], calibration["empty_image"],
                                                calibration["full_image"])
            self.drop = DropDetector(calibration["regions"]["mouth"], self.settings.motion_ratio,
                                     self.settings.cooldown_seconds)
            self.tracker = FullnessTracker(self.store, self.device, calibration["label"],
                                           self.settings.confirm_samples, self.settings.clear_samples)
        except ValueError as error:
            self.calibration_error = str(error)

    def _hands(self, frame, now):
        if self.hand_error:
            return []
        try:
            if self.hand_detector is None:
                self.hand_detector = HandLandmarks(self.model_file)
            return self.hand_detector.detect(frame, now)
        except (ImportError, OSError, RuntimeError, ValueError) as error:
            self.hand_error = "手部检测不可用。投放抓拍已暂停，请检查安装日志并重启。"
            log.exception("Hand landmark inference unavailable: %s", error)
            return []

    def _record_drop(self, record):
        if record and self.calibration:
            self.last_drop_id = self.store.add_drop(self.device, self.calibration["label"],
                                                    record.occurred_at, record.evidence, record.frames)

    def _handle_frame(self, frame, now, device, camera, synthetic_points=None):
        with self.lock:
            if self.mode == "live" and self.restart_requested:
                return
            h, w = frame.shape[:2]
            if self.device != device or self.capture_state not in ("ONLINE", "PAUSED"):
                self.device, self.camera = device, camera
                self.latest_clean_refs.clear()
                self.reference_epoch += 1
                try:
                    self._use_calibration(self.store.get_calibration(device))
                except (ValueError, TypeError, KeyError):
                    self._use_calibration(None)
                    self.calibration_error = "保存的标定无法读取，请重新标定。"
                self.preview_at = -float("inf")

            self.capture_state = "ONLINE"
            self.message = f"已接收 {w} × {h} 画面。"
            self.latest = (frame, monotonic())
            self.last_seen_at = utc_now()
            if now >= self.preview_at + 0.22:
                image = frame if w <= 960 else cv2.resize(frame, (960, round(h * 960 / w)))
                self.preview = encode_jpg(image, 74)
                self.preview_at = now
            if not self.engine:
                return

            hand_points = synthetic_points if synthetic_points is not None else self._hands(frame, now)
            if self.drop and not self.hand_error:
                self._record_drop(self.drop.feed(frame, now, self.last_seen_at, hand_points))
            if now >= self.next_sample:
                period = self.settings.sample_seconds if self.mode != "demo" else 1.0
                self.next_sample = now + period
                read = self.engine.read(frame, hand_points)
                self.reading = self.tracker.consume(read, self.last_seen_at)

    def save_manual(self, device, epoch):
        from .vision import Frame
        with self.lock:
            self._validate_current_source(device, epoch)
            if self.latest is None:
                raise ValueError("没有可保存的画面。")
            at = self.last_seen_at
            label = self.calibration["label"] if self.calibration else "未标定"
            self.last_drop_id = self.store.add_drop(self.device, label, at, "手动触发（测试）",
                                                    [Frame(0.0, at, encode_jpg(self.latest[0]), 0.0)])
            return self.last_drop_id

    def backlog_cleared(self, event):
        return bool(self.store.report_cleaned(event))

    def candidate_cameras(self):
        preferred = self.store.get_setting("camera_index")
        if preferred and preferred != "auto":
            return [int(preferred)]
        last = self.store.get_setting("last_camera_index")
        return [int(last)] if last else list(range(4))

    def _new_camera(self):
        import sys
        backends = [cv2.CAP_DSHOW, cv2.CAP_MSMF] if sys.platform == "win32" else [cv2.CAP_ANY]
        for index in self.candidate_cameras():
            for backend in backends:
                if self.stop_signal.is_set() or self.restart_requested:
                    return None
                capture = cv2.VideoCapture(index, backend)
                if not capture.isOpened():
                    capture.release()
                    continue
                if sys.platform == "win32":
                    capture.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
                capture.set(cv2.CAP_PROP_FRAME_WIDTH, 1920)
                capture.set(cv2.CAP_PROP_FRAME_HEIGHT, 1080)
                capture.set(cv2.CAP_PROP_FPS, 30)
                ok, frame = capture.read()
                if not ok or frame is None:
                    capture.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
                    capture.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
                    ok, frame = capture.read()
                if ok and frame is not None:
                    self.store.set_setting("last_camera_index", str(index))
                    return capture, frame, index, capture.getBackendName()
                capture.release()
        return None

    def _live(self):
        delay = 0.5
        while not self.stop_signal.is_set():
            self._need_restart()
            match = self._new_camera()
            if not match:
                self._disconnect("等待摄像头。插入 USB 摄像头后会自动重试。")
                self._wait(delay)
                delay = min(3.0, delay * 1.6)
                continue
            delay = 0.5
            capture, frame, index, backend = match
            last = -float("inf")
            try:
                while not self.stop_signal.is_set() and not self._need_restart():
                    now = monotonic()
                    if now - last >= 0.085:
                        h, w = frame.shape[:2]
                        sig = f"camera:{index}:{backend}:{w}x{h}"
                        self._handle_frame(frame, now, sig, index)
                        last = now
                    ok, frame = capture.read()
                    if not ok or frame is None:
                        self._disconnect("摄像头已断开或被占用，正在重连。")
                        break
            finally:
                capture.release()
            self._wait(0.35)

    def _demo(self):
        step = 0
        while not self.stop_signal.is_set():
            if self._need_restart():
                step = 0
                self._disconnect("演示已从头播放。")
            if self.replay_paused:
                with self.lock:
                    if self.latest is not None:
                        self.capture_state = "PAUSED"
                self._wait(0.12)
                continue
            t = step / 10
            image, hand = scene(t)
            self._handle_frame(image, t, DEMO_DEVICE, None, hand)
            step += 1
            if step >= 220:
                self._disconnect("下一轮演示。")
                step = 0
            self._wait(0.10)

    def _video(self):
        path = self.video
        replay_device = "replay:" + replay_key(path)
        while not self.stop_signal.is_set():
            self._need_restart()
            capture = cv2.VideoCapture(str(path))
            try:
                if not capture.isOpened():
                    self._disconnect("录像无法打开。请选择可播放的 MP4、AVI 或 MOV 文件。", "ERROR")
                    return
                fps = capture.get(cv2.CAP_PROP_FPS)
                fps = fps if 1 <= fps <= 240 else 25.0
                stride = max(1, round(fps / 10))
                idx = 0
                finished = False
                while not self.stop_signal.is_set() and not self._need_restart():
                    if self.replay_paused and idx > 0:
                        with self.lock:
                            self.capture_state = "PAUSED"
                        self._wait(0.12)
                        continue
                    ok, frame = capture.read()
                    if not ok:
                        with self.lock:
                            if self.drop:
                                self._record_drop(self.drop.finish(idx / fps + 0.55))
                            self.capture_state = "FINISHED"
                            self.message = "录像已结束。可点击从头回放。"
                            self.reading = Reading("UNKNOWN", "回放已结束")
                        finished = True
                        break
                    if idx % stride == 0:
                        h, w = frame.shape[:2]
                        self._handle_frame(frame, idx / fps, f"{replay_device}:{w}x{h}", None)
                        self._wait(stride / fps)
                    idx += 1
            finally:
                capture.release()
            while finished and not self.stop_signal.is_set() and not self._need_restart():
                self._wait(0.2)
            if not self.stop_signal.is_set():
                self._disconnect("录像从头播放。")

    def run(self):
        try:
            {"live": self._live, "demo": self._demo, "replay": self._video}[self.mode]()
        except (cv2.error, OSError, RuntimeError, ValueError):
            log.exception("Capture loop stopped")
            self._disconnect("视频处理发生错误，请看终端日志后重新启动。", "ERROR")
        except Exception:
            log.exception("Unexpected monitor error")
            self._disconnect("监测服务发生错误，请看终端日志后重新启动。", "ERROR")
        finally:
            if self.hand_detector:
                self.hand_detector.close()
