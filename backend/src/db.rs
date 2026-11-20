use std::{path::Path, sync::Mutex};

use axum::http::StatusCode;
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};

use crate::ApiError;

const NEAR_TIE_MS: i64 = 60_000;
const DEPOT: (i64, i64) = (14, 80);

#[derive(Clone, Copy, Serialize)]
pub struct Station {
    pub(crate) id: &'static str,
    pub(crate) name: &'static str,
    detail: &'static str,
    x: i64,
    y: i64,
}

impl Station {
    fn point(self) -> (i64, i64) {
        (self.x, self.y)
    }
}

const STATIONS: [Station; 3] = [
    Station {
        id: "a",
        name: "宿舍 A 站",
        detail: "宿舍区主入口",
        x: 21,
        y: 30,
    },
    Station {
        id: "b",
        name: "宿舍 B 站",
        detail: "宿舍区连廊",
        x: 55,
        y: 43,
    },
    Station {
        id: "c",
        name: "宿舍 C 站",
        detail: "宿舍区南侧通道",
        x: 80,
        y: 70,
    },
];

fn station(id: &str) -> Option<Station> {
    STATIONS.into_iter().find(|station| station.id == id)
}

fn distance_squared(a: (i64, i64), b: (i64, i64)) -> i64 {
    (a.0 - b.0).pow(2) + (a.1 - b.1).pow(2)
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Category {
    Recycle,
    Food,
    Residual,
    Hazard,
}

impl Category {
    const ALL: [Self; 4] = [Self::Recycle, Self::Food, Self::Residual, Self::Hazard];

    fn as_str(self) -> &'static str {
        match self {
            Self::Recycle => "recycle",
            Self::Food => "food",
            Self::Residual => "residual",
            Self::Hazard => "hazard",
        }
    }
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BinStatus {
    Available,
    Full,
    Unknown,
}

impl BinStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Available => "available",
            Self::Full => "full",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Deserialize)]
pub struct SensorReport {
    pub event_id: String,
    pub bin_id: String,
    pub status: BinStatus,
    pub observed_at: i64,
}

#[derive(Serialize)]
pub struct Bin {
    pub(crate) id: String,
    pub(crate) station_id: String,
    category: String,
    status: String,
    observed_at: Option<i64>,
}

#[derive(Serialize)]
pub struct Ticket {
    id: i64,
    pub(crate) bin_id: String,
    pub(crate) status: String,
    pub(crate) opened_at: i64,
    pub(crate) closed_at: Option<i64>,
}

#[derive(Serialize)]
pub struct Snapshot {
    pub(crate) bins: Vec<Bin>,
    pub(crate) tickets: Vec<Ticket>,
    pub(crate) stations: [Station; 3],
    recommendation: Option<i64>,
}

#[derive(Deserialize)]
pub struct GuidanceQuery {
    station_id: String,
    category: Category,
}

#[derive(Serialize)]
pub struct Guidance {
    action: &'static str,
    bin_id: Option<String>,
    station_id: Option<String>,
}

pub struct Store(Mutex<Connection>);

