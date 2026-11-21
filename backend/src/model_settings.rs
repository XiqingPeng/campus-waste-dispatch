use crate::ApiError;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

#[derive(Clone, Deserialize, Serialize)]
pub struct Credentials {
    pub api_key: String,
    pub model: String,
}

impl Credentials {
    fn validate(&mut self) -> Result<(), ApiError> {
        self.api_key = self.api_key.trim().to_owned();
        self.model = self.model.trim().to_owned();
        if self.api_key.is_empty()
            || self.api_key.len() > 512
            || !self.api_key.bytes().all(|b| b.is_ascii_graphic())
        {
            return Err(ApiError::bad_request("请填写有效的 DeepSeek API Key。"));
        }
        if self.model.is_empty()
            || self.model.len() > 100
            || !self
                .model
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.:/".contains(&b))
        {
            return Err(ApiError::bad_request("请填写有效的 DeepSeek 模型名称。"));
        }
        Ok(())
    }
}

#[derive(Deserialize)]
pub struct ConfigInput {
    #[serde(default)]
    pub api_key: String,
    pub model: String,
}

#[derive(Serialize)]
pub struct ConfigStatus {
    pub configured: bool,
    pub model: String,
    pub source: &'static str,
}

struct Saved {
    credentials: Option<Credentials>,
    source: &'static str,
}

#[derive(Clone)]
pub struct ModelSettings {
    saved: Arc<Mutex<Saved>>,
    path: Option<PathBuf>,
}

impl ModelSettings {
    pub fn open(database: &Path, initial: Option<Credentials>) -> std::io::Result<Self> {
        let path = (database != Path::new(":memory:"))
            .then(|| database.with_file_name("deepseek-config.json"));
        let mut saved = Saved {
            source: if initial.is_some() {
                "environment"
            } else {
                "none"
            },
            credentials: initial,
        };
        if let Some(path) = &path {
            match fs::read(path) {
                Ok(bytes) => {
                    let mut credentials: Credentials =
                        serde_json::from_slice(&bytes).map_err(|_| {
                            std::io::Error::other("Invalid saved DeepSeek configuration")
                        })?;
                    credentials.validate().map_err(|_| {
                        std::io::Error::other("Invalid saved DeepSeek configuration")
                    })?;
                    saved = Saved {
                        credentials: Some(credentials),
                        source: "saved",
                    };
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                Err(e) => return Err(e),
            }
        }
        Ok(Self {
            saved: Arc::new(Mutex::new(saved)),
            path,
        })
    }

    pub fn credentials(&self) -> Result<Option<Credentials>, ApiError> {
        Ok(self
            .saved
            .lock()
            .map_err(ApiError::store_lock)?
            .credentials
            .clone())
    }

    pub fn status(&self) -> Result<ConfigStatus, ApiError> {
        let saved = self.saved.lock().map_err(ApiError::store_lock)?;
        Ok(ConfigStatus {
            configured: saved.credentials.is_some(),
            model: saved
                .credentials
                .as_ref()
                .map(|c| c.model.clone())
                .unwrap_or_else(|| "deepseek-flash".into()),
            source: saved.source,
        })
    }

    fn candidate(input: ConfigInput, saved: &Saved) -> Result<Credentials, ApiError> {
        let mut credentials = Credentials {
            api_key: if input.api_key.trim().is_empty() {
                saved
                    .credentials
                    .as_ref()
                    .map(|c| c.api_key.clone())
                    .unwrap_or_default()
            } else {
                input.api_key
            },
            model: input.model,
        };
        credentials.validate()?;
        Ok(credentials)
    }

    pub fn draft(&self, input: ConfigInput) -> Result<Credentials, ApiError> {
        Self::candidate(input, &*self.saved.lock().map_err(ApiError::store_lock)?)
    }

    pub fn save(&self, input: ConfigInput) -> Result<ConfigStatus, ApiError> {
        let mut saved = self.saved.lock().map_err(ApiError::store_lock)?;
        let credentials = Self::candidate(input, &saved)?;
        if let Some(path) = &self.path {
            let persist = || -> std::io::Result<()> {
                let temporary = path.with_extension("json.tmp");
                let mut options = fs::OpenOptions::new();
                options.write(true).create(true).truncate(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.mode(0o600);
                }
                let mut file = options.open(&temporary)?;
                file.write_all(&serde_json::to_vec(&credentials)?)?;
                file.sync_all()?;
                fs::rename(temporary, path)?;
                Ok(())
            };
            persist().map_err(|_| {
                ApiError::new(
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    "配置保存失败，请重试。",
                )
            })?;
        }
        saved.credentials = Some(credentials);
        saved.source = "saved";
        drop(saved);
        self.status()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn saves_across_restarts_without_returning_keys() {
        let dir = std::env::temp_dir().join(format!(
            "campus-config-{}-{}",
            std::process::id(),
            crate::now_ms()
        ));
        fs::create_dir_all(&dir).unwrap();
        let database = dir.join("test.sqlite3");
        let config = ModelSettings::open(&database, None).unwrap();
        let status = config
            .save(ConfigInput {
                api_key: "test-secret-key".into(),
                model: "deepseek-flash".into(),
            })
            .unwrap();
        assert!(
            !serde_json::to_string(&status)
                .unwrap()
                .contains("test-secret-key")
        );
        let reopened = ModelSettings::open(&database, None).unwrap();
        reopened
            .save(ConfigInput {
                api_key: String::new(),
                model: "another-model".into(),
            })
            .unwrap();
        assert_eq!(
            reopened.credentials().unwrap().unwrap().api_key,
            "test-secret-key"
        );
        assert_eq!(config.status().unwrap().model, "deepseek-flash");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(dir.join("deepseek-config.json"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn empty_key_requires_an_existing_configuration_and_invalid_updates_preserve_it() {
        let config = ModelSettings::open(Path::new(":memory:"), None).unwrap();
        assert!(
            config
                .save(ConfigInput {
                    api_key: String::new(),
                    model: "deepseek-flash".into()
                })
                .is_err()
        );
        config
            .save(ConfigInput {
                api_key: "test-secret".into(),
                model: "deepseek-flash".into(),
            })
            .unwrap();
        assert!(
            config
                .save(ConfigInput {
                    api_key: "bad\nkey".into(),
                    model: "deepseek-flash".into()
                })
                .is_err()
        );
        assert_eq!(
            config.credentials().unwrap().unwrap().api_key,
            "test-secret"
        );
    }
}
