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
/// Native window corner radius (matches the CSS `--radius`).
const WINDOW_RADIUS: f64 = 28.0;
/// Native hairline border width (points).
const WINDOW_BORDER_WIDTH: f64 = 1.0;
/// Native hairline border color (white @ low alpha) — subtle macOS-style edge.
const WINDOW_BORDER_RGBA: (f64, f64, f64, f64) = (1.0, 1.0, 1.0, 0.16);

/// Clip the window's content view layer to a rounded rect so the actual macOS
/// window (webview + vibrancy together) has clean native rounded corners.
#[cfg(target_os = "macos")]
fn round_window_corners(window: &tauri::WebviewWindow, radius: f64) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    let Ok(ns_window) = window.ns_window() else {
        return;
    };
    let ns_window = ns_window as *mut AnyObject;
    if ns_window.is_null() {
        return;
    }

    unsafe {
        let content_view: *mut AnyObject = msg_send![ns_window, contentView];
        if content_view.is_null() {
            return;
        }
        let _: () = msg_send![content_view, setWantsLayer: true];
        let layer: *mut AnyObject = msg_send![content_view, layer];
        if layer.is_null() {
            return;
        }
        let _: () = msg_send![layer, setCornerRadius: radius];
        let _: () = msg_send![layer, setMasksToBounds: true];

        // Draw the hairline border on the SAME layer as the mask, so the stroke
        // and the rounded corner share one geometry — gives an even, native edge
        // (CSS borders are clipped unevenly at the corners by the layer mask).
        use core_foundation::base::TCFType;
        let (r, g, b, a) = WINDOW_BORDER_RGBA;
        let border_color = core_graphics::color::CGColor::rgb(r, g, b, a);
        let _: () = msg_send![layer, setBorderWidth: WINDOW_BORDER_WIDTH];
        let _: () = msg_send![
            layer,
            setBorderColor: border_color.as_concrete_TypeRef() as *mut std::ffi::c_void
        ];
    }
}

/// Whether the app is trusted for Accessibility, optionally showing the system
/// prompt that guides the user to System Settings → Privacy & Security →
/// Accessibility and adds the app to the list.
///
/// Accessibility trust is REQUIRED for the selection capture to work at all:
/// reading another app's `AXSelectedText` and synthesizing Cmd+C / Cmd+V via
/// System Events both fail with error 1002 ("not allowed to send keystrokes")
/// without it.
#[cfg(target_os = "macos")]
fn accessibility_trusted(prompt: bool) -> bool {
    use core_foundation::base::TCFType;
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
    use core_foundation::string::{CFString, CFStringRef};

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> bool;
        static kAXTrustedCheckOptionPrompt: CFStringRef;
    }

    unsafe {
        let key = CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt);
        let value = CFBoolean::from(prompt);
        let options =
            CFDictionary::from_CFType_pairs(&[(key.as_CFType(), value.as_CFType())]);
        AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef())
    }
}

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

/// Compute the palette window's target position near the cursor, clamped to
/// the monitor the cursor is currently on (not the one the window was last
/// shown on). Returns logical (x, y) points, or `None` if the cursor can't be
/// read.
fn compute_window_position(window: &tauri::WebviewWindow) -> Option<(f64, f64)> {
    let (cx, cy) = cursor_location()?;

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

    Some((x, y))
}

/// Set the window's top-left corner natively, in one synchronous AppKit call.
///
/// `(x, y)` is the top-left in Quartz global points (origin at the top-left of
/// the primary display, y growing downward) — the same space the cursor is read
/// in. `setFrameTopLeftPoint:` wants the top-left in Cocoa screen coordinates
/// (origin at the bottom-left of the primary display, y growing upward), so we
/// flip Y about the primary display height.
///
/// Going native (vs. tao's `set_position`) matters because the frame change is
/// applied immediately and synchronously: when paired with `show()` in the same
/// main-thread turn, the window is never ordered on screen at its previous frame
/// (e.g. the other monitor it was last shown on) before the move lands. Returns
/// `false` if the native window handle is unavailable so the caller can fall
/// back to `set_position`.
#[cfg(target_os = "macos")]
fn set_frame_top_left(window: &tauri::WebviewWindow, x: f64, y: f64) -> bool {
    use core_graphics::display::CGDisplay;
    use objc2::runtime::AnyObject;
    use objc2::{msg_send, Encode, Encoding};

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct NSPoint {
        x: f64,
        y: f64,
    }
    unsafe impl Encode for NSPoint {
        const ENCODING: Encoding = Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]);
    }

    let Ok(ns_window) = window.ns_window() else {
        return false;
    };
    let ns_window = ns_window as *mut AnyObject;
    if ns_window.is_null() {
        return false;
    }

    let primary_h = CGDisplay::main().bounds().size.height;
    let point = NSPoint {
        x,
        y: primary_h - y,
    };
    unsafe {
        let _: () = msg_send![ns_window, setFrameTopLeftPoint: point];
    }
    true
}

