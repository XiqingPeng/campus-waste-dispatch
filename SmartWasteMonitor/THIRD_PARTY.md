# Third-party components

- CPython 3.11.18 for Windows x64 from Astral python-build-standalone, release 20261123, install-only stripped. SHA-256: b7822833fc5f6f317b79f189c15f923c4321773c087b50e535b39ee2472832b4. Release: https://github.com/astral-sh/python-build-standalone/releases/tag/20261123. The runtime license is retained in `vendor/python/LICENSE.txt`.
- The Python wheels in `vendor/wheels/` are unmodified PyPI distributions pinned by `requirements-windows.txt`. Their original license metadata accompanies each wheel.
- MediaPipe Hand Landmarker float16 v1 is the unmodified Google model. SHA-256: fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1. Source: https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task. MediaPipe Apache-2.0 text: `weights/LICENSE-MediaPipe.txt`. Documentation: https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker
- OpenCV capture API: https://docs.opencv.org/4.x/d8/dfe/classcv_1_1VideoCapture.html
- Project design inputs: Smart Waste Monitoring presentation and technical design document. The shipped test scene is generated for this application.
