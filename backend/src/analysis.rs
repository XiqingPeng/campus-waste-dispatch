use std::{env, time::Duration};

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{ApiError, db::Snapshot};

const DAY_MS: i64 = 86_400_000;
const LONG_WAIT_MINUTES: i64 = 20;
const MINUTE_MS: i64 = 60_000;

#[derive(Deserialize)]
pub struct AnalysisRequest {
    pub days: u8,
}

#[derive(Serialize)]
pub struct Report {
    days: u8,
    start_at: i64,
    generated_at: i64,
    stats: Stats,
    source: &'static str,
    model: Option<String>,
    note: Option<&'static str>,
    suggestions: Vec<Suggestion>,
}

#[derive(Default, Serialize)]
struct Stats {
    opened: usize,
    closed: usize,
    active: usize,
    long_wait: usize,
    verify: usize,
    needs_review: usize,
    timed: usize,
    mean_minutes: Option<f64>,
    stations: Vec<StationStats>,
}

#[derive(Serialize)]
struct StationStats {
    name: &'static str,
    opened: usize,
    active: usize,
}

impl Stats {
    fn from_snapshot(snapshot: &Snapshot, start: i64, now: i64) -> Self {
        let mut stats = Self {
            stations: snapshot
                .stations
                .iter()
                .map(|station| StationStats {
                    name: station.name,
                    opened: 0,
                    active: 0,
                })
                .collect(),
            ..Self::default()
        };
        let mut elapsed_ms = 0;
        for ticket in snapshot
            .tickets
            .iter()
            .filter(|ticket| (start..=now).contains(&ticket.opened_at))
        {
            let is_closed = ticket.status == "closed";
            stats.opened += 1;
            let station_index = snapshot
                .bins
                .iter()
                .find(|bin| bin.id == ticket.bin_id)
                .and_then(|bin| {
                    snapshot
                        .stations
                        .iter()
                        .position(|station| station.id == bin.station_id)
                });
            if let Some(index) = station_index {
                stats.stations[index].opened += 1;
                stats.stations[index].active += usize::from(!is_closed);
            }
            if is_closed {
                stats.closed += 1;
                if let Some(closed_at) = ticket.closed_at {
                    stats.timed += 1;
                    elapsed_ms += closed_at - ticket.opened_at;
                }
            } else {
                stats.active += 1;
                stats.long_wait +=
                    usize::from(now - ticket.opened_at >= LONG_WAIT_MINUTES * MINUTE_MS);
                stats.verify += usize::from(ticket.status == "awaiting_verify");
                stats.needs_review += usize::from(ticket.status == "needs_review");
            }
        }
        if stats.timed > 0 {
            let minutes = elapsed_ms as f64 / stats.timed as f64 / MINUTE_MS as f64;
            stats.mean_minutes = Some((minutes * 10.0).round() / 10.0);
        }
        stats
    }

    fn suggestions(&self) -> Vec<Suggestion> {
        let mut suggestions = Vec::new();
        if self.long_wait > 0 {
            suggestions.push(Suggestion {
                key: "long_wait",
                action: "打开清运工单，优先检查等待最久的站点。".into(),
                evidence: format!(
                    "{} 张进行中工单已等待至少 {LONG_WAIT_MINUTES} 分钟。",
                    self.long_wait
                ),
            });
        }
        if self.needs_review + self.verify > 0 {
            suggestions.push(Suggestion {
                key: "verify",
                action: "复核已登记清运的桶位，结合设备的新读数确认清运结果。".into(),
                evidence: format!(
                    "{} 张工单等待设备确认，{} 张工单在确认后仍报满。",
                    self.verify, self.needs_review
                ),
            });
        }
        if self.active > 0 && self.long_wait == 0 {
            suggestions.push(Suggestion {
                key: "active",
                action: "查看推荐清运站，并跟踪进行中工单是否及时关闭。".into(),
                evidence: format!(
                    "所选时段有 {} 张进行中工单，尚未到达 {LONG_WAIT_MINUTES} 分钟阈值。",
                    self.active
                ),
            });
        }
        if let Some(station) = self.stations.iter().find(|station| {
            station.opened >= 2
                && self
                    .stations
                    .iter()
                    .all(|other| other.name == station.name || other.opened < station.opened)
        }) {
            suggestions.push(Suggestion {
                key: "station",
                action: format!(
                    "下次巡查时观察{}的满桶频率，收集更多事件后再调整巡检频率。",
                    station.name
                ),
                evidence: format!(
                    "{}在所选时段创建 {} 张工单，为三个示范站中最多。",
                    station.name, station.opened
                ),
            });
        }
        if suggestions.is_empty() && self.closed > 0 {
            suggestions.push(Suggestion {
                key: "closed",
                action: "保留已关闭工单，累积更多事件后再比较各站点的清运时长。".into(),
                evidence: format!("所选时段创建的 {} 张工单均已关闭。", self.closed),
            });
        }
        suggestions
    }
}

