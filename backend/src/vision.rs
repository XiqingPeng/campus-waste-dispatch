use std::{collections::BTreeMap, env, sync::Arc, time::Duration};

use axum::http::StatusCode;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{ApiError, db::Category};

const ENDPOINT: &str = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_MODEL: &str = "jev-1.14.0";
const PHOTO: &str = "campus-waste-photo";
const MIN_PROBABILITY: f64 = 0.70;
const MAX_IMAGE_BYTES: usize = 1_000_000;

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Mode {
    Replay,
    Live,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Sample {
    Bottle,
    Cup,
    Tissue,
    Banana,
}

#[derive(Deserialize)]
pub struct Recognize {
    mode: Mode,
    image: Option<String>,
    sample: Option<Sample>,
}

impl Recognize {
    pub fn is_live(&self) -> bool {
        matches!(self.mode, Mode::Live)
    }
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum Item {
    BottleClear,
    CupUnknown,
    Tissue,
    Banana,
    Battery,
    Uncertain,
}

#[derive(Serialize)]
pub struct Recognition {
    item: &'static str,
    category: Option<Category>,
    question: Option<&'static str>,
    source: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    probability: Option<f64>,
}

impl Item {
    fn recognition(self, source: &'static str) -> Recognition {
        let (item, category, question) = match self {
            Self::BottleClear => ("空饮料瓶", Some(Category::Recycle), None),
            Self::CupUnknown => (
                "外带饮料杯",
                None,
                Some("请确认杯内是否还有剩液，并按现场标识分开处理杯体与内容物。"),
            ),
            Self::Tissue => ("用过的纸巾", Some(Category::Residual), None),
            Self::Banana => ("香蕉皮", Some(Category::Food), None),
            Self::Battery => ("废电池", Some(Category::Hazard), None),
            Self::Uncertain => (
                "待确认物品",
                None,
                Some("请把一件物品放在画面中央，并拍清楚它的材质和内容物。"),
            ),
        };
        Recognition {
            item,
            category,
            question,
            source,
            model: None,
            probability: None,
        }
    }
}

#[derive(Clone, Default)]
pub struct Vision(Option<Arc<TypeSafe>>);

struct TypeSafe {
    client: reqwest::Client,
    endpoint: String,
    key: String,
    model: String,
}

impl Vision {
    pub fn from_env() -> Result<Self, reqwest::Error> {
        let key = env::var("TYPESAFE_API_KEY").unwrap_or_default();
        let key = key.trim();
        if key.is_empty() {
            return Ok(Self::default());
        }
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(18))
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        Ok(Self(Some(Arc::new(TypeSafe {
            client,
            endpoint: ENDPOINT.to_owned(),
            key: key.to_owned(),
            model: env::var("TYPESAFE_MODEL").unwrap_or_else(|_| DEFAULT_MODEL.to_owned()),
        }))))
    }

    pub fn configured(&self) -> bool {
        self.0.is_some()
    }

    pub async fn recognize(&self, input: Recognize) -> Result<Recognition, ApiError> {
        match input.mode {
            Mode::Replay => {
                let item = match input.sample {
                    Some(Sample::Bottle) => Item::BottleClear,
                    Some(Sample::Cup) => Item::CupUnknown,
                    Some(Sample::Tissue) => Item::Tissue,
                    Some(Sample::Banana) => Item::Banana,
                    None => return Err(ApiError::bad_request("请选择一个演示录像样例")),
                };
                Ok(item.recognition("replay"))
            }
            Mode::Live => {
                let service = self.0.as_ref().ok_or(ApiError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "JEV 实时识别尚未配置。请检查服务端 API 密钥，或选择演示回放。",
                ))?;
                let image = input
                    .image
                    .as_deref()
                    .ok_or(ApiError::bad_request("请先拍摄或选择图片"))?;
                service.recognize(image).await
            }
        }
    }
}

impl TypeSafe {
    async fn recognize(&self, data_url: &str) -> Result<Recognition, ApiError> {
        let (format, data) = image_asset(data_url)?;
        let response = self
            .client
            .post(&self.endpoint)
            .bearer_auth(&self.key)
            .header("TypeSafe-Danger-Zone-Images", "true")
            .json(&request_body(&self.model, format, data))
            .send()
            .await
            .map_err(|error| {
                if error.is_timeout() {
                    ApiError::new(StatusCode::GATEWAY_TIMEOUT, "JEV 识别请求超时")
                } else {
                    ApiError::new(StatusCode::BAD_GATEWAY, "无法连接 JEV 识别服务")
                }
            })?;
        if !response.status().is_success() {
            return Err(match response.status().as_u16() {
                401 | 403 => ApiError::new(
                    StatusCode::BAD_GATEWAY,
                    "JEV 拒绝了服务端鉴权，请检查密钥权限",
                ),
                429 => ApiError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "JEV 请求达到服务限额，请稍后再试",
                ),
                451 => ApiError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "当前运行地区无法访问 JEV 识别服务",
                ),
                _ => ApiError::new(StatusCode::BAD_GATEWAY, "JEV 识别服务返回错误"),
            });
        }
        let answer: SystemOneResponse = response.json().await.map_err(|_| malformed_response())?;
        answer.recognition()
    }
}

