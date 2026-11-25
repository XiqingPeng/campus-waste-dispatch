"""Deterministic test footage and simulated landmarks for the no-camera demo."""
import math

import cv2
import numpy as np


DEMO_DEVICE = "demo:640x360"
DEMO_REGIONS = {
    "mouth": [(0.48, 0.44), (0.80, 0.44), (0.80, 0.57), (0.48, 0.57)],
    "interior": [(0.49, 0.45), (0.79, 0.45), (0.79, 0.79), (0.49, 0.79)],
    "band": [(0.50, 0.46), (0.78, 0.46), (0.78, 0.58), (0.50, 0.58)],
}


def scene(t):
    frame = np.full((360, 640, 3), (236, 231, 216), np.uint8)
    cv2.rectangle(frame, (0, 300), (639, 359), (195, 191, 178), -1)
    cv2.rectangle(frame, (299, 150), (523, 294), (107, 83, 40), -1)
    cv2.rectangle(frame, (308, 158), (515, 285), (58, 51, 43), -1)
    cv2.rectangle(frame, (299, 151), (523, 167), (160, 118, 61), 3)
    cv2.line(frame, (307, 207), (515, 207), (124, 125, 128), 1)
    full = 5.0 <= t < 15.0
    if full:
        for i in range(42):
            x = 319 + (i * 37) % 182
            y = 166 + (i * 29) % 110
            color = [(170, 194, 226), (221, 202, 159), (157, 196, 211), (157, 212, 156)][i % 4]
            cv2.ellipse(frame, (x, y), (8 + i % 11, 5 + i % 7), i * 31 % 180,
                        0, 360, color, -1)
    points = []
    if 1.4 < t < 4.1:
        phase = (t - 1.4) / 2.7
        x = round(248 + 139 * math.sin(math.pi * phase))
        y = round(117 + 66 * math.sin(math.pi * phase))
        cv2.circle(frame, (166, 90), 31, (137, 177, 213), -1)
        cv2.rectangle(frame, (124, 119), (205, 286), (114, 96, 49), -1)
        cv2.line(frame, (190, 133), (x, y), (125, 169, 212), 15)
        cv2.circle(frame, (x, y), 10, (125, 169, 212), -1)
        block_y = y if phase <= 0.55 else min(214, y + round((phase - 0.55) * 180))
        cv2.rectangle(frame, (x + 7, block_y - 10), (x + 24, block_y + 11), (45, 173, 230), -1)
        points = [(x / 639, y / 359)]
    cv2.putText(frame, "DEMO  |  SYNTHETIC VIDEO", (26, 38), cv2.FONT_HERSHEY_SIMPLEX,
                0.56, (59, 69, 78), 1, cv2.LINE_AA)
    return frame, points
