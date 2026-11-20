use std::{env, time::Duration};

use axum::{
    Json,
    http::{HeaderMap, HeaderValue, StatusCode, header},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use ring::hmac;
use serde::{Deserialize, Serialize};

use crate::{ApiError, now_ms};

const COOKIE: &str = "campus_loop_session";
const SESSION_AGE: Duration = Duration::from_secs(8 * 60 * 60);
const PROOF: &[u8] = b"campus-loop access code verification";

#[derive(Clone, Default)]
pub struct Access {
    key: Option<hmac::Key>,
    secure: bool,
}

#[derive(Serialize)]
pub struct Status {
    required: bool,
    signed_in: bool,
}

#[derive(Deserialize)]
pub struct Login {
    passcode: String,
}

impl Access {
    pub fn from_env(railway: bool) -> Result<Self, &'static str> {
        match env::var("WASTE_ACCESS_KEY") {
            Ok(passcode) if (32..=256).contains(&passcode.len()) => {
                Ok(Self::configured(&passcode, railway))
            }
            Ok(_) => Err("WASTE_ACCESS_KEY must be a randomly generated code of 32–256 bytes"),
            Err(env::VarError::NotPresent) if !railway => Ok(Self::default()),
            Err(_) => Err("Set WASTE_ACCESS_KEY before exposing this application on Railway"),
        }
    }

    pub fn configured(passcode: &str, secure: bool) -> Self {
        Self {
            key: Some(hmac::Key::new(hmac::HMAC_SHA256, passcode.as_bytes())),
            secure,
        }
    }

    pub fn status(&self, headers: &HeaderMap) -> Json<Status> {
        Json(Status {
            required: self.key.is_some(),
            signed_in: self.permitted(headers),
        })
    }

    pub fn require(&self, headers: &HeaderMap) -> Result<(), ApiError> {
        self.permitted(headers)
            .then_some(())
            .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "请先进行组内登录。"))
    }

    pub fn login(&self, input: Login) -> Result<(HeaderMap, Json<Status>), ApiError> {
        let Some(key) = &self.key else {
            return Ok((HeaderMap::new(), self.status(&HeaderMap::new())));
        };
        let supplied = hmac::Key::new(hmac::HMAC_SHA256, input.passcode.as_bytes());
        let proof = hmac::sign(&supplied, PROOF);
        if hmac::verify(key, PROOF, proof.as_ref()).is_err() {
            return Err(ApiError::new(StatusCode::UNAUTHORIZED, "组内口令不正确。"));
        }

        let expires = (now_ms() / 1000 + SESSION_AGE.as_secs() as i64).to_be_bytes();
        let tag = hmac::sign(key, &expires);
        let mut token = Vec::with_capacity(expires.len() + tag.as_ref().len());
        token.extend_from_slice(&expires);
        token.extend_from_slice(tag.as_ref());
        Ok(self.cookie(&URL_SAFE_NO_PAD.encode(token), SESSION_AGE, true))
    }

    pub fn logout(&self) -> (HeaderMap, Json<Status>) {
        self.cookie("", Duration::ZERO, self.key.is_none())
    }

    fn permitted(&self, headers: &HeaderMap) -> bool {
        let Some(key) = &self.key else { return true };
        let Some(token) = headers
            .get_all(header::COOKIE)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .flat_map(|value| value.split(';'))
            .filter_map(|cookie| cookie.trim().split_once('='))
            .find_map(|(name, value)| (name == COOKIE).then_some(value))
            .and_then(|value| URL_SAFE_NO_PAD.decode(value).ok())
        else {
            return false;
        };
        let Some((expires, tag)) = token.split_first_chunk::<8>() else {
            return false;
        };
        i64::from_be_bytes(*expires) > now_ms() / 1000 && hmac::verify(key, expires, tag).is_ok()
    }

    fn cookie(&self, token: &str, age: Duration, signed_in: bool) -> (HeaderMap, Json<Status>) {
        let value = format!(
            "{COOKIE}={token}; Path=/api; HttpOnly; SameSite=Strict; Max-Age={}{}",
            age.as_secs(),
            if self.secure { "; Secure" } else { "" }
        );
        let mut headers = HeaderMap::new();
        headers.insert(header::SET_COOKIE, HeaderValue::from_str(&value).unwrap());
        (
            headers,
            Json(Status {
                required: self.key.is_some(),
                signed_in,
            }),
        )
    }
}