impl Store {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let mut connection = Connection::open(path)?;
        connection.execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE IF NOT EXISTS bins (
                 id TEXT PRIMARY KEY,
                 station_id TEXT NOT NULL,
                 category TEXT NOT NULL,
                 status TEXT NOT NULL CHECK(status IN ('available', 'full', 'unknown')),
                 observed_at INTEGER
             );
             CREATE TABLE IF NOT EXISTS tickets (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 bin_id TEXT NOT NULL REFERENCES bins(id),
                 status TEXT NOT NULL CHECK(status IN ('pending', 'awaiting_verify', 'needs_review', 'closed')),
                 opened_at INTEGER NOT NULL,
                 collection_requested_at INTEGER,
                 closed_at INTEGER
             );
             CREATE UNIQUE INDEX IF NOT EXISTS active_ticket_per_bin
                 ON tickets(bin_id) WHERE status != 'closed';
             CREATE TABLE IF NOT EXISTS sensor_events (
                 event_id TEXT PRIMARY KEY,
                 bin_id TEXT NOT NULL REFERENCES bins(id),
                 status TEXT NOT NULL,
                 observed_at INTEGER NOT NULL
             );",
        )?;
        let migration =
            connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let has_closed_at: bool = migration.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('tickets') WHERE name = 'closed_at')",
            [],
            |row| row.get(0),
        )?;
        if !has_closed_at {
            migration.execute("ALTER TABLE tickets ADD COLUMN closed_at INTEGER", [])?;
        }
        migration.commit()?;
        for station in STATIONS {
            for category in Category::ALL {
                let category = category.as_str();
                connection.execute(
                    "INSERT OR IGNORE INTO bins (id, station_id, category, status)
                     VALUES (?1, ?2, ?3, 'available')",
                    params![format!("{}-{category}", station.id), station.id, category],
                )?;
            }
        }
        Ok(Self(Mutex::new(connection)))
    }

    pub fn snapshot(&self) -> Result<Snapshot, ApiError> {
        let mut connection = self.0.lock().map_err(ApiError::store_lock)?;
        let transaction = connection.transaction()?;
        let snapshot = snapshot(&transaction)?;
        transaction.commit()?;
        Ok(snapshot)
    }

    pub fn guidance(&self, query: GuidanceQuery) -> Result<Guidance, ApiError> {
        let origin = station(&query.station_id)
            .ok_or(ApiError::new(StatusCode::NOT_FOUND, "找不到该投放点"))?;
        let snapshot = self.snapshot()?;
        let closest = snapshot
            .bins
            .into_iter()
            .filter(|bin| bin.status == "available" && bin.category == query.category.as_str())
            .filter_map(|bin| station(&bin.station_id).map(|station| (bin, station)))
            .min_by_key(|(bin, station)| {
                (
                    distance_squared(origin.point(), station.point()),
                    bin.id.clone(),
                )
            })
            .map(|(bin, _)| bin);
        Ok(match closest {
            Some(bin) => Guidance {
                action: if bin.station_id == origin.id {
                    "local"
                } else {
                    "redirect"
                },
                bin_id: Some(bin.id),
                station_id: Some(bin.station_id),
            },
            None => Guidance {
                action: "wait",
                bin_id: None,
                station_id: None,
            },
        })
    }

    fn update(
        &self,
        action: impl FnOnce(&Transaction<'_>) -> Result<(), ApiError>,
    ) -> Result<Snapshot, ApiError> {
        let mut connection = self.0.lock().map_err(ApiError::store_lock)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        action(&transaction)?;
        let snapshot = snapshot(&transaction)?;
        transaction.commit()?;
        Ok(snapshot)
    }

    pub fn sensor(&self, event: SensorReport, now: i64) -> Result<Snapshot, ApiError> {
        if event.event_id.is_empty() || event.event_id.len() > 128 {
            return Err(ApiError::bad_request("事件 ID 长度应为 1–128 字节"));
        }
        if event.observed_at <= 0 || event.observed_at > now + 300_000 {
            return Err(ApiError::bad_request("无效的设备时间戳"));
        }
        self.update(|transaction| apply_sensor(transaction, event))
    }

    pub fn collect(&self, id: i64, now: i64) -> Result<Snapshot, ApiError> {
        self.update(|transaction| {
            let status: String = transaction
                .query_row("SELECT status FROM tickets WHERE id = ?1", [id], |row| {
                    row.get(0)
                })
                .optional()?
                .ok_or(ApiError::new(StatusCode::NOT_FOUND, "找不到该工单"))?;
            if matches!(status.as_str(), "pending" | "needs_review") {
                transaction.execute(
                    "UPDATE tickets SET status = 'awaiting_verify', collection_requested_at = ?1
                     WHERE id = ?2",
                    params![now, id],
                )?;
            }
            Ok(())
        })
    }

    pub fn reset(&self) -> Result<Snapshot, ApiError> {
        self.update(|transaction| {
            transaction.execute_batch(
                "DELETE FROM sensor_events;
                 DELETE FROM tickets;
                 UPDATE bins SET status = 'available', observed_at = NULL;",
            )?;
            Ok(())
        })
    }
}

