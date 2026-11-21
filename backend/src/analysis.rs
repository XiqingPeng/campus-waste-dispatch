use std::{env, time::Duration};

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{ApiError, db::Snapshot};

const DAY_MS: i64 = 86_400_000;
const LONG_WAIT_MINUTES: i64 = 20;
const MINUTE_MS: i64 = 60_000;

#[derive(Deserialize)]
pub struct AnalysisRequest {
    days: u8,
    #[serde(default)]
    lang: Language,
    #[serde(default)]
    scope: Scope,
}

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Scope {
    #[default]
    Sorting,
    Collection,
}

#[derive(Clone, Copy, Default, Deserialize, Serialize)]
enum Language {
    #[default]
    #[serde(rename = "zh-CN")]
    Chinese,
    #[serde(rename = "en")]
    English,
}

impl Language {
    fn choose<T>(self, chinese: T, english: T) -> T {
        match self {
            Self::Chinese => chinese,
            Self::English => english,
        }
    }
}

#[derive(Serialize)]
pub struct Report {
    days: u8,
    lang: Language,
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
    hourly: [usize; 24],
    zones: Vec<ZoneStats>,
}

#[derive(Serialize)]
struct StationStats {
    name: String,
    opened: usize,
    active: usize,
}

#[derive(Default, Serialize)]
struct ZoneStats {
    name: String,
    bin_count: usize,
    events: usize,
}