fn image_asset(data_url: &str) -> Result<(&'static str, &str), ApiError> {
    let without_prefix = data_url.split_once(',');
    let (format, data) = match without_prefix {
        Some(("data:image/jpeg;base64", data)) => ("jpg", data),
        Some(("data:image/png;base64", data)) => ("png", data),
        _ => return Err(ApiError::bad_request("请使用 JPEG 或 PNG 图片")),
    };
    if data.len() > MAX_IMAGE_BYTES.div_ceil(3) * 4 {
        return Err(ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "图片不得超过 1 MB",
        ));
    }
    let bytes = STANDARD
        .decode(data)
        .map_err(|_| ApiError::bad_request("图片 Base64 编码错误"))?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "图片不得超过 1 MB",
        ));
    }
    let signature: &[u8] = if format == "jpg" {
        b"\xff\xd8\xff"
    } else {
        b"\x89PNG\r\n\x1a\n"
    };
    if !bytes.starts_with(signature) {
        return Err(ApiError::bad_request("实际图片格式与文件标记不符"));
    }
    Ok((format, data))
}

fn request_body(model: &str, format: &str, data: &str) -> Value {
    json!({
        "model": model,
        "state": { "photo": PHOTO },
        "assets": { PHOTO: { "type": "image", "format": format, "data_base64": data } },
        "questions": {
            "item": {
                "type": "choice",
                "instructions": "Identify the single waste item in the center of the photo, using only visible evidence. If it is unclear, out of scope, or there are multiple unseparated items, select uncertain.",
                "criteria": {
                    "bottle_clear": "An empty, recognizable beverage bottle with no visible residue, liquid, or mixed material that needs separating.",
                    "cup_unknown": "A disposable or takeaway drink cup without enough visual evidence to decide what contents remain or how to separate its components.",
                    "tissue": "A used tissue or paper napkin with the appearance of soft tissue.",
                    "banana": "A discarded banana peel.",
                    "battery": "An identifiable discarded household battery.",
                    "uncertain": "No clear match, material or content unclear, multiple objects, obstruction, or an object outside these examples."
                }
            }
        }
    })
}

#[derive(Deserialize)]
struct SystemOneResponse {
    model: String,
    answers: Answers,
}

#[derive(Deserialize)]
struct Answers {
    item: Choice,
}

#[derive(Deserialize)]
struct Choice {
    #[serde(rename = "type")]
    answer_type: String,
    choice: Item,
    probabilities: BTreeMap<String, f64>,
}

impl SystemOneResponse {
    fn recognition(self) -> Result<Recognition, ApiError> {
        let answer = self.answers.item;
        let selected = serde_json::to_value(answer.choice).map_err(|_| malformed_response())?;
        let name = selected.as_str().ok_or_else(malformed_response)?;
        let probability = answer
            .probabilities
            .get(name)
            .copied()
            .filter(|value| (0.0..=1.0).contains(value))
            .ok_or_else(malformed_response)?;
        if answer.answer_type != "choice" || self.model.is_empty() {
            return Err(malformed_response());
        }
        let item = if probability >= MIN_PROBABILITY {
            answer.choice
        } else {
            Item::Uncertain
        };
        let mut result = item.recognition("jev");
        result.model = Some(self.model);
        result.probability = Some(probability);
        Ok(result)
    }
}

fn malformed_response() -> ApiError {
    ApiError::new(
        StatusCode::BAD_GATEWAY,
        "JEV 返回的识别字段不完整或不符合预期",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Json, Router, http::HeaderMap, routing::post};

    #[tokio::test]
    async fn live_uses_uploaded_image_and_typed_provider_response() {
        let provider = Router::new().route(
            "/v1/systemone",
            post(async |headers: HeaderMap, Json(payload): Json<Value>| {
                assert_eq!(headers["authorization"], "Bearer dummy-test-key");
                assert_eq!(headers["typesafe-danger-zone-images"], "true");
                let photo = payload["state"]["photo"].as_str().unwrap();
                assert_eq!(payload["assets"][photo]["format"], "jpg");
                assert_eq!(payload["assets"][photo]["data_base64"], "/9j/");
                assert_eq!(payload["questions"]["item"]["type"], "choice");
                Json(json!({
                    "model": DEFAULT_MODEL,
                    "answers": {
                        "item": {
                            "type": "choice", "choice": "bottle_clear",
                            "confidence": 0.86,
                            "probabilities": {"bottle_clear": 0.90, "uncertain": 0.10}
                        }
                    }
                }))
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, provider).await.unwrap() });
        let service = TypeSafe {
            client: reqwest::Client::new(),
            endpoint: format!("http://{address}/v1/systemone"),
            key: "dummy-test-key".to_owned(),
            model: DEFAULT_MODEL.to_owned(),
        };
        let result = service
            .recognize("data:image/jpeg;base64,/9j/")
            .await
            .unwrap();
        task.abort();
        assert_eq!(result.source, "jev");
        assert_eq!(serde_json::to_value(result).unwrap()["category"], "recycle");
    }

    #[test]
    fn low_probability_requests_confirmation() {
        let response: SystemOneResponse = serde_json::from_value(json!({
            "model": DEFAULT_MODEL,
            "answers": {"item": {"type": "choice", "choice": "battery", "probabilities": {"battery": 0.53}}}
        })).unwrap();
        let result = response.recognition().unwrap();
        assert!(result.category.is_none());
        assert!(result.question.is_some());
    }
}