fn apply_sensor(transaction: &Transaction<'_>, event: SensorReport) -> Result<(), ApiError> {
    let previous: Option<i64> = transaction
        .query_row(
            "SELECT observed_at FROM bins WHERE id = ?1",
            [&event.bin_id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or(ApiError::new(StatusCode::NOT_FOUND, "找不到该桶位"))?;
    let status = event.status.as_str();
    let inserted = transaction.execute(
        "INSERT INTO sensor_events (event_id, bin_id, status, observed_at)
         VALUES (?1, ?2, ?3, ?4) ON CONFLICT(event_id) DO NOTHING",
        params![event.event_id, event.bin_id, status, event.observed_at],
    )?;
    if inserted == 0 {
        let same: bool = transaction.query_row(
            "SELECT bin_id = ?2 AND status = ?3 AND observed_at = ?4
             FROM sensor_events WHERE event_id = ?1",
            params![event.event_id, event.bin_id, status, event.observed_at],
            |row| row.get(0),
        )?;
        return if same {
            Ok(())
        } else {
            Err(ApiError::new(
                StatusCode::CONFLICT,
                "同一事件 ID 已用于另一条上报",
            ))
        };
    }
    let collection_requested_at: Option<i64> = transaction.query_row(
        "SELECT MAX(collection_requested_at) FROM tickets WHERE bin_id = ?1 AND status != 'closed'",
        [&event.bin_id],
        |row| row.get(0),
    )?;
    if previous.is_some_and(|time| event.observed_at <= time)
        || collection_requested_at.is_some_and(|time| event.observed_at < time)
    {
        return Ok(());
    }

    transaction.execute(
        "UPDATE bins SET status = ?1, observed_at = ?2 WHERE id = ?3",
        params![status, event.observed_at, event.bin_id],
    )?;
    match event.status {
        BinStatus::Full => {
            transaction.execute(
                "INSERT INTO tickets (bin_id, status, opened_at) VALUES (?1, 'pending', ?2)
                 ON CONFLICT(bin_id) WHERE status != 'closed' DO NOTHING",
                params![event.bin_id, event.observed_at],
            )?;
            transaction.execute(
                "UPDATE tickets SET status = 'needs_review'
                 WHERE bin_id = ?1 AND status = 'awaiting_verify'",
                [&event.bin_id],
            )?;
        }
        BinStatus::Available => {
            transaction.execute(
                "UPDATE tickets SET status = 'closed', closed_at = ?2
                 WHERE bin_id = ?1 AND status != 'closed'",
                params![event.bin_id, event.observed_at],
            )?;
        }
        BinStatus::Unknown => {}
    }
    Ok(())
}

fn snapshot(connection: &Connection) -> rusqlite::Result<Snapshot> {
    let mut statement = connection
        .prepare("SELECT id, station_id, category, status, observed_at FROM bins ORDER BY id")?;
    let bins = statement
        .query_map([], |row| {
            Ok(Bin {
                id: row.get(0)?,
                station_id: row.get(1)?,
                category: row.get(2)?,
                status: row.get(3)?,
                observed_at: row.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut statement = connection.prepare(
        "SELECT id, bin_id, status, opened_at, closed_at FROM tickets ORDER BY opened_at ASC, id ASC",
    )?;
    let tickets = statement
        .query_map([], |row| {
            Ok(Ticket {
                id: row.get(0)?,
                bin_id: row.get(1)?,
                status: row.get(2)?,
                opened_at: row.get(3)?,
                closed_at: row.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let last_stop: Option<String> = connection
        .query_row(
            "SELECT bins.station_id FROM tickets JOIN bins ON bins.id = tickets.bin_id
             WHERE tickets.collection_requested_at IS NOT NULL
             ORDER BY tickets.collection_requested_at DESC, tickets.id DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    let origin = last_stop
        .as_deref()
        .and_then(station)
        .map_or(DEPOT, Station::point);
    let dispatchable = tickets
        .iter()
        .filter(|ticket| matches!(ticket.status.as_str(), "pending" | "needs_review"));
    let recommendation = dispatchable.clone().next().and_then(|oldest| {
        dispatchable
            .take_while(|ticket| ticket.opened_at - oldest.opened_at <= NEAR_TIE_MS)
            .filter_map(|ticket| {
                let bin = bins.iter().find(|bin| bin.id == ticket.bin_id)?;
                let destination = station(&bin.station_id)?;
                Some((
                    distance_squared(origin, destination.point()),
                    ticket.opened_at,
                    ticket.id,
                ))
            })
            .min()
            .map(|(_, _, id)| id)
    });
    Ok(Snapshot {
        bins,
        tickets,
        stations: STATIONS,
        recommendation,
    })
}
