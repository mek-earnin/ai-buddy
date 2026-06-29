use std::io::{BufRead, BufReader, Read};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_opener::OpenerExt;

use crate::selection;
use crate::settings::{self, AppSettings};
use crate::PrevApp;

/// Flatten an error and its full `source()` chain into one readable string.
///
/// The Tauri HTTP plugin surfaces transport failures as reqwest's generic
/// top-level Display ("error sending request for url (...)") and drops the
/// underlying cause. The real reason (DNS failure, TLS/cert error, connection
/// refused, timeout) lives deeper in the source chain, so we walk it here and
/// join the distinct messages — that's what makes the UI error actionable.
fn format_error_chain(err: &dyn std::error::Error) -> String {
    let mut parts: Vec<String> = vec![err.to_string()];
    let mut source = err.source();
    while let Some(cause) = source {
        let msg = cause.to_string();
        // Skip empties and consecutive duplicates (reqwest sometimes repeats).
        if !msg.is_empty() && parts.last().map(|p| p != &msg).unwrap_or(true) {
            parts.push(msg);
        }
        source = cause.source();
    }
    parts.join(": ")
}

/// Result of [`http_probe`]: the HTTP status plus the response body as text.
#[derive(serde::Serialize)]
pub struct HttpProbeResponse {
    pub status: u16,
    pub body: String,
}

/// Perform a one-shot HTTP request used by the Settings "Verify connection"
/// checks, returning the status + body on a completed response, or a detailed
/// error string (full source chain) when the request never completes.
///
/// This exists alongside the `@tauri-apps/plugin-http` fetch because that
/// plugin collapses transport errors to reqwest's generic message; routing the
/// connection checks through here surfaces the actual failure cause instead.
#[tauri::command]
pub async fn http_probe(
    url: String,
    method: Option<String>,
    api_key: Option<String>,
    body: Option<String>,
) -> Result<HttpProbeResponse, String> {
    use tauri_plugin_http::reqwest;

    let client = reqwest::Client::new();
    let method = method.unwrap_or_else(|| "GET".to_string());
    let mut req = match method.to_ascii_uppercase().as_str() {
        "POST" => client.post(&url),
        "PUT" => client.put(&url),
        _ => client.get(&url),
    };

    if let Some(key) = api_key.as_deref() {
        let key = key.trim();
        if !key.is_empty() {
            req = req.bearer_auth(key);
        }
    }

    if let Some(payload) = body {
        req = req
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(payload);
    }

    let res = req
        .send()
        .await
        .map_err(|e| format_error_chain(&e))?;
    let status = res.status().as_u16();
    let body = res.text().await.map_err(|e| format_error_chain(&e))?;
    Ok(HttpProbeResponse { status, body })
}

#[tauri::command]
pub fn get_settings(state: State<'_, Mutex<AppSettings>>) -> Result<AppSettings, String> {
    let guard = state.lock().map_err(|e| e.to_string())?;
    Ok(guard.clone())
}

#[tauri::command]
pub fn save_settings(
    app: AppHandle,
    settings: AppSettings,
    state: State<'_, Mutex<AppSettings>>,
) -> Result<(), String> {
    // Persist to disk + keychain.
    settings::save_settings(&app, &settings)?;

    let new_shortcut = settings.global_shortcut.clone();

    // Update the in-memory cache.
    {
        let mut guard = state.lock().map_err(|e| e.to_string())?;
        *guard = settings;
    }

    // Re-register the global shortcut (unregisters the previous one first).
    crate::apply_shortcut(&app, &new_shortcut)?;

    Ok(())
}

#[tauri::command]
pub fn paste_result(
    app: AppHandle,
    text: String,
    prev_app: State<'_, PrevApp>,
) -> Result<(), String> {
    // Hide the palette window first so focus returns to the previous app.
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }

    let prev = prev_app
        .0
        .lock()
        .map(|g| g.clone())
        .unwrap_or_default();

    selection::paste_result(&app, text, prev);
    Ok(())
}

#[tauri::command]
pub fn hide_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_clipboard_text(app: AppHandle) -> Result<String, String> {
    app.clipboard().read_text().map_err(|e| e.to_string())
}

/// Resolve the PATH as seen by the user's interactive login shell.
///
/// When the app is launched as a GUI bundle (Finder/Dock), it inherits only
/// launchd's minimal PATH. A login-but-non-interactive shell (`-lc`) sources
/// `.zprofile`/`.zlogin` but NOT `.zshrc`, yet most users add tool directories
/// (e.g. `~/.local/bin`, where `cursor-agent` lives) in `.zshrc`. We therefore
/// capture PATH from an interactive login shell (`-ilc`) once and cache it.
///
/// Interactive shells emit startup/shell-integration noise on stdout (e.g.
/// iTerm2 escape sequences), so we bracket `$PATH` with a unique marker and
/// extract only the value between the markers.
fn resolved_shell_path() -> Option<String> {
    static CACHE: OnceLock<Option<String>> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            const MARKER: &str = "__AI_BUDDY_PATH_BOUNDARY__";
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
            let output = Command::new(&shell)
                .arg("-ilc")
                .arg(format!("printf '%s%s%s' '{MARKER}' \"$PATH\" '{MARKER}'"))
                .stdin(Stdio::null())
                .output()
                .ok()?;

            let stdout = String::from_utf8_lossy(&output.stdout);
            let mut parts = stdout.split(MARKER);
            parts.next()?; // leading shell-integration noise, if any
            let path = parts.next()?.trim();
            if path.is_empty() {
                None
            } else {
                Some(path.to_string())
            }
        })
        .clone()
}

