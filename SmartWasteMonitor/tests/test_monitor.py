import tempfile
import threading
from pathlib import Path
from time import monotonic, sleep
import unittest

from fastapi.testclient import TestClient

from smartwaste.demo import DEMO_DEVICE, DEMO_REGIONS, scene
from smartwaste.service import Monitor, Settings
from smartwaste.store import Store
from smartwaste.vision import (DropDetector, FullnessTracker, Reading,
                               encode_jpg, validate_regions)
from smartwaste.web import create_app


ROOT = Path(__file__).resolve().parent.parent
MODEL = ROOT / "weights" / "hand_landmarker.task"


def wait_until(pred, timeout=5):
    end = monotonic() + timeout
    while monotonic() < end:
        if pred():
            return True
        sleep(0.025)
    return False


class MonitorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = Store(Path(self.temp.name))

    def test_fullness_counts_and_one_task_across_restart(self):
        full = Reading("FULL", "reference")
        unknown = Reading("UNKNOWN", "obstructed")
        normal = Reading("NORMAL", "reference")
        tracker = FullnessTracker(self.store, "cam", "BIN-01")
        for n, r in enumerate((full, full, unknown, full, full)):
            tracker.consume(r, str(n))
        self.assertEqual([], self.store.full_rows())
        tracker.consume(full, "5")
        record, = self.store.full_rows()
        self.assertEqual("3", record["first_seen_at"])
        self.assertEqual("5", record["confirmed_at"])
        tracker = FullnessTracker(Store(self.store.root), "cam", "BIN-01")
        for i in range(6, 11):
            tracker.consume(full, str(i))
        self.assertEqual(1, len(self.store.full_rows()))
        tracker.consume(normal, "11")
        self.assertTrue(self.store.report_cleaned(record["id"]))
        for reading in (normal, unknown, normal, normal):
            tracker.consume(reading, "12")
        self.assertIsNone(self.store.full_rows()[0]["resolved_at"])
        tracker.consume(normal, "13")
        self.assertEqual("completed", self.store.full_rows()[0]["task_status"])
        self.assertEqual("13", self.store.full_rows()[0]["resolved_at"])

    def test_hands_alone_or_motion_alone_do_not_trigger(self):
        motionless = scene(0)[0]
        first = DropDetector(DEMO_REGIONS["mouth"])
        second = DropDetector(DEMO_REGIONS["mouth"])
        for step in range(43):
            t = step / 10
            image, points = scene(t)
            self.assertIsNone(first.feed(motionless, t, str(t), points))
            self.assertIsNone(second.feed(image, t, str(t), []))

    def test_calibration_checks_reference_band_and_rejects_identical_frames(self):
        m = Monitor(self.store, Settings(), MODEL, "demo")
        bad = {**DEMO_REGIONS, "band": [(0.1, 0.1), (0.2, 0.1), (0.2, 0.2)]}
        with self.assertRaises(ValueError):
            validate_regions(bad)
        m._handle_frame(scene(0)[0], 0, DEMO_DEVICE, None, [])
        state = m.snapshot()
        client = TestClient(create_app(m, ROOT / "static", start_worker=False),
                            base_url="http://127.0.0.1")
        auth = {"X-Monitor-Token": client.get("/api/session").json()["token"]}
        current = {"device":state["device"], "epoch":state["reference_epoch"]}
        for ref in ("empty", "full"):
            self.assertEqual(200, client.post("/api/reference/"+ref, json=current, headers=auth).status_code)
        request = {**current, "label":"TEST-01", "regions":DEMO_REGIONS}
        self.assertEqual(400, client.post("/api/calibrate", json=request, headers=auth).status_code)
        m._handle_frame(scene(8)[0], 8, DEMO_DEVICE, None, [])
        self.assertEqual(200, client.post("/api/reference/full", json=current, headers=auth).status_code)
        self.assertEqual(2, client.post("/api/calibrate", json=request, headers=auth).json()["version"])
        m._disconnect("test disconnect")
        self.assertEqual(400, client.post("/api/calibrate", json=request, headers=auth).status_code)

    def test_demo_saves_real_image_files_tasks_review_and_csv(self):
        m = Monitor(self.store, Settings(), MODEL, "demo")
        app = create_app(m, ROOT / "static", start_worker=False)
        with TestClient(app, base_url="http://127.0.0.1") as client:
            auth = {"X-Monitor-Token":client.get("/api/session").json()["token"]}
            self.assertEqual(200, client.get("/").status_code)
            self.assertEqual(404, client.get("/cleaning").status_code)
            for step in range(150):
                t = step / 10
                image, hand = scene(t)
                m._handle_frame(image, t, DEMO_DEVICE, None, hand)
            result = client.get("/api/history").json()
            event, = result["drops"]
            full, = result["fullness"]
            self.assertGreaterEqual(len(event["photos"]), 2)
            photo = client.get(f'/api/photo/{event["id"]}/0.jpg')
            self.assertEqual(200, photo.status_code)
            self.assertTrue(photo.content.startswith(b"\xff\xd8\xff"))
            self.assertEqual(404, client.get(f'/api/photo/{event["id"]}/9.jpg').status_code)
            path = f'/api/review/{event["id"]}'
            review = {"status":"confirmed", "category":"可回收物"}
            self.assertEqual(403, client.post(path, json=review).status_code)
            self.assertEqual(200, client.post(path, json=review, headers=auth).status_code)
            self.assertIn("可回收物", client.get("/api/export/drops.csv").content.decode("utf-8-sig"))
            path = f'/api/fullness/{full["id"]}/cleaned'
            self.assertEqual(200, client.post(path, json={}, headers=auth).status_code)
            for step in range(150, 182):
                t = step / 10
                image, hand = scene(t)
                m._handle_frame(image, t, DEMO_DEVICE, None, hand)
            self.assertEqual("NORMAL", client.get("/api/state").json()["fullness"]["state"])
            status, = client.get("/api/history").json()["fullness"]
            self.assertEqual("completed", status["task_status"])
            self.assertIn("completed", client.get("/api/export/fullness.csv").text)
        with TestClient(app, base_url="http://unexpected.example") as client:
            self.assertEqual(400, client.get("/api/session").status_code)

    def test_hotplug_loop_with_simulated_camera_driver(self):
        m = Monitor(self.store, Settings(), MODEL)
        present = threading.Event()
        releases = []

        class Driver:
            def read(self):
                sleep(0.015)
                return (True, scene(0)[0]) if present.is_set() else (False, None)

            def release(self):
                releases.append(True)

        def probe():
            if present.is_set():
                return Driver(), scene(0)[0], 1, "TEST"
            return None

        m._new_camera = probe
        m.start()
        try:
            self.assertTrue(wait_until(lambda: m.snapshot()["state"] == "WAITING"))
            present.set()
            m.wake.set()
            self.assertTrue(wait_until(lambda: m.snapshot()["state"] == "ONLINE"))
            self.assertEqual(1, m.snapshot()["camera"])
            present.clear()
            self.assertTrue(wait_until(lambda: m.snapshot()["state"] == "WAITING"))
            present.set()
            m.wake.set()
            self.assertTrue(wait_until(lambda: m.snapshot()["state"] == "ONLINE"))
            self.assertGreaterEqual(len(releases), 1)
        finally:
            m.stop()


if __name__ == "__main__":
    unittest.main()