impl Stats {
    fn from_snapshot(
        snapshot: &Snapshot,
        start: i64,
        now: i64,
        lang: Language,
        scope: Scope,
    ) -> Self {
        let mut stats = Self {
            stations: match scope {
                Scope::Sorting => snapshot
                    .stations
                    .iter()
                    .map(|station| StationStats {
                        name: lang.choose(
                            station.name.to_owned(),
                            format!("Residence Station {}", station.id.to_ascii_uppercase()),
                        ),
                        opened: 0,
                        active: 0,
                    })
                    .collect(),
                Scope::Collection => snapshot
                    .collection_points
                    .iter()
                    .map(|point| StationStats {
                        name: point.name.clone(),
                        opened: 0,
                        active: 0,
                    })
                    .collect(),
            },
            ..Self::default()
        };
        if matches!(scope, Scope::Collection) {
            for point in &snapshot.collection_points {
                if let Some(zone) = stats.zones.iter_mut().find(|zone| zone.name == point.zone) {
                    zone.bin_count += 1;
                } else {
                    stats.zones.push(ZoneStats {
                        name: point.zone.clone(),
                        bin_count: 1,
                        events: 0,
                    });
                }
            }
        }
        let mut elapsed_ms = 0;
        for ticket in snapshot
            .tickets
            .iter()
            .filter(|ticket| (start..=now).contains(&ticket.opened_at))
            .filter(|ticket| ticket.bin_id.starts_with("GZ-") == matches!(scope, Scope::Collection))
        {
            let is_closed = ticket.status == "closed";
            stats.opened += 1;
            stats.hourly[((ticket.opened_at / 3_600_000 + 8).rem_euclid(24)) as usize] += 1;
            let station_index = match scope {
                Scope::Sorting => snapshot
                    .bins
                    .iter()
                    .find(|bin| bin.id == ticket.bin_id)
                    .and_then(|bin| {
                        snapshot
                            .stations
                            .iter()
                            .position(|station| station.id == bin.station_id)
                    }),
                Scope::Collection => snapshot
                    .collection_points
                    .iter()
                    .position(|point| point.bin_id == ticket.bin_id),
            };
            if let Some(point) = snapshot
                .collection_points
                .iter()
                .find(|point| point.bin_id == ticket.bin_id)
            {
                if let Some(zone) = stats.zones.iter_mut().find(|zone| zone.name == point.zone) {
                    zone.events += 1;
                }
            }
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

    fn suggestions(&self, lang: Language) -> Vec<Suggestion> {
        let mut suggestions = Vec::new();
        if self.long_wait > 0 {
            suggestions.push(Suggestion {
                key: "long_wait",
                action: lang
                    .choose(
                        "打开清运工单，优先检查等待最久的站点。",
                        "Review collection tickets and prioritize the longest waits.",
                    )
                    .into(),
                evidence: lang.choose(
                    format!(
                        "{} 张进行中工单已等待至少 {LONG_WAIT_MINUTES} 分钟。",
                        self.long_wait
                    ),
                    format!(
                        "Open tickets waiting at least {LONG_WAIT_MINUTES} minutes: {}.",
                        self.long_wait
                    ),
                ),
            });
        }
        if self.needs_review + self.verify > 0 {
            suggestions.push(Suggestion {
                key: "verify",
                action: lang
                    .choose(
                        "复核已登记清运的桶位，结合设备的新读数确认清运结果。",
                        "Check the reported collections against the latest bin readings.",
                    )
                    .into(),
                evidence: lang.choose(
                    format!(
                        "{} 张工单等待设备确认，{} 张工单在确认后仍报满。",
                        self.verify, self.needs_review
                    ),
                    format!(
                        "Awaiting a sensor check: {}. Still full after collection: {}.",
                        self.verify, self.needs_review
                    ),
                ),
            });
        }
        if self.active > 0 && self.long_wait == 0 {
            suggestions.push(Suggestion {
                key: "active",
                action: lang
                    .choose(
                        "查看待清运点位，并跟踪进行中工单是否及时关闭。",
                        "Review the recommended stop and track open tickets until they are closed.",
                    )
                    .into(),
                evidence: lang.choose(
                    format!(
                        "所选时段有 {} 张进行中工单，尚未到达 {LONG_WAIT_MINUTES} 分钟阈值。",
                        self.active
                    ),
                    format!(
                        "Open tickets under the {LONG_WAIT_MINUTES}-minute threshold: {}.",
                        self.active
                    ),
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
                action: lang.choose(
                    format!(
                        "下次巡查时观察{}的满桶频率，收集更多事件后再调整巡检频率。",
                        station.name
                    ),
                    format!(
                        "Check how often bins fill at {} before changing the collection schedule.",
                        station.name
                    ),
                ),
                evidence: lang.choose(
                    format!(
                        "{}在所选时段创建 {} 张工单，为当前监测点位中最多。",
                        station.name, station.opened
                    ),
                    format!(
                        "{} had the most tickets of the monitored locations in this period: {}.",
                        station.name, station.opened
                    ),
                ),
            });
        }
        if suggestions.is_empty() && self.closed > 0 {
            suggestions.push(Suggestion {
                key: "closed",
                action: lang.choose(
                    "保留已关闭工单，累积更多事件后再比较各站点的清运时长。",
                    "Keep the closed tickets and collect more events before comparing station response times.",
                ).into(),
                evidence: lang.choose(
                    format!("所选时段创建的 {} 张工单均已关闭。", self.closed),
                    format!("All tickets opened in this period are closed: {}.", self.closed),
                ),
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

    pub fn credentials(&self) -> Option<crate::model_settings::Credentials> {
        self.0.as_ref().map(|s| crate::model_settings::Credentials {
            api_key: s.key.clone(),
            model: s.model.clone(),
        })
    }

    pub fn configured(
        credentials: Option<crate::model_settings::Credentials>,
    ) -> Result<Self, ApiError> {
        let Some(credentials) = credentials else {
            return Ok(Self::offline());
        };
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(4))
            .timeout(Duration::from_secs(18))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| ApiError::bad_request("无法初始化模型连接。"))?;
        Ok(Self(Some(DeepSeek {
            client,
            key: credentials.api_key,
            model: credentials.model,
            endpoint: "https://api.deepseek.com/chat/completions".into(),
        })))
    }

    pub async fn test_connection(&self) -> Result<(), ApiError> {
        let service = self
            .0
            .as_ref()
            .ok_or_else(|| ApiError::bad_request("请先填写 DeepSeek API Key。"))?;
        let response = service.client.post(&service.endpoint).bearer_auth(&service.key)
            .json(&json!({"model":service.model,"messages":[{"role":"user","content":"Return JSON: {\"ok\":true}"}],"response_format":{"type":"json_object"},"thinking":{"type":"disabled"},"max_tokens":32,"stream":false}))
            .send().await.map_err(|_| ApiError::bad_request("连接 DeepSeek 失败或超时，请稍后重试。"))?;
        if !response.status().is_success() {
            let message = match response.status().as_u16() {
                401 | 403 => "DeepSeek 拒绝访问，请检查 API Key 和模型权限。",
                402 | 429 => "DeepSeek 余额不足或请求受限，请检查账户额度。",
                400 | 404 | 422 => "DeepSeek 不支持此模型或请求格式，请检查模型名称。",
                _ => "DeepSeek 服务暂不可用，请稍后重试。",
            };
            return Err(ApiError::bad_request(message));
        }
        let completion = response
            .json::<Completion>()
            .await
            .map_err(|_| ApiError::bad_request("DeepSeek 返回格式异常，未通过连接测试。"))?;
        let valid = completion
            .choices
            .first()
            .and_then(|c| c.message.content.as_ref())
            .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
            .is_some_and(|v| v["ok"] == true);
        if !valid {
            return Err(ApiError::bad_request(
                "DeepSeek 未返回有效测试结果，请检查模型名称。",
            ));
        }
        Ok(())
    }

    pub const fn offline() -> Self {
        Self(None)
    }

    pub async fn report(
        &self,
        snapshot: Snapshot,
        request: AnalysisRequest,
        now: i64,
        request_deepseek: bool,
    ) -> Result<Report, ApiError> {
        let AnalysisRequest { days, lang, scope } = request;
        if !matches!(days, 7 | 28) {
            return Err(ApiError::bad_request("仅支持近 7 天或近 28 天"));
        }
        let start = now - i64::from(days) * DAY_MS;
        let stats = Stats::from_snapshot(&snapshot, start, now, lang, scope);
        let suggestions = stats.suggestions(lang);
        let mut report = Report {
            days,
            lang,
            start_at: start,
            generated_at: now,
            stats,
            source: "rules",
            model: None,
            note: None,
            suggestions,
        };
        if report.stats.opened == 0 {
            report.note = Some(lang.choose(
                "所选时段暂无工单。设备上报满桶后，统计会自动更新。",
                "No tickets in this period. The report updates when a sensor reports a full bin.",
            ));
            return Ok(report);
        }
        let Some(service) = &self.0 else {
            report.note = Some(lang.choose(
                "DeepSeek 密钥尚未配置，建议由本地规则生成。",
                "Configure a DeepSeek API key to generate model recommendations.",
            ));
            return Ok(report);
        };
        if !request_deepseek {
            report.note = Some(lang.choose(
                "点击「生成分析」可使用 DeepSeek 生成建议。",
                "Select Generate Analysis to request DeepSeek recommendations.",
            ));
            return Ok(report);
        }
        if let Some((model, actions)) = service.actions(&report).await {
            for (suggestion, action) in report.suggestions.iter_mut().zip(actions) {
                suggestion.action = action;
            }
            report.source = "deepseek";
            report.model = Some(model);
        } else {
            report.note = Some(lang.choose(
                "DeepSeek 暂不可用或未返回有效分析，已生成本地规则建议。",
                "DeepSeek is unavailable or returned an invalid report. Local recommendations are shown.",
            ));
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
        let response_language = report.lang.choose("Simplified Chinese", "English");
        let example_key = report.suggestions.first()?.key;
        let instructions = format!(
            "Use the simulated campus waste ticket aggregates and evidence to write one actionable recommendation in {response_language} for each evidence key. Copy every evidence key exactly once. Keep actions under 80 Chinese characters or 170 English characters. Do not invent numbers, peak periods, real occupancy, or equipment fault causes. Return JSON in this shape: {{\"suggestions\":[{{\"key\":\"{example_key}\",\"action\":\"<recommendation>\"}}]}}."
        );
        let payload = json!({
            "model": self.model,
            "messages": [
                {
                    "role": "system",
                    "content": instructions,
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
            .inspect_err(|error| eprintln!("DeepSeek connection failed: {error:#}"))
            .ok()?
            .error_for_status()
            .inspect_err(|error| eprintln!("DeepSeek returned an HTTP error: {error}"))
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
                let limit = report.lang.choose(90, 190);
                (!action.is_empty() && action.chars().count() <= limit).then(|| action.to_owned())
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
                let instructions = payload["messages"][0]["content"].as_str().unwrap();
                assert!(instructions.contains("recommendation in English"));
                assert!(instructions.contains(r#""key":"active""#));
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
                                "suggestions": [{"key": "active", "action": "Check the open collection ticket first."}]
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
        let preview = analysis
            .report(
                store.snapshot().unwrap(),
                AnalysisRequest {
                    days: 7,
                    lang: Language::English,
                    scope: Scope::Sorting,
                },
                now,
                false,
            )
            .await
            .unwrap();
        assert_eq!(preview.source, "rules");
        assert!(preview.model.is_none());
        let response = analysis
            .report(
                snapshot,
                AnalysisRequest {
                    days: 7,
                    lang: Language::English,
                    scope: Scope::Sorting,
                },
                now,
                true,
            )
            .await
            .unwrap();
        assert_eq!(response.source, "deepseek");
        assert_eq!(
            response.suggestions[0].action,
            "Check the open collection ticket first."
        );
        assert!(
            response.suggestions[0]
                .evidence
                .contains("20-minute threshold: 1")
        );
        task.abort();
    }
    #[tokio::test]
    async fn connection_test_checks_completion_and_sanitizes_provider_errors() {
        use axum::{http::StatusCode, response::IntoResponse};
        let app = Router::new().route("/chat/completions", post(|headers: HeaderMap, Json(payload): Json<Value>| async move {
            assert_eq!(payload["max_tokens"], 32);
            assert!(payload["messages"].to_string().contains("ok"));
            assert!(!payload.to_string().contains("stats"));
            if headers["authorization"] == "Bearer rejected-test-key" {
                return (StatusCode::UNAUTHORIZED, Json(json!({"error":"rejected-test-key"}))).into_response();
            }
            Json(json!({"model":"deepseek-flash","choices":[{"finish_reason":"stop","message":{"content":"{\"ok\":true}"}}]})).into_response()
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/chat/completions", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let service = DeepSeek {
            client: reqwest::Client::new(),
            key: "test-key".into(),
            model: "deepseek-flash".into(),
            endpoint,
        };
        Analysis(Some(service.clone()))
            .test_connection()
            .await
            .unwrap();
        let bad = Analysis(Some(DeepSeek {
            key: "rejected-test-key".into(),
            ..service
        }))
        .test_connection()
        .await
        .unwrap_err();
        assert!(!format!("{bad:?}").contains("rejected-test-key"));
        task.abort();
    }
}
