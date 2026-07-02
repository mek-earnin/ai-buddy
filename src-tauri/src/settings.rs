use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

// Only referenced by the release-build Keychain path; debug builds use a file store.
#[cfg_attr(debug_assertions, allow(dead_code))]
pub const KEYRING_SERVICE: &str = "com.mek-earnin.aibuddy";

#[derive(Debug, Clone, Serialize, Deserialize)]
// `default` lets older settings.json files (missing the newer tone keys) still
// deserialize: absent fields fall back to TonePrompts::default() instead of
// failing the whole parse and wiping all settings on upgrade.
#[serde(rename_all = "camelCase", default)]
pub struct TonePrompts {
    pub grammar: String,
    pub natural: String,
    pub professional: String,
    pub friendly: String,
    pub direct: String,
}

impl Default for TonePrompts {
    fn default() -> Self {
        Self {
            grammar: String::new(),
            natural: String::new(),
            professional: String::new(),
            friendly: String::new(),
            direct: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    pub provider: String,

    // oMLX (https://github.com/jundot/omlx — OpenAI-compatible, /v1/chat/completions)
    pub omlx_server_url: String,
    pub omlx_model: String,
    pub omlx_api_key: String,

    // Ollama
    pub ollama_server_url: String,
    pub ollama_model: String,

    // OpenAI (api.openai.com — OpenAI-compatible, /v1/chat/completions)
    pub openai_api_key: String,
    pub openai_model: String,

    // Local CLI
    pub local_cli_command: String,
    pub local_cli_timeout_secs: u64,

    // Custom (OpenAI-compatible / oMLX / Ollama-native)
    pub custom_api_endpoint: String,
    pub custom_model: String,
    pub custom_api_key: String,

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
            provider: "omlx".to_string(),
            omlx_server_url: "http://localhost:8000".to_string(),
            omlx_model: String::new(),
            omlx_api_key: String::new(),
            ollama_server_url: "http://localhost:11434".to_string(),
            ollama_model: String::new(),
            openai_api_key: String::new(),
            openai_model: String::new(),
            local_cli_command: String::new(),
            local_cli_timeout_secs: 45,
            custom_api_endpoint: "http://localhost:11434/api/chat".to_string(),
            custom_model: String::new(),
            custom_api_key: String::new(),
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

// --- Secret storage ---------------------------------------------------------
//
// Release builds carry a stable code-signing identity, so the macOS Keychain
// ACL stays satisfied across app updates and never re-prompts. Debug builds get
// a fresh ad-hoc signature on every rebuild, which would make the Keychain
// prompt for a password on every `tauri dev` change. To avoid that, debug
// builds store secrets in a plaintext `dev-secrets.json` in the app data dir
// instead of the Keychain. Acceptable for local dev tokens; never used in
// release.

#[cfg(not(debug_assertions))]
fn read_secret(_app: &AppHandle, account: &str) -> String {
    match keyring::Entry::new(KEYRING_SERVICE, account) {
        Ok(entry) => match entry.get_password() {
            Ok(pw) => pw,
            Err(keyring::Error::NoEntry) => String::new(),
            Err(_) => String::new(),
        },
        Err(_) => String::new(),
    }
}

#[cfg(not(debug_assertions))]
fn write_secret(_app: &AppHandle, account: &str, value: &str) {
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

#[cfg(debug_assertions)]
fn dev_secrets_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    if !dir.exists() {
        let _ = fs::create_dir_all(&dir);
    }
    Some(dir.join("dev-secrets.json"))
}

#[cfg(debug_assertions)]
fn read_secret(app: &AppHandle, account: &str) -> String {
    let Some(path) = dev_secrets_path(app) else {
        return String::new();
    };
    let map: serde_json::Map<String, serde_json::Value> = fs::read_to_string(&path)
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_default();
    map.get(account)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

#[cfg(debug_assertions)]
fn write_secret(app: &AppHandle, account: &str, value: &str) {
    let Some(path) = dev_secrets_path(app) else {
        return;
    };
    let mut map: serde_json::Map<String, serde_json::Value> = fs::read_to_string(&path)
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_default();
    if value.is_empty() {
        map.remove(account);
    } else {
        map.insert(
            account.to_string(),
            serde_json::Value::String(value.to_string()),
        );
    }
    if let Ok(json) = serde_json::to_string_pretty(&map) {
        let _ = fs::write(&path, json);
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

    settings.omlx_api_key = read_secret(app, "omlxApiKey");
    settings.openai_api_key = read_secret(app, "openaiApiKey");
    settings.custom_api_key = read_secret(app, "customApiKey");
    settings.jira_api_token = read_secret(app, "jiraApiToken");
    settings.github_token = read_secret(app, "githubToken");

    settings
}

/// Persist settings: write secrets to the Keychain (deleting empty ones) and
/// write the non-secret fields to JSON with the secret fields blanked out.
pub fn save_settings(app: &AppHandle, settings: &AppSettings) -> Result<(), String> {
    write_secret(app, "omlxApiKey", &settings.omlx_api_key);
    write_secret(app, "openaiApiKey", &settings.openai_api_key);
    write_secret(app, "customApiKey", &settings.custom_api_key);
    write_secret(app, "jiraApiToken", &settings.jira_api_token);
    write_secret(app, "githubToken", &settings.github_token);

    let mut to_store = settings.clone();
    to_store.omlx_api_key = String::new();
    to_store.openai_api_key = String::new();
    to_store.custom_api_key = String::new();
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
