use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

pub const KEYRING_SERVICE: &str = "com.mek-earnin.aibuddy";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TonePrompts {
    pub professional: String,
    pub friendly: String,
    pub direct: String,
}

impl Default for TonePrompts {
    fn default() -> Self {
        Self {
            professional: String::new(),
            friendly: String::new(),
            direct: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub provider: String,
    pub openai_api_key: String,
    pub anthropic_api_key: String,
    pub openai_model: String,
    pub anthropic_model: String,
    pub global_shortcut: String,
    pub auto_paste: bool,
    pub tone_prompts: TonePrompts,
    pub prompt_refiner_prompt: String,
    pub jira_base_url: String,
    pub jira_email: String,
    pub jira_api_token: String,
    pub github_token: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            provider: "openai".to_string(),
            openai_api_key: String::new(),
            anthropic_api_key: String::new(),
            openai_model: "gpt-4o".to_string(),
            anthropic_model: "claude-sonnet-4-20250514".to_string(),
            global_shortcut: "Ctrl+Shift+Space".to_string(),
            auto_paste: false,
            tone_prompts: TonePrompts::default(),
            prompt_refiner_prompt: String::new(),
            jira_base_url: String::new(),
            jira_email: String::new(),
            jira_api_token: String::new(),
            github_token: String::new(),
        }
    }
}

/// Resolve `<app_data_dir>/settings.json`, creating the data dir if needed.
pub fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data dir: {e}"))?;
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| format!("failed to create app data dir: {e}"))?;
    }
    Ok(dir.join("settings.json"))
}

fn read_secret(account: &str) -> String {
    match keyring::Entry::new(KEYRING_SERVICE, account) {
        Ok(entry) => match entry.get_password() {
            Ok(pw) => pw,
            Err(keyring::Error::NoEntry) => String::new(),
            Err(_) => String::new(),
        },
        Err(_) => String::new(),
    }
}

fn write_secret(account: &str, value: &str) {
    let entry = match keyring::Entry::new(KEYRING_SERVICE, account) {
        Ok(e) => e,
        Err(_) => return,
    };
    if value.is_empty() {
        // Best-effort delete; ignore missing entries.
        let _ = entry.delete_credential();
    } else {
        let _ = entry.set_password(value);
    }
}

/// Load settings: read the JSON file (or defaults) then hydrate every secret
/// field from the macOS Keychain (empty string when not found).
pub fn load_settings(app: &AppHandle) -> AppSettings {
    let mut settings = match settings_path(app) {
        Ok(path) => match fs::read_to_string(&path) {
            Ok(contents) => serde_json::from_str::<AppSettings>(&contents).unwrap_or_default(),
            Err(_) => AppSettings::default(),
        },
        Err(_) => AppSettings::default(),
    };

    settings.openai_api_key = read_secret("openaiApiKey");
    settings.anthropic_api_key = read_secret("anthropicApiKey");
    settings.jira_api_token = read_secret("jiraApiToken");
    settings.github_token = read_secret("githubToken");

    settings
}

/// Persist settings: write secrets to the Keychain (deleting empty ones) and
/// write the non-secret fields to JSON with the secret fields blanked out.
pub fn save_settings(app: &AppHandle, settings: &AppSettings) -> Result<(), String> {
    write_secret("openaiApiKey", &settings.openai_api_key);
    write_secret("anthropicApiKey", &settings.anthropic_api_key);
    write_secret("jiraApiToken", &settings.jira_api_token);
    write_secret("githubToken", &settings.github_token);

    let mut to_store = settings.clone();
    to_store.openai_api_key = String::new();
    to_store.anthropic_api_key = String::new();
    to_store.jira_api_token = String::new();
    to_store.github_token = String::new();

    let path = settings_path(app)?;
    let json = serde_json::to_string_pretty(&to_store)
        .map_err(|e| format!("failed to serialize settings: {e}"))?;
    fs::write(&path, json).map_err(|e| format!("failed to write settings: {e}"))?;
    Ok(())
}

/// Append a timestamped line to `<app_data_dir>/logs.log`. Never panics.
pub fn log(app: &AppHandle, msg: &str) {
    let dir = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(_) => return,
    };
    if !dir.exists() {
        let _ = fs::create_dir_all(&dir);
    }
    let path = dir.join("logs.log");
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(file, "[{ts}] {msg}");
    }
}

/// Path to the log file (for the tray "Open Logs" action).
pub fn logs_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data dir: {e}"))?;
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| format!("failed to create app data dir: {e}"))?;
    }
    Ok(dir.join("logs.log"))
}