#[derive(Serialize)]
struct Suggestion {
    #[serde(skip)]
    key: &'static str,
    action: String,
    evidence: String,
}

#[derive(Clone)]
pub struct Analysis(Option<DeepSeek>);

#[derive(Clone)]
struct DeepSeek {
    client: reqwest::Client,
    key: String,
    model: String,
    endpoint: String,
}

impl Analysis {
    pub fn from_env() -> Result<Self, reqwest::Error> {
        let key = env::var("DEEPSEEK_API_KEY").unwrap_or_default();
        if key.trim().is_empty() {
            return Ok(Self::offline());
        }
        Ok(Self(Some(DeepSeek {
            client: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(4))
                .timeout(Duration::from_secs(14))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            key,
            model: env::var("DEEPSEEK_MODEL").unwrap_or_else(|_| "deepseek-flash".into()),
            endpoint: "https://api.deepseek.com/chat/completions".into(),
        })))
    }

    pub const fn offline() -> Self {
        Self(None)
    }

    pub async fn report(&self, snapshot: Snapshot, days: u8, now: i64) -> Result<Report, ApiError> {
        if !matches!(days, 7 | 28) {
            return Err(ApiError::bad_request("仅支持近 7 天或近 28 天"));
        }
        let start = now - i64::from(days) * DAY_MS;
        let stats = Stats::from_snapshot(&snapshot, start, now);
        let suggestions = stats.suggestions();
        let mut report = Report {
            days,
            start_at: start,
            generated_at: now,
            stats,
            source: "rules",
            model: None,
            note: None,
            suggestions,
        };
        if report.stats.opened == 0 {
            report.note = Some("所选时段暂无工单。可以用设备模拟器上报满桶，再生成分析。");
            return Ok(report);
        }
        let Some(service) = &self.0 else {
            report.note = Some("DeepSeek 密钥尚未配置，建议由本地规则生成。");
            return Ok(report);
        };
        if let Some((model, actions)) = service.actions(&report).await {
            for (suggestion, action) in report.suggestions.iter_mut().zip(actions) {
                suggestion.action = action;
            }
            report.source = "deepseek";
            report.model = Some(model);
        } else {
            report.note = Some("DeepSeek 暂不可用或未返回有效分析，已生成本地规则建议。");
        }
        Ok(report)
    }
}

#[derive(Deserialize)]
struct Completion {
    model: String,
    choices: Vec<CompletionChoice>,
}

#[derive(Deserialize)]
struct CompletionChoice {
    finish_reason: String,
    message: CompletionMessage,
}

#[derive(Deserialize)]
struct CompletionMessage {
    content: Option<String>,
}

#[derive(Deserialize)]
struct ProposedActions {
    suggestions: Vec<ProposedAction>,
}

#[derive(Deserialize)]
struct ProposedAction {
    key: String,
    action: String,
}

