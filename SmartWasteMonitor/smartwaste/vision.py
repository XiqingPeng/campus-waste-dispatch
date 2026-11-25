from collections import deque
from dataclasses import dataclass

import cv2
import numpy as np


REGIONS = ("mouth", "interior", "band")
ANALYSIS_SIZE = (360, 224)


def points_pixels(points, size):
    w, h = size
    return np.asarray([(round(x * (w - 1)), round(y * (h - 1))) for x, y in points], np.int32)


def region_mask(points, size):
    mask = np.zeros((size[1], size[0]), np.uint8)
    cv2.fillPoly(mask, [points_pixels(points, size)], 1)
    return mask.astype(bool)


def validate_regions(regions):
    if set(regions) != set(REGIONS):
        raise ValueError("请画出桶口、桶内和满载参考带。")
    masks = {}
    for name, points in regions.items():
        if not 3 <= len(points) <= 24:
            raise ValueError("每个区域需要 3 至 24 个顶点。")
        if any(not (0 <= x <= 1 and 0 <= y <= 1) for x, y in points):
            raise ValueError("坐标必须位于当前画面内。")
        contour = points_pixels(points, ANALYSIS_SIZE)
        if cv2.contourArea(contour) < ANALYSIS_SIZE[0] * ANALYSIS_SIZE[1] * 0.0025:
            raise ValueError("有区域过小，或多边形边线交叉。请重新画。")
        masks[name] = region_mask(points, ANALYSIS_SIZE)
    if (masks["band"] & masks["interior"]).sum() < masks["band"].sum() * 0.90:
        raise ValueError("请将满载参考带画在桶内区域里。")


def inside(points, pt):
    return cv2.pointPolygonTest(np.asarray(points, np.float32), pt, False) >= 0


def encode_jpg(frame, quality=88):
    ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        raise RuntimeError("无法编码当前画面。")
    return buf.tobytes()


def decode_jpg(data):
    out = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
    if out is None:
        raise ValueError("参考图无法读取。")
    return out


class HandLandmarks:
    def __init__(self, weights):
        import mediapipe as mp
        self.mp = mp
        vision = mp.tasks.vision
        options = vision.HandLandmarkerOptions(
            base_options=mp.tasks.BaseOptions(model_asset_buffer=weights.read_bytes()),
            running_mode=vision.RunningMode.VIDEO,
            num_hands=2,
            min_hand_detection_confidence=0.40,
            min_hand_presence_confidence=0.45,
        )
        self.detector = vision.HandLandmarker.create_from_options(options)
        self.last_ms = -1

    def detect(self, frame, now):
        h, w = frame.shape[:2]
        if w > 640:
            frame = cv2.resize(frame, (640, round(h * 640 / w)), interpolation=cv2.INTER_AREA)
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        ms = max(self.last_ms + 1, int(now * 1_000))
        self.last_ms = ms
        image = self.mp.Image(image_format=self.mp.ImageFormat.SRGB, data=rgb)
        result = self.detector.detect_for_video(image, ms)
        return [(float(hand[i].x), float(hand[i].y)) for hand in result.hand_landmarks for i in (0, 8)]

    def close(self):
        self.detector.close()


@dataclass
class Frame:
    t: float
    wall: str
    jpeg: bytes
    quality: float


@dataclass
class Drop:
    crossing_at: float
    occurred_at: str
    evidence: str
    frames: list


class DropDetector:
    def __init__(self, mouth, motion_ratio=0.025, cooldown=2.0, after=0.5):
        self.mouth = mouth
        self.motion_ratio = motion_ratio
        self.cooldown = cooldown
        self.after = after
        self.center = np.mean(mouth, axis=0)
        self.mask = region_mask(mouth, ANALYSIS_SIZE)
        self.reset()

    def reset(self):
        self.frames = deque()
        self.last_gray = None
        self.last_hand = None
        self.last_frame_t = None
        self.last_exit = -float("inf")
        self.last_outside = -float("inf")
        self.last_motion = -float("inf")
        self.last_motion_ratio = 0.0
        self.last_event = -float("inf")
        self.candidate = None
        self.pending = None
        self.has_left = True

    def _choose(self, contour):
        candidates = [f for f in self.frames if contour - 1.5 <= f.t <= contour + 0.3]
        if not candidates:
            return []
        # Timing is the first signal. Sharpness only breaks ties between nearby frames.
        ordered = sorted(candidates, key=lambda f: abs(f.t - (contour - 0.14)) -
                         0.001 * min(150, f.quality))
        selected = [ordered[0]]
        for pic in ordered[1:]:
            if all(abs(other.t - pic.t) >= 0.12 for other in selected):
                selected.append(pic)
                if len(selected) == 3:
                    break
        return selected

    def finish(self, t):
        if not self.pending or t < self.pending[0] + self.after:
            return None
        crossing, wall, ratio = self.pending
        self.pending = None
        frames = self._choose(crossing)
        if frames:
            reason = "手部从桶口外移入；桶口变化像素占比 {:.1%}；需人工确认。".format(ratio)
            return Drop(crossing, wall, reason, frames)
        return None

    def feed(self, frame, t, wall, hand_points):
        if self.last_frame_t is not None and t - self.last_frame_t > 1.25:
            self.reset()
        self.last_frame_t = t
        small = cv2.resize(frame, ANALYSIS_SIZE, interpolation=cv2.INTER_AREA)
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
        quality = float(cv2.Laplacian(gray, cv2.CV_32F).var())
        self.frames.append(Frame(t, wall, encode_jpg(frame), quality))
        while self.frames and (self.frames[0].t < t - 3.0 or len(self.frames) > 40):
            self.frames.popleft()

        ratio = 0.0
        if self.last_gray is not None:
            change = cv2.absdiff(self.last_gray, gray)[self.mask]
            ratio = np.count_nonzero(change >= 24) / max(1, change.size)
            if ratio >= self.motion_ratio:
                self.last_motion = t
                self.last_motion_ratio = ratio
        self.last_gray = gray
        nearest = min(hand_points, key=lambda pt: float(np.linalg.norm(pt - self.center)),
                      default=None)
        if nearest is not None and np.linalg.norm(nearest - self.center) > 0.31:
            nearest = None
        if nearest is not None:
            in_opening = inside(self.mouth, nearest)
            if not in_opening:
                self.last_outside = t
                self.last_exit = t if self.last_hand is not None and                     inside(self.mouth, self.last_hand) else self.last_exit
                self.has_left = True
            if in_opening and self.last_hand is not None and not inside(self.mouth, self.last_hand)                     and t - self.last_outside <= 0.65 and self.has_left:
                # Allow two clearly separate actions close together after a visible exit.
                separated = self.last_exit > self.last_event and t - self.last_exit >= 0.35
                if t - self.last_event >= self.cooldown or separated:
                    self.candidate = (t, wall)
            self.last_hand = nearest
        else:
            self.last_hand = None

        if self.candidate:
            start, at = self.candidate
            if t - start > 0.5:
                self.candidate = None
            elif not self.pending and self.last_motion >= start - 0.18:
                self.pending = (start, at, self.last_motion_ratio)
                self.last_event, self.candidate, self.has_left = t, None, False
        return self.finish(t)


