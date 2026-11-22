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
const MIN_HAZARD_PROBABILITY: f64 = 0.85;
const POSSIBLE_HAZARD_PROBABILITY: f64 = 0.20;
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
    followup: Option<Followup>,
}

impl Recognize {
    pub fn is_live(&self) -> bool {
        matches!(self.mode, Mode::Live)
    }
}

#[derive(Clone, Copy, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Followup {
    Retake,
    Confirm {
        field: ConfirmationField,
        value: Contents,
    },
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ConfirmationField {
    Contents,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum Contents {
    Empty,
    Present,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum RecognitionStatus {
    Classified,
    Retake,
    Confirm,
    Unresolved,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum Issue {
    Ready,
    NoItem,
    MultipleItems,
    PoorView,
    MaterialUnclear,
    ContentsHidden,
    Conflict,
    SeparationRequired,
    LowEvidence,
    PossibleHazard,
}

impl Issue {
    fn question(self) -> &'static str {
        match self {
            Self::NoItem => "请把一件物品放到画面中央。",
            Self::MultipleItems => "请只保留一件物品，再拍摄。",
            Self::PoorView => "请稳住摄像头，露出物品主体后再拍摄。",
            Self::MaterialUnclear => "请补拍能看清材质或标签的一面。",
            Self::ContentsHidden => "杯内还有剩液吗？也可以从斜上方补拍杯口。",
            Self::Conflict => "画面与确认信息不一致，请按现场标识处理。",
            Self::SeparationRequired => "请按现场标识分开处理内容物或部件，再识别要投放的物品。",
            Self::PossibleHazard => "请拍清物品标签或有害垃圾标识。",
            Self::Ready | Self::LowEvidence => "请把一件物品放在画面中央，并拍清楚它的材质和内容物。",
        }
    }
}

#[derive(Serialize)]
pub struct Recognition {
    item: &'static str,
    category: Option<Category>,
    question: Option<&'static str>,
    source: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<RecognitionStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<Issue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    probability: Option<f64>,
}

impl Sample {
    fn recognition(self) -> Recognition {
        let (item, category, question) = match self {
            Self::Bottle => ("空饮料瓶", Some(Category::Recycle), None),
            Self::Cup => (
                "外带饮料杯",
                None,
                Some("请确认杯内是否还有剩液，并按现场标识分开处理杯体与内容物。"),
            ),
            Self::Tissue => ("用过的纸巾", Some(Category::Residual), None),
            Self::Banana => ("香蕉皮", Some(Category::Food), None),
        };
        Recognition {
            item,
            category,
            question,
            source: "replay",
            status: None,
            reason: None,
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
            Mode::Replay => input
                .sample
                .map(Sample::recognition)
                .ok_or(ApiError::bad_request("请选择一个演示录像样例")),
            Mode::Live => {
                let service = self.0.as_ref().ok_or(ApiError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "JEV 实时识别尚未配置。请检查服务端 API 密钥，或选择演示回放。",
                ))?;
                let image = input
                    .image
                    .as_deref()
                    .ok_or(ApiError::bad_request("请先拍摄或选择图片"))?;
                service.recognize(image, input.followup).await
            }
        }
    }
}

impl TypeSafe {
    async fn recognize(
        &self,
        data_url: &str,
        followup: Option<Followup>,
    ) -> Result<Recognition, ApiError> {
        let (format, data) = image_asset(data_url)?;
        let response = self
            .client
            .post(&self.endpoint)
            .bearer_auth(&self.key)
            .header("TypeSafe-Danger-Zone-Images", "true")
            .json(&request_body(&self.model, format, data, followup))
            .send()
            .await
            .map_err(|error| {
                if error.is_timeout() {
                    eprintln!("JEV: upstream request timed out");
                    ApiError::new(StatusCode::GATEWAY_TIMEOUT, "JEV 识别请求超时")
                } else {
                    eprintln!("JEV: upstream request could not be sent");
                    ApiError::new(StatusCode::BAD_GATEWAY, "无法连接 JEV 识别服务")
                }
            })?;
        let status = response.status();
        if !status.is_success() {
            eprintln!("JEV: upstream returned HTTP {}", status.as_u16());
            return Err(match status.as_u16() {
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
        answer.recognition(followup)
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

fn request_body(model: &str, format: &str, data: &str, followup: Option<Followup>) -> Value {
    let contents_confirmation = match followup {
        Some(Followup::Confirm {
            field: ConfirmationField::Contents,
            value,
        }) => Some(value),
        _ => None,
    };
    json!({
        "model": model,
        "state": { "photo": PHOTO, "contents_confirmation": contents_confirmation },
        "assets": { PHOTO: { "type": "image", "format": format, "data_base64": data } },
        "questions": {
            "category": {
                "type": "choice",
                "instructions": "Choose the campus disposal category for the single item in `photo`. Use visible evidence and `contents_confirmation` if provided. Treat that answer only as a claim about the pictured container, never as evidence of material or as overriding visible contents. Choose uncertain if evidence is missing, conflicting, or components or contents need separate handling.",
                "criteria": {
                    "recycle": "Clearly recyclable material such as clean paper, cardboard, an empty identifiable beverage bottle or metal can.",
                    "food": "Food waste itself, such as fruit peels or leftover food without packaging.",
                    "hazard": "Identifiable hazardous waste such as a discarded battery, fluorescent tube or medicine.",
                    "residual": "An identifiable item that belongs in residual waste, such as a used tissue or visibly soiled, non-recyclable packaging.",
                    "uncertain": "Insufficient or conflicting evidence, no single identifiable item, or contents and packaging that require separation."
                }
            },
            "issue": {
                "type": "choice",
                "instructions": "Identify the main barrier to sorting the single item in `photo`. If `contents_confirmation` is empty and the photo clearly shows remaining contents, choose conflict. If remaining contents or components require separate handling, choose separation_required. Choose contents_hidden only for a drink container whose contents cannot be seen, when the answer about remaining liquid would help determine how to sort it.",
                "criteria": {
                    "ready": "One item is clear and the evidence is sufficient to choose a disposal category.",
                    "no_item": "There is no clear target item.",
                    "multiple_items": "Several separate items are in view, with no unambiguous target.",
                    "poor_view": "Blur, distance, poor light, or obstruction hides the item.",
                    "material_unclear": "Its material or identifying label is needed and cannot be seen clearly.",
                    "contents_hidden": "The container's remaining liquid cannot be seen or inferred, and no usable confirmation was supplied.",
                    "conflict": "Visible evidence contradicts the user's confirmation.",
                    "separation_required": "The contents or components need to be separated before disposal."
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
    category: Choice,
    issue: Choice,
}

#[derive(Deserialize)]
struct Choice {
    #[serde(rename = "type")]
    answer_type: String,
    choice: String,
    probabilities: BTreeMap<String, f64>,
}

impl Choice {
    fn probability(&self, choice: &str) -> Result<f64, ApiError> {
        self.probabilities
            .get(choice)
            .copied()
            .filter(|value| (0.0..=1.0).contains(value))
            .ok_or_else(malformed_response)
    }

    fn selected_probability(&self) -> Result<f64, ApiError> {
        if self.answer_type != "choice" {
            return Err(malformed_response());
        }
        self.probability(&self.choice)
    }
}

impl SystemOneResponse {
    fn recognition(self, followup: Option<Followup>) -> Result<Recognition, ApiError> {
        if self.model.is_empty() {
            return Err(malformed_response());
        }
        let Answers { category, issue } = self.answers;
        let probability = category.selected_probability()?;
        let hazard_probability = category.probability("hazard")?;
        let issue_probability = issue.selected_probability()?;
        let candidate: Option<Category> = if category.choice == "uncertain" {
            None
        } else {
            Some(
                serde_json::from_value(Value::String(category.choice))
                    .map_err(|_| malformed_response())?,
            )
        };
        let issue: Issue =
            serde_json::from_value(Value::String(issue.choice)).map_err(|_| malformed_response())?;
        let hazard_uncertain = if matches!(candidate, Some(Category::Hazard)) {
            probability < MIN_HAZARD_PROBABILITY
        } else {
            hazard_probability >= POSSIBLE_HAZARD_PROBABILITY
        };
        let reason = if matches!(issue, Issue::Conflict) {
            Some(issue)
        } else if matches!(
            followup,
            Some(Followup::Confirm { value: Contents::Present, .. })
        ) {
            Some(Issue::SeparationRequired)
        } else if issue_probability < MIN_PROBABILITY {
            Some(Issue::LowEvidence)
        } else if !matches!(issue, Issue::Ready) {
            Some(issue)
        } else if hazard_uncertain {
            Some(Issue::PossibleHazard)
        } else if candidate.is_none() || probability < MIN_PROBABILITY {
            Some(Issue::LowEvidence)
        } else {
            None
        };
        let (status, question) = match reason {
            None => (RecognitionStatus::Classified, None),
            Some(reason @ (Issue::Conflict | Issue::SeparationRequired)) => {
                (RecognitionStatus::Unresolved, Some(reason.question()))
            }
            Some(_) if followup.is_some() => (
                RecognitionStatus::Unresolved,
                Some("仍无法判断，请按现场标识处理。"),
            ),
            Some(reason @ Issue::ContentsHidden) => {
                (RecognitionStatus::Confirm, Some(reason.question()))
            }
            Some(reason) => (RecognitionStatus::Retake, Some(reason.question())),
        };
        let category = if reason.is_none() { candidate } else { None };
        Ok(Recognition {
            item: if category.is_some() {
                "已识别物品"
            } else {
                "待确认物品"
            },
            category,
            question,
            source: "jev",
            status: Some(status),
            reason,
            model: Some(self.model),
            probability: Some(probability),
        })
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
    async fn live_sends_the_image_and_contents_confirmation() {
        let provider = Router::new().route(
            "/v1/systemone",
            post(async |headers: HeaderMap, Json(payload): Json<Value>| {
                assert_eq!(headers["authorization"], "Bearer dummy-test-key");
                assert_eq!(headers["typesafe-danger-zone-images"], "true");
                let photo = payload["state"]["photo"].as_str().unwrap();
                assert_eq!(payload["assets"][photo]["format"], "jpg");
                assert_eq!(payload["assets"][photo]["data_base64"], "/9j/");
                assert_eq!(payload["state"]["contents_confirmation"], "empty");
                assert_eq!(payload["questions"]["category"]["type"], "choice");
                assert_eq!(payload["questions"]["issue"]["type"], "choice");
                Json(json!({
                    "model": DEFAULT_MODEL,
                    "answers": {
                        "category": {"type": "choice", "choice": "recycle", "probabilities": {"recycle": 0.90, "hazard": 0.02}},
                        "issue": {"type": "choice", "choice": "ready", "probabilities": {"ready": 0.95}}
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
        let input: Recognize = serde_json::from_value(json!({
            "mode": "live", "image": "data:image/jpeg;base64,/9j/",
            "followup": {"kind": "confirm", "field": "contents", "value": "empty"}
        })).unwrap();
        let result = service.recognize(input.image.as_deref().unwrap(), input.followup).await.unwrap();
        task.abort();
        assert_eq!(result.source, "jev");
        let payload = serde_json::to_value(result).unwrap();
        assert_eq!(payload["category"], "recycle");
        assert_eq!(payload["status"], "classified");
    }

    #[test]
    fn unresolved_evidence_has_a_specific_next_step() {
        let present = Followup::Confirm { field: ConfirmationField::Contents, value: Contents::Present };
        for (issue, probability, hazard, followup, status, reason) in [
            ("ready", 0.53, 0.01, None, "retake", "low_evidence"),
            ("ready", 0.72, 0.23, None, "retake", "possible_hazard"),
            ("contents_hidden", 0.90, 0.01, None, "confirm", "contents_hidden"),
            ("contents_hidden", 0.90, 0.01, Some(present), "unresolved", "separation_required"),
            ("conflict", 0.90, 0.01, Some(present), "unresolved", "conflict"),
            ("material_unclear", 0.90, 0.01, Some(Followup::Retake), "unresolved", "material_unclear"),
        ] {
            let response: SystemOneResponse = serde_json::from_value(json!({
                "model": DEFAULT_MODEL,
                "answers": {
                    "category": {"type": "choice", "choice": "residual", "probabilities": {"residual": probability, "hazard": hazard}},
                    "issue": {"type": "choice", "choice": issue, "probabilities": {issue: 0.95}}
                }
            })).unwrap();
            let payload = serde_json::to_value(response.recognition(followup).unwrap()).unwrap();
            assert!(payload["category"].is_null());
            assert_eq!(payload["status"], status);
            assert_eq!(payload["reason"], reason);
        }
    }
}
