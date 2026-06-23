use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

use tauri::AppHandle;
use tauri_plugin_clipboard_manager::ClipboardExt;

use crate::settings;

/// AX roles that we treat as an editable focused element.
pub const EDITABLE_AX_ROLES: [&str; 4] =
    ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"];

const SENTINEL: &str = "\u{0}__AIBUDDY_SENTINEL__";

/// Run an AppleScript snippet, returning stdout (trimmed of a trailing newline).
fn run_osascript(script: &str) -> Result<String, String> {
    let output = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|e| format!("failed to spawn osascript: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("osascript failed: {stderr}"));
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .trim_end_matches('\n')
        .to_string())
}

/// Detect the frontmost application name and whether the focused element is
/// editable. Returns ("", true) on any failure.
pub fn detect_frontmost_target() -> (String, bool) {
    let script = r#"tell application "System Events"
  set frontApp to first application process whose frontmost is true
  set appName to name of frontApp
  set elementRole to ""
  try
    set elementRole to value of attribute "AXRole" of (value of attribute "AXFocusedUIElement" of frontApp)
  end try
  return appName & "
" & elementRole
end tell"#;

    match run_osascript(script) {
        Ok(out) => {
            let mut lines = out.split('\n');
            let app_name = lines.next().unwrap_or("").trim().to_string();
            let role = lines.next().unwrap_or("").trim().to_string();
            let editable = if role.is_empty() {
                true
            } else {
                EDITABLE_AX_ROLES.contains(&role.as_str())
            };
            (app_name, editable)
        }
        Err(_) => (String::new(), true),
    }
}

/// Copy the current selection via Cmd+C using a clipboard sentinel to detect
/// whether anything was actually selected. Restores the original clipboard.
/// Returns the selected text, or "" if there was no selection / on error.
pub fn capture_selection(app: &AppHandle) -> String {
    let clipboard = app.clipboard();
    let original = clipboard.read_text().unwrap_or_default();

    if clipboard.write_text(SENTINEL.to_string()).is_err() {
        return String::new();
    }

    let copy_script =
        r#"tell application "System Events" to keystroke "c" using command down"#;
    if run_osascript(copy_script).is_err() {
        let _ = clipboard.write_text(original);
        return String::new();
    }

    // Poll the clipboard for up to ~500ms waiting for the copy to land.
    let deadline = Instant::now() + Duration::from_millis(500);
    let mut captured = String::new();
    loop {
        let current = clipboard.read_text().unwrap_or_default();
        if current != SENTINEL {
            captured = current;
            break;
        }
        if Instant::now() >= deadline {
            break;
        }
        thread::sleep(Duration::from_millis(20));
    }

    // Restore the user's original clipboard contents.
    let _ = clipboard.write_text(original);

    if captured == SENTINEL {
        String::new()
    } else {
        captured
    }
}

/// Write `text` to the clipboard and paste it into `prev_app` via Cmd+V. The
/// caller is expected to have already hidden the AIBuddy window. The previous
/// clipboard contents are restored ~2s later on a background thread.
pub fn paste_result(app: &AppHandle, text: String, prev_app: String) {
    let clipboard = app.clipboard();
    let original = clipboard.read_text().unwrap_or_default();

    if clipboard.write_text(text).is_err() {
        settings::log(app, "paste_result: failed to write text to clipboard");
        return;
    }

    let activate = if prev_app.is_empty() {
        String::new()
    } else {
        format!("tell application \"{prev_app}\" to activate\n")
    };
    let script = format!(
        "{activate}delay 0.5\ntell application \"System Events\" to keystroke \"v\" using command down"
    );

    if let Err(e) = run_osascript(&script) {
        settings::log(app, &format!("paste_result: osascript error: {e}"));
    }

    // Restore the previous clipboard after the paste has had time to land.
    let app_handle = app.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(2));
        let _ = app_handle.clipboard().write_text(original);
    });
}
