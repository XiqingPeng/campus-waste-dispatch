import argparse
from contextlib import contextmanager
import os
import logging
from pathlib import Path
import socket
from threading import Thread
from time import sleep
from urllib.request import urlopen
import webbrowser

import cv2
import uvicorn

from smartwaste.service import Monitor, Settings, replay_key
from smartwaste.store import Store
from smartwaste.web import create_app


ROOT = Path(__file__).resolve().parent


@contextmanager
def instance_lock(data_root):
    with (data_root / ".running").open("a+b") as lock:
        if not lock.tell():
            lock.write(b"0")
            lock.flush()
        lock.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as err:
            raise SystemExit("This monitoring mode is already running. Check its window.") from err
        yield


def listen(mode, override):
    base = {"live": 8765, "demo": 8766, "replay": 8767}[mode]
    ports = [override] if override else range(base, base + 15)
    for port in ports:
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
                listener.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            else:
                listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.bind(("127.0.0.1", port))
            listener.listen(128)
            return listener
        except OSError:
            listener.close()
    raise SystemExit("All local ports are occupied. Stop the other copy or use --port.")


def open_browser(url):
    for _ in range(30):
        try:
            with urlopen(url + "/api/state", timeout=0.7) as reply:
                if reply.status == 200:
                    webbrowser.open(url)
                    return
        except OSError:
            sleep(0.15)


def main():
    parser = argparse.ArgumentParser(description="Smart Waste Monitoring")
    mode_args = parser.add_mutually_exclusive_group()
    mode_args.add_argument("--demo", action="store_true", help="synthetic no-camera demonstration")
    mode_args.add_argument("--video", type=Path, help="local video replay, separate test database")
    parser.add_argument("--no-browser", action="store_true", help="start server without opening a browser")
    parser.add_argument("--port", type=int, help="local listen port")
    parser.add_argument("--storage", type=Path, default=ROOT / "data", help="data root")
    args = parser.parse_args()
    if args.video and not args.video.is_file():
        parser.error("The replay file does not exist.")
    if args.port is not None and not 1024 <= args.port <= 65535:
        parser.error("Port must be between 1024 and 65535.")
    mode = "demo" if args.demo else "replay" if args.video else "live"
    prefix = args.storage / mode
    if mode == "replay":
        prefix /= replay_key(args.video)
    store = Store(prefix)
    logging.basicConfig(
        format="%(asctime)s %(levelname)s %(message)s", level=logging.INFO,
        handlers=[logging.StreamHandler(), logging.FileHandler(prefix / "runtime.log", encoding="utf-8")],
    )
    cv2.setLogLevel(2)
    config = Settings.load(ROOT / "config.json")
    monitor = Monitor(store, config, ROOT / "weights" / "hand_landmarker.task", mode, args.video)
    app = create_app(monitor, ROOT / "static")
    with instance_lock(prefix), listen(mode, args.port) as listener:
        port = listener.getsockname()[1]
        url = f"http://127.0.0.1:{port}"
        print(f"Open the local dashboard at {url} (Ctrl+C to stop).", flush=True)
        if not args.no_browser:
            Thread(target=open_browser, args=(url,), daemon=True).start()
        server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port,
                                              access_log=False, log_level="info"))
        server.run(sockets=[listener])


if __name__ == "__main__":
    main()