@dataclass
class Reading:
    state: str
    detail: str
    score: float | None = None


class FullnessClassifier:
    SIZE = (128, 80)

    def __init__(self, regions, empty, full, full_threshold=0.64, clear_threshold=0.36):
        self.regions = regions
        self.interior = region_mask(regions["interior"], self.SIZE)
        self.band = region_mask(regions["band"], self.SIZE) & self.interior
        self.empty, self.full = self._extract(empty), self._extract(full)
        self.separation = self._distance(self.empty, self.full)
        self.full_threshold = full_threshold
        self.clear_threshold = clear_threshold
        if self.separation < 0.035:
            raise ValueError("空桶和接近满载的参考图差异太小。请检查参考带与参考图。")

    def _extract(self, frame):
        resized = cv2.resize(frame, self.SIZE, interpolation=cv2.INTER_AREA)
        smooth = cv2.GaussianBlur(resized, (3, 3), 0)
        gray = cv2.cvtColor(smooth, cv2.COLOR_BGR2GRAY)
        strength = cv2.convertScaleAbs(cv2.Laplacian(gray, cv2.CV_32F))
        return smooth.astype(np.float32), strength.astype(np.float32), gray

    def _distance(self, left, right):
        color = np.abs(left[0] - right[0]).mean(axis=2)
        texture = np.abs(left[1] - right[1])
        mix = 0.78 * color + 0.22 * texture
        return float((0.74 * mix[self.band].mean() + 0.26 * mix[self.interior].mean()) / 255.0)

    def read(self, frame, hand_points):
        if any(inside(self.regions["interior"], pt) or inside(self.regions["mouth"], pt)
               for pt in hand_points):
            return Reading("UNKNOWN", "手部遮挡观察区域")
        current = self._extract(frame)
        bright = current[2][self.interior]
        if np.percentile(bright, 85) < 26 or np.percentile(bright, 15) > 247:
            return Reading("UNKNOWN", "桶内画面过暗或过曝")
        empty_dist = self._distance(current, self.empty)
        full_dist = self._distance(current, self.full)
        if min(empty_dist, full_dist) > max(0.12, self.separation * 0.65 + 0.04):
            return Reading("UNKNOWN", "画面与参考图的差异过大")
        score = empty_dist / max(1e-6, empty_dist + full_dist)
        if score >= self.full_threshold:
            return Reading("FULL", "接近满载参考图", score)
        if score <= self.clear_threshold:
            return Reading("NORMAL", "接近空桶参考图", score)
        return Reading("UNKNOWN", "画面介于两组参考图之间", score)


class FullnessTracker:
    def __init__(self, store, device, label, confirm_samples=3, clear_samples=3):
        self.store = store
        self.device = device
        self.label = label
        self.confirm_samples = confirm_samples
        self.clear_samples = clear_samples
        self.reset_counts()

    def reset_counts(self):
        self.first = None
        self.seen_full = 0
        self.seen_clear = 0

    def consume(self, reading, wall):
        active = self.store.active_fullness(self.device)
        if reading.state == "UNKNOWN":
            self.reset_counts()
            return reading
        if active:
            if reading.state == "NORMAL" and active["cleaning_reported_at"]:
                self.seen_clear += 1
                if self.seen_clear >= self.clear_samples and self.store.resolve_full(active["id"], wall):
                    self.reset_counts()
                    return Reading("NORMAL", "视觉复核通过，已复位", reading.score)
                return Reading("FULL", f"清理复核中 {self.seen_clear}/{self.clear_samples}", reading.score)
            self.seen_clear = 0
            detail = "已确认满载"
            if active["cleaning_reported_at"]:
                detail = "清理后仍像满载，请检查桶内或参考图"
            elif reading.state == "NORMAL":
                detail = "外观已接近空桶，等待人工登记清理"
            return Reading("FULL", detail, reading.score)

        if reading.state == "FULL":
            if self.seen_full == 0:
                self.first = wall
            self.seen_full += 1
            if self.seen_full >= self.confirm_samples:
                self.store.confirm_full(self.device, self.label, self.first, wall)
                self.reset_counts()
                return Reading("FULL", "连续多次确认满载", reading.score)
            return Reading("CHECKING", f"候选满载 {self.seen_full}/{self.confirm_samples}", reading.score)
        self.reset_counts()
        return reading
