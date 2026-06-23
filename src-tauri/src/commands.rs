use std::sync::Mutex;

use tauri::{AppHandle, Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_opener::OpenerExt;

use crate::selection;
use crate::settings::{self, AppSettings};
use crate::PrevApp;

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
