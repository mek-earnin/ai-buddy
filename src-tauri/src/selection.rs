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

/// ASCII Record Separator. Used to delimit the detection script's fields so a
/// selection containing newlines can't be mistaken for a field boundary.
const FIELD_SEP: char = '\u{1e}';

/// Captured selection context: the frontmost app (for paste-back), whether its
/// focused element is editable, and the selected text.
pub struct Capture {
    pub prev_app: String,
    pub editable: bool,
    pub text: String,
}

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

/// Whether an AX role string denotes an editable focused element. Empty role
/// (unknown) is treated as editable so paste-back stays the default.
fn role_is_editable(role: &str) -> bool {
    role.is_empty() || EDITABLE_AX_ROLES.contains(&role)
}

/// Whether any chord modifier (Ctrl/Shift/Cmd/Option) is currently held.
///
/// The global shortcut itself uses modifiers (e.g. Ctrl+Shift+Space). The
/// shortcut fires on key-down, so when we synthesize Cmd+C those shortcut
/// modifiers are usually still physically held — macOS then sees
/// Ctrl+Shift+Cmd+C instead of Cmd+C and copies nothing. We poll this and wait
/// for the keys to come up before firing the copy.
#[cfg(target_os = "macos")]
fn modifier_keys_held() -> bool {
    use core_graphics::event::{CGEvent, CGEventFlags};
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

    let Ok(source) = CGEventSource::new(CGEventSourceStateID::HIDSystemState) else {
        return false;
    };
    let Ok(event) = CGEvent::new(source) else {
        return false;
    };
    event.get_flags().intersects(
        CGEventFlags::CGEventFlagControl
            | CGEventFlags::CGEventFlagShift
            | CGEventFlags::CGEventFlagCommand
            | CGEventFlags::CGEventFlagAlternate,
    )
}

#[cfg(not(target_os = "macos"))]
fn modifier_keys_held() -> bool {
    false
}

/// Block (briefly) until the global-shortcut modifier keys are released, so a
/// synthesized Cmd+C isn't mangled by still-held Ctrl/Shift/etc. Capped so a
/// user who keeps the keys down doesn't hang the capture.
fn wait_for_modifiers_release() {
    let deadline = Instant::now() + Duration::from_millis(300);
    while modifier_keys_held() {
        if Instant::now() >= deadline {
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }
}

/// Read the frontmost app name, the focused element's AX role, and its
/// `AXSelectedText` in a single `osascript` invocation — purely read-only, no
/// keystrokes and no clipboard. Returns `(app_name, role, selected_text)`.
///
/// `AXSelectedText` is the native selection accessor: when the focused app
/// exposes it (most native macOS apps), we get the selection instantly with no
/// Cmd+C, no clipboard clobber and no focus-steal race. Apps that don't expose
/// it (many Chromium/Electron apps) return an empty selection, and the caller
/// falls back to the clipboard path.
fn detect_target_and_selection() -> (String, String, String) {
    // NB: `value of attribute ...` can return AppleScript's `missing value`
    // (e.g. attribute present but unset, or element not text). Concatenating
    // `missing value` into a string throws, which would fail the WHOLE script —
    // so each AX read is guarded and only assigned when it's a real value.
    let script = format!(
        r#"tell application "System Events"
  set frontApp to first application process whose frontmost is true
  set appName to name of frontApp
  set elementRole to ""
  set selText to ""
  try
    set focusedEl to value of attribute "AXFocusedUIElement" of frontApp
    try
      set r to value of attribute "AXRole" of focusedEl
      if r is not missing value then set elementRole to (r as text)
    end try
    try
      set s to value of attribute "AXSelectedText" of focusedEl
      if s is not missing value then set selText to (s as text)
    end try
  end try
  set sep to (ASCII character 30)
  return appName & sep & elementRole & sep & selText
end tell"#
    );

    match run_osascript(&script) {
        Ok(out) => {
            let mut parts = out.splitn(3, FIELD_SEP);
            let app_name = parts.next().unwrap_or("").trim().to_string();
            let role = parts.next().unwrap_or("").trim().to_string();
            // Selection text is taken verbatim (it may contain leading/trailing
            // whitespace that is part of the user's selection).
            let sel_text = parts.next().unwrap_or("").to_string();
            (app_name, role, sel_text)
        }
        Err(_) => (String::new(), String::new(), String::new()),
    }
}

/// Fallback selection capture for apps that don't expose `AXSelectedText`:
/// stage a clipboard sentinel, synthesize Cmd+C at the (still-frontmost) source
/// app, poll for the copy to land, then restore the original clipboard. Returns
/// the copied text, or "" if nothing was copied.
///
/// The caller must NOT focus our own window until this returns — the source app
/// has to stay frontmost while macOS delivers the Cmd+C, or the copy never
/// happens and the focus hand-off races.
fn copy_selection_via_clipboard(app: &AppHandle) -> String {
    let clipboard = app.clipboard();
    let original = clipboard.read_text().unwrap_or_default();

    if clipboard.write_text(SENTINEL.to_string()).is_err() {
        return String::new();
    }

    // Let the shortcut's own modifiers (Ctrl+Shift+…) come up first, otherwise
    // they combine with our Cmd+C and the copy never happens.
    wait_for_modifiers_release();

    let copy_script = r#"tell application "System Events" to keystroke "c" using command down"#;
    if run_osascript(copy_script).is_err() {
        let _ = clipboard.write_text(original);
        return String::new();
    }

    // Poll the clipboard for the copy to land. Breaks early the instant the
    // sentinel is replaced, so a real selection resolves in ~tens of ms.
    let deadline = Instant::now() + Duration::from_millis(400);
    let mut text = String::new();
    loop {
        let current = clipboard.read_text().unwrap_or_default();
        if current != SENTINEL {
            text = current;
            break;
        }
        if Instant::now() >= deadline {
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }

    // Restore the user's original clipboard contents.
    let _ = clipboard.write_text(original);
    text
}

/// Capture the current selection + frontmost target.
///
/// AX-first: try the native `AXSelectedText` accessor (one read-only osascript,
/// no clipboard, no keystroke, no focus race). Only if the app doesn't expose a
/// selection do we fall back to synthesizing Cmd+C through the clipboard.
pub fn capture(app: &AppHandle) -> Capture {
    let (prev_app, role, ax_text) = detect_target_and_selection();
    let editable = role_is_editable(&role);

    let text = if !ax_text.is_empty() {
        ax_text
    } else {
        copy_selection_via_clipboard(app)
    };

    Capture {
        prev_app,
        editable,
        text,
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
