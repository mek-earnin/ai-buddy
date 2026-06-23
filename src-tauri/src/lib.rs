mod commands;
mod selection;
mod settings;
mod tray;

use std::str::FromStr;
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// Name of the app that was frontmost when the palette was triggered.
pub struct PrevApp(pub Mutex<String>);

/// The currently registered global shortcut, so we can unregister it on change.
pub struct RegisteredShortcut(pub Mutex<Option<Shortcut>>);

#[derive(Clone, serde::Serialize)]
struct SelectedTextPayload {
    text: String,
    editable: bool,
}

const WIN_W: f64 = 480.0;
const WIN_H: f64 = 600.0;

/// Read the global cursor position (logical points, top-left origin).
fn cursor_location() -> Option<(f64, f64)> {
    use core_graphics::event::CGEvent;
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

    let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState).ok()?;
    let event = CGEvent::new(source).ok()?;
    let point = event.location();
    Some((point.x, point.y))
}

/// Logical bounds (top-left origin, points) of a monitor.
fn monitor_logical_bounds(monitor: &tauri::Monitor) -> (f64, f64, f64, f64) {
    let scale = monitor.scale_factor();
    let pos = monitor.position();
    let size = monitor.size();
    (
        pos.x as f64 / scale,
        pos.y as f64 / scale,
        size.width as f64 / scale,
        size.height as f64 / scale,
    )
}

/// Position the palette window near the cursor, clamped to the monitor the
/// cursor is currently on (not the one the window was last shown on).
fn position_window(window: &tauri::WebviewWindow) {
    let (cx, cy) = match cursor_location() {
        Some(p) => p,
        None => return,
    };

    let mut x = cx - WIN_W / 2.0;
    let mut y = cy + 10.0;

    // Pick the monitor that actually contains the cursor. Falling back to
    // `current_monitor()` (the window's last monitor) would clamp the cursor's
    // coordinates into the wrong screen on multi-monitor setups.
    let monitor = window.available_monitors().ok().and_then(|monitors| {
        monitors.into_iter().find(|m| {
            let (mx, my, mw, mh) = monitor_logical_bounds(m);
            cx >= mx && cx < mx + mw && cy >= my && cy < my + mh
        })
    });

    if let Some(monitor) = monitor {
        let (mon_x, mon_y, mon_w, mon_h) = monitor_logical_bounds(&monitor);
        let max_x = (mon_x + mon_w - WIN_W).max(mon_x);
        let max_y = (mon_y + mon_h - WIN_H).max(mon_y);
        x = x.clamp(mon_x, max_x);
        y = y.clamp(mon_y, max_y);
    }

    let _ = window.set_position(tauri::LogicalPosition::new(x, y));
}

/// Capture the current selection + frontmost target, position and show the
/// palette window, and emit the selected text to the webview.
pub fn show_tool_palette(app: &AppHandle) {
    let (prev_app, editable) = selection::detect_frontmost_target();

    if let Some(state) = app.try_state::<PrevApp>() {
        if let Ok(mut guard) = state.0.lock() {
            *guard = prev_app.clone();
        }
    }

    let text = selection::capture_selection(app);

    if let Some(window) = app.get_webview_window("main") {
        position_window(&window);
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.emit("selected-text", SelectedTextPayload { text, editable });
    }
}

/// Unregister the previously registered global shortcut (if any) and register
/// `accelerator`, wiring it to `show_tool_palette`. The new shortcut is stored
/// in `RegisteredShortcut` state.
pub fn apply_shortcut(app: &AppHandle, accelerator: &str) -> Result<(), String> {
    let global_shortcut = app.global_shortcut();

    // Unregister the previous shortcut.
    {
        let state = app.state::<RegisteredShortcut>();
        let mut guard = state.0.lock().map_err(|e| e.to_string())?;
        if let Some(prev) = guard.take() {
            let _ = global_shortcut.unregister(prev);
        }
    }

    let shortcut = Shortcut::from_str(accelerator)
        .map_err(|e| format!("invalid shortcut '{accelerator}': {e}"))?;

    global_shortcut
        .on_shortcut(shortcut.clone(), |app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                show_tool_palette(app);
            }
        })
        .map_err(|e| format!("failed to register shortcut '{accelerator}': {e}"))?;

    let state = app.state::<RegisteredShortcut>();
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    *guard = Some(shortcut);

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let handle = app.handle().clone();

            // Load settings (JSON + keychain) and seed app state.
            let loaded = settings::load_settings(&handle);
            let shortcut_accel = loaded.global_shortcut.clone();
            app.manage(Mutex::new(loaded));
            app.manage(PrevApp(Mutex::new(String::new())));
            app.manage(RegisteredShortcut(Mutex::new(None)));

            // Hide from the Dock; live only in the menu bar.
            let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            if let Some(window) = app.get_webview_window("main") {
                // Translucent vibrancy background (macOS).
                #[cfg(target_os = "macos")]
                {
                    use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};
                    let _ = apply_vibrancy(
                        &window,
                        NSVisualEffectMaterial::UnderWindowBackground,
                        None,
                        None,
                    );
                }

                // Keep the app alive in the tray when the window is closed.
                let hide_target = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = hide_target.hide();
                    }
                });
            }

            tray::build_tray(&handle)?;

            if let Err(e) = apply_shortcut(&handle, &shortcut_accel) {
                settings::log(&handle, &format!("failed to register global shortcut: {e}"));
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::save_settings,
            commands::paste_result,
            commands::hide_window,
            commands::open_external,
            commands::get_clipboard_text,
            commands::run_local_cli,
            commands::check_local_cli
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