/// Position (if a target is known), show and focus the palette in a single
/// main-thread turn.
///
/// Behaviour depends on whether the window is already on screen:
/// - Already visible: just move it to the new position and refocus. No hide/show
///   cycle, so it warps in place rather than blinking closed/open. (The caller
///   still re-emits `selected-text` so the new selection populates.)
/// - Hidden: set the frame first (while offscreen), then show — so it appears
///   directly at the target instead of presenting at its last frame and warping.
///
/// On macOS the frame is set natively for immediacy; other platforms fall back
/// to tao's `set_position`.
fn position_and_show(window: &tauri::WebviewWindow, position: Option<(f64, f64)>) {
    let already_visible = window.is_visible().unwrap_or(false);

    if let Some((x, y)) = position {
        #[cfg(target_os = "macos")]
        {
            if !set_frame_top_left(window, x, y) {
                let _ = window.set_position(tauri::LogicalPosition::new(x, y));
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = window.set_position(tauri::LogicalPosition::new(x, y));
        }
    }

    if !already_visible {
        let _ = window.show();
    }
    let _ = window.set_focus();
}

/// Capture the current selection + frontmost target, then position, show and
/// focus the palette window.
///
/// Ordering matters: `selection::capture` must fully complete before we focus
/// our own window. It fires Cmd+C at the source app and waits for the copy to
/// land; if we stole focus first, the copy would never reach the source app
/// (empty selection) and the focus hand-off would race (breaking keyboard
/// input like Esc). The capture is fast in the common case — it breaks as soon
/// as the copy lands — so this still feels snappy.
pub fn show_tool_palette(app: &AppHandle) {
    let capture = selection::capture(app);

    if let Some(state) = app.try_state::<PrevApp>() {
        if let Ok(mut guard) = state.0.lock() {
            *guard = capture.prev_app;
        }
    }

    if let Some(window) = app.get_webview_window("main") {
        // Compute the position before hopping to the main thread (cursor +
        // monitor reads are thread-safe), then set position, show and focus in
        // a single main-thread turn. Doing these as separate hops off the
        // shortcut thread lets the window paint at its old position for a frame
        // before the move lands, which looks like the window "warping" into
        // place. Batching them avoids that.
        let position = compute_window_position(&window);
        let win = window.clone();
        let text = capture.text;
        let editable = capture.editable;
        let _ = window.run_on_main_thread(move || {
            position_and_show(&win, position);
            let _ = win.emit("selected-text", SelectedTextPayload { text, editable });
        });
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

            // Selection capture (AX reads + synthesized Cmd+C/Cmd+V) needs
            // Accessibility trust. Prompt on launch if we don't have it yet so
            // the app shows up in System Settings → Accessibility.
            #[cfg(target_os = "macos")]
            {
                if !accessibility_trusted(true) {
                    settings::log(
                        &handle,
                        "accessibility not trusted; selection capture is disabled until the app is enabled in System Settings → Privacy & Security → Accessibility",
                    );
                }
            }

            if let Some(window) = app.get_webview_window("main") {
                // Translucent vibrancy background (macOS).
                #[cfg(target_os = "macos")]
                {
                    use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};
                    // Round the native vibrancy layer so the actual window has
                    // rounded corners (matches the CSS `--radius`). Without this
                    // the blur view stays square and pokes out behind the UI.
                    let _ = apply_vibrancy(
                        &window,
                        NSVisualEffectMaterial::UnderWindowBackground,
                        None,
                        Some(WINDOW_RADIUS),
                    );

                    // Mask the window's content view to the same rounded rect.
                    // The vibrancy radius alone only clips the blur view, leaving
                    // a thin sliver of material peeking past the rounded UI in the
                    // corners. Clipping the content view rounds the webview and the
                    // vibrancy together for clean, native-looking corners.
                    round_window_corners(&window, WINDOW_RADIUS);

                    // Realize the window once, offscreen, so the first
                    // shortcut-driven open lands at the cursor instead of warping.
                    // A freshly-created NSWindow buffers set_position until it's
                    // first ordered on screen — so the very first open would flash
                    // at the default (center) frame for a frame before the move
                    // lands. Ordering it on/off screen here (far offscreen, never
                    // presented) pays that one-time realization cost while hidden,
                    // so every real open positions synchronously.
                    let _ = window.set_position(tauri::LogicalPosition::new(-32000.0, -32000.0));
                    let _ = window.show();
                    let _ = window.hide();
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