impl DeepSeek {
    async fn actions(&self, report: &Report) -> Option<(String, Vec<String>)> {
        let evidence: Vec<_> = report
            .suggestions
            .iter()
            .map(|item| json!({ "key": item.key, "evidence": item.evidence }))
            .collect();
        let input = json!({ "days": report.days, "stats": report.stats, "evidence": evidence });
        let payload = json!({
            "model": self.model,
            "messages": [
                {
                    "role": "system",
                    "content": "你是校园垃圾清运课程演示的分析助手。输入是模拟工单的汇总和证据。为每个提供的 key 写一条有依据、可操作的中文建议（80字内）。保留原 key，每个 key 恰好出现一次。只写建议动作，界面会单独展示证据。不要猜测高峰、真实地点人流或设备故障原因，不要编造数字，不执行任何操作。用 json 格式输出，例如 {\"suggestions\":[{\"key\":\"closed\",\"action\":\"保留已关闭工单，积累更多事件再调整巡查频率。\"}]}。",
                },
                { "role": "user", "content": input.to_string() }
            ],
            "response_format": { "type": "json_object" },
            "thinking": { "type": "disabled" },
            "max_tokens": 600,
            "stream": false
        });
        let completion = self
            .client
            .post(&self.endpoint)
            .bearer_auth(&self.key)
            .json(&payload)
            .send()
            .await
            .ok()?
            .error_for_status()
            .ok()?
            .json::<Completion>()
            .await
            .ok()?;
        let choice = completion.choices.first()?;
        if choice.finish_reason != "stop" {
            return None;
        }
        let proposed =
            serde_json::from_str::<ProposedActions>(choice.message.content.as_deref()?).ok()?;
        if proposed.suggestions.len() != report.suggestions.len() {
            return None;
        }
        let actions = report
            .suggestions
            .iter()
            .map(|suggestion| {
                let action = proposed
                    .suggestions
                    .iter()
                    .find(|item| item.key == suggestion.key)?
                    .action
                    .trim();
                (!action.is_empty() && action.chars().count() <= 90).then(|| action.to_owned())
            })
            .collect::<Option<Vec<_>>>()?;
        Some((completion.model, actions))
    }
}

#[cfg(test)]
mod tests {
    use axum::{Json, Router, http::HeaderMap, routing::post};
    use serde_json::Value;

    use super::*;
    use crate::{
        db::{BinStatus, SensorReport, Store},
        now_ms,
    };

    #[tokio::test]
    async fn deepseek_receives_aggregates_and_keeps_server_evidence() {
        let route = post(
            |headers: HeaderMap, Json(payload): Json<Value>| async move {
                assert_eq!(headers["authorization"], "Bearer test-key");
                assert_eq!(payload["response_format"]["type"], "json_object");
                let message = payload["messages"][1]["content"].as_str().unwrap();
                let aggregates: Value = serde_json::from_str(message).unwrap();
                assert_eq!(aggregates["stats"]["opened"], 1);
                assert!(!message.contains("test-sensor-event"));
                assert!(!message.contains("a-recycle"));
                Json(json!({
                    "model": "deepseek-flash",
                    "choices": [{
                        "finish_reason": "stop",
                        "message": {
                            "content": json!({
                                "suggestions": [{"key": "active", "action": "优先巡查当前待清运站点。"}]
                            }).to_string()
                        }
                    }]
                }))
            },
        );
        let app = Router::new().route("/chat/completions", route);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/chat/completions", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let store = Store::open(":memory:".as_ref()).unwrap();
        let now = now_ms();
        let snapshot = store
            .sensor(
                SensorReport {
                    event_id: "test-sensor-event".into(),
                    bin_id: "a-recycle".into(),
                    status: BinStatus::Full,
                    observed_at: now,
                },
                now,
            )
            .unwrap();
        let analysis = Analysis(Some(DeepSeek {
            client: reqwest::Client::new(),
            key: "test-key".into(),
            model: "deepseek-flash".into(),
            endpoint,
        }));
        let response = analysis.report(snapshot, 7, now).await.unwrap();
        assert_eq!(response.source, "deepseek");
        assert_eq!(response.suggestions[0].action, "优先巡查当前待清运站点。");
        assert!(response.suggestions[0].evidence.contains("1 张进行中工单"));
        task.abort();
    }
}