/// Verify that the Local CLI command's binary resolves on PATH (used by the
/// Settings connection-status indicator). Runs `command -v <first-token>` in the
/// user's shell so PATH matches what `run_local_cli` will see.
#[tauri::command]
pub async fn check_local_cli(command: String) -> Result<(), String> {
    if command.trim().is_empty() {
        return Err("Command is empty".to_string());
    }

    tauri::async_runtime::spawn_blocking(move || {
        let first = command
            .split_whitespace()
            .next()
            .unwrap_or("")
            .to_string();
        if first.is_empty() {
            return Err("Command is empty".to_string());
        }

        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
        let mut cmd = Command::new(&shell);
        cmd.arg("-lc").arg(format!("command -v {first}"));
        if let Some(path) = resolved_shell_path() {
            cmd.env("PATH", path);
        }
        let output = cmd
            .output()
            .map_err(|e| format!("Failed to run shell: {e}"))?;

        if output.status.success() {
            Ok(())
        } else {
            Err(format!("`{first}` not found on PATH"))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Streaming events emitted by `run_local_cli` over the Tauri Channel.
/// Serializes as `{ "event": "chunk" | "done" | "error", "data": "..." }`.
#[derive(Clone, serde::Serialize)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
pub enum CliEvent {
    Chunk(String),
    Done(String),
    Error(String),
}

/// Run the user's Local CLI command, exposing the prompt through environment
/// variables and streaming stdout back to the webview line-by-line.
///
/// The command runs inside the user's `$SHELL` (`-lc`) so shell expansion of
/// `$AI_BUDDY_FULL_PROMPT` works and user-installed binaries are on PATH.
#[tauri::command]
pub async fn run_local_cli(
    command: String,
    system_prompt: String,
    user_prompt: String,
    full_prompt: String,
    timeout_secs: u64,
    on_chunk: Channel<CliEvent>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_local_cli_blocking(
            command,
            system_prompt,
            user_prompt,
            full_prompt,
            timeout_secs,
            on_chunk,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

fn run_local_cli_blocking(
    command: String,
    system_prompt: String,
    user_prompt: String,
    full_prompt: String,
    timeout_secs: u64,
    on_chunk: Channel<CliEvent>,
) -> Result<(), String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());

    let mut cmd = Command::new(&shell);
    cmd.arg("-lc")
        .arg(&command)
        .env("AI_BUDDY_FULL_PROMPT", &full_prompt)
        .env("AI_BUDDY_SYSTEM_PROMPT", &system_prompt)
        .env("AI_BUDDY_USER_PROMPT", &user_prompt)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Inject the interactive-login PATH so GUI-launched apps can find binaries
    // installed under `~/.local/bin` etc. (kept as a clean non-interactive `-lc`
    // run to avoid shell-integration noise in the streamed stdout).
    if let Some(path) = resolved_shell_path() {
        cmd.env("PATH", path);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| {
            let msg = format!("Failed to start command: {e}");
            let _ = on_chunk.send(CliEvent::Error(msg.clone()));
            msg
        })?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    // Stream stdout lines as they arrive.
    let chunk_channel = on_chunk.clone();
    let stdout_handle = thread::spawn(move || {
        if let Some(out) = stdout {
            let reader = BufReader::new(out);
            for line in reader.lines() {
                match line {
                    Ok(l) => {
                        let _ = chunk_channel.send(CliEvent::Chunk(format!("{l}\n")));
                    }
                    Err(_) => break,
                }
            }
        }
    });

    // Buffer stderr for error reporting.
    let stderr_handle = thread::spawn(move || {
        let mut buf = String::new();
        if let Some(mut err) = stderr {
            let _ = err.read_to_string(&mut buf);
        }
        buf
    });

    // Poll for completion, enforcing the timeout.
    let start = Instant::now();
    let timeout = Duration::from_secs(timeout_secs.max(1));
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if start.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = stdout_handle.join();
                    let _ = stderr_handle.join();
                    let msg = format!("Command timed out after {timeout_secs}s");
                    let _ = on_chunk.send(CliEvent::Error(msg.clone()));
                    return Err(msg);
                }
                thread::sleep(Duration::from_millis(100));
            }
            Err(e) => {
                let msg = format!("Failed while waiting for command: {e}");
                let _ = on_chunk.send(CliEvent::Error(msg.clone()));
                return Err(msg);
            }
        }
    };

    let _ = stdout_handle.join();
    let stderr_text = stderr_handle.join().unwrap_or_default();

    if status.success() {
        let _ = on_chunk.send(CliEvent::Done(String::new()));
        Ok(())
    } else {
        let code = status
            .code()
            .map(|c| c.to_string())
            .unwrap_or_else(|| "signal".to_string());
        let detail = if stderr_text.trim().is_empty() {
            format!("Command exited with status {code}")
        } else {
            stderr_text.trim().to_string()
        };
        let _ = on_chunk.send(CliEvent::Error(detail.clone()));
        Err(detail)
    }
}
