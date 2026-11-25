import csv
import io
import json
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


_SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS calibrations (
    device TEXT PRIMARY KEY, label TEXT NOT NULL, version INTEGER NOT NULL,
    regions TEXT NOT NULL, empty_image BLOB NOT NULL, full_image BLOB NOT NULL,
    saved_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS drops (
    id INTEGER PRIMARY KEY, device TEXT NOT NULL, label TEXT NOT NULL,
    occurred_at TEXT NOT NULL, frame_at TEXT NOT NULL, evidence TEXT NOT NULL,
    photos TEXT NOT NULL, review TEXT NOT NULL DEFAULT 'suspected',
    category TEXT, reviewed_at TEXT
);
CREATE TABLE IF NOT EXISTS fullness (
    id INTEGER PRIMARY KEY, device TEXT NOT NULL, label TEXT NOT NULL,
    first_seen_at TEXT NOT NULL, confirmed_at TEXT NOT NULL,
    cleaning_reported_at TEXT, resolved_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_fullness
ON fullness(device) WHERE resolved_at IS NULL;
CREATE TABLE IF NOT EXISTS cleaning_tasks (
    id INTEGER PRIMARY KEY, full_event INTEGER NOT NULL UNIQUE REFERENCES fullness(id),
    created_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', completed_at TEXT
);
"""


class Store:
    def __init__(self, root: Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.photos = self.root / "photos"
        self.photos.mkdir(exist_ok=True)
        self.database = self.root / "monitoring.sqlite3"
        with self.connect() as conn:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.executescript(_SCHEMA)

    @contextmanager
    def connect(self):
        conn = sqlite3.connect(self.database, timeout=5)
        conn.row_factory = sqlite3.Row
        try:
            conn.execute("PRAGMA foreign_keys=ON")
            with conn:
                yield conn
        finally:
            conn.close()

    def get_setting(self, name):
        with self.connect() as conn:
            row = conn.execute("SELECT value FROM settings WHERE name=?", (name,)).fetchone()
            return row["value"] if row else None

    def set_setting(self, name, value):
        with self.connect() as conn:
            conn.execute("INSERT INTO settings VALUES (?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value",
                         (name, value))

    def get_calibration(self, device):
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM calibrations WHERE device=?", (device,)).fetchone()
            if row is None:
                return None
            return {**dict(row), "regions": json.loads(row["regions"])}

    def save_calibration(self, device, label, regions, empty_image, full_image):
        with self.connect() as conn:
            conn.execute("""
                INSERT INTO calibrations VALUES (?, ?, 1, ?, ?, ?, ?)
                ON CONFLICT(device) DO UPDATE SET
                    label=excluded.label, version=calibrations.version+1,
                    regions=excluded.regions, empty_image=excluded.empty_image,
                    full_image=excluded.full_image, saved_at=excluded.saved_at
                """, (device, label, json.dumps(regions), empty_image, full_image, utc_now()))

    def add_drop(self, device, label, occurred_at, evidence, frames):
        names = []
        try:
            for frame in frames:
                file = self.photos / (uuid.uuid4().hex + ".jpg")
                with file.open("xb") as out:
                    names.append(file.name)
                    out.write(frame.jpeg)
            with self.connect() as conn:
                result = conn.execute("""
                    INSERT INTO drops(device,label,occurred_at,frame_at,evidence,photos)
                    VALUES (?,?,?,?,?,?)
                """, (device, label, occurred_at, frames[0].wall, evidence, json.dumps(names)))
                return result.lastrowid
        except Exception:
            for name in names:
                (self.photos / name).unlink(missing_ok=True)
            raise

    def review(self, event, status, category):
        with self.connect() as conn:
            result = conn.execute(
                "UPDATE drops SET review=?, category=?, reviewed_at=? WHERE id=?",
                (status, category if status == "confirmed" else None, utc_now(), event),
            )
            return result.rowcount == 1

    def photo_file(self, event, ordinal):
        with self.connect() as conn:
            row = conn.execute("SELECT photos FROM drops WHERE id=?", (event,)).fetchone()
        names = json.loads(row["photos"]) if row else []
        if ordinal < 0 or ordinal >= len(names):
            return None
        name = names[ordinal]
        if Path(name).name != name or not name.endswith(".jpg"):
            return None
        path = (self.photos / name).resolve()
        return path if path.parent == self.photos.resolve() and path.is_file() else None

    def active_fullness(self, device):
        with self.connect() as conn:
            row = conn.execute(
                "SELECT * FROM fullness WHERE device=? AND resolved_at IS NULL", (device,),
            ).fetchone()
            return dict(row) if row else None

    def confirm_full(self, device, label, first, confirmed):
        with self.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            active = conn.execute(
                "SELECT id FROM fullness WHERE device=? AND resolved_at IS NULL", (device,),
            ).fetchone()
            if active:
                return active["id"]
            row = conn.execute(
                "INSERT INTO fullness(device,label,first_seen_at,confirmed_at) VALUES (?,?,?,?)",
                (device, label, first, confirmed),
            )
            event = row.lastrowid
            conn.execute("INSERT INTO cleaning_tasks(full_event,created_at) VALUES (?,?)", (event, confirmed))
            return event

    def report_cleaned(self, event):
        with self.connect() as conn:
            row = conn.execute("""
                UPDATE fullness SET cleaning_reported_at=COALESCE(cleaning_reported_at,?)
                WHERE id=? AND resolved_at IS NULL
                """, (utc_now(), event))
            if row.rowcount:
                conn.execute("UPDATE cleaning_tasks SET status='awaiting_verification' WHERE full_event=?", (event,))
            return row.rowcount == 1

    def resolve_full(self, event, timestamp):
        with self.connect() as conn:
            row = conn.execute("""
                UPDATE fullness SET resolved_at=?
                WHERE id=? AND resolved_at IS NULL AND cleaning_reported_at IS NOT NULL
                """, (timestamp, event))
            if row.rowcount:
                conn.execute("""
                    UPDATE cleaning_tasks SET status='completed',completed_at=? WHERE full_event=?
                    """, (timestamp, event))
            return row.rowcount == 1

    def drop_rows(self, limit=40):
        limit_sql = "" if limit is None else " LIMIT ?"
        with self.connect() as conn:
            rows = conn.execute("SELECT * FROM drops ORDER BY id DESC" + limit_sql,
                                () if limit is None else (limit,)).fetchall()
        return [dict(row) | {"photos": json.loads(row["photos"])} for row in rows]

    def full_rows(self, limit=40):
        limit_sql = "" if limit is None else " LIMIT ?"
        with self.connect() as conn:
            rows = conn.execute("""
                SELECT f.*,t.id AS task_id,t.status AS task_status FROM fullness AS f
                JOIN cleaning_tasks AS t ON f.id=t.full_event ORDER BY f.id DESC
                """ + limit_sql, () if limit is None else (limit,)).fetchall()
        return [dict(row) for row in rows]

    def csv(self, kind):
        fields = {
            "drops": ("id", "label", "occurred_at", "frame_at", "review", "category", "evidence", "photos"),
            "fullness": ("id", "label", "first_seen_at", "confirmed_at", "cleaning_reported_at",
                         "resolved_at", "task_id", "task_status"),
        }[kind]
        rows = self.drop_rows(None) if kind == "drops" else self.full_rows(None)
        buffer = io.StringIO()
        writer = csv.DictWriter(buffer, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            if isinstance(row.get("photos"), list):
                row["photos"] = " | ".join(row["photos"])
            # Excel interprets certain leading characters as formulas in CSV.
            writer.writerow({k: "'" + v if isinstance(v, str) and v[:1] in ("=", "+", "-", "@", "\t", "\r") else v
                             for k, v in row.items() if k in fields})
        return buffer.getvalue().encode("utf-8-sig")
