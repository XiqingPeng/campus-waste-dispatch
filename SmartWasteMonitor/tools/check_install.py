"""Verify the bundled official hand model and the camera-free runtime."""
from hashlib import sha256
from pathlib import Path
import struct
import sys

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
MODEL = ROOT / "weights" / "hand_landmarker.task"
DIGEST = "fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1"


def check_model():
    if not MODEL.is_file() or sha256(MODEL.read_bytes()).hexdigest() != DIGEST:
        raise RuntimeError("The bundled model is missing or corrupted. Extract the complete archive again.")


def main():
    if sys.version_info[:2] != (3, 11) or struct.calcsize("P") != 8:
        raise SystemExit("Installation requires 64-bit Python 3.11.")
    import cv2
    import fastapi
    import numpy
    import uvicorn
    from smartwaste.demo import scene
    from smartwaste.vision import HandLandmarks
    check_model()
    detector = HandLandmarks(MODEL)
    try:
        detector.detect(scene(0)[0], 0)
    finally:
        detector.close()
    print(f"Ready: OpenCV {cv2.__version__}, NumPy {numpy.__version__}, "
          f"FastAPI {fastapi.__version__}, Uvicorn {uvicorn.__version__}.")
    print("Camera connection is optional during installation.")


if __name__ == "__main__":
    main()
