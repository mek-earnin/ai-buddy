use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::settings;

const ACCESSIBILITY_PANE: &str =
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

/// Build the menu-bar tray icon with its menu and event handler.
pub fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show AI Buddy", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let settings_item = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
    let permissions =
        MenuItem::with_id(app, "permissions", "Permissions Help", true, None::<&str>)?;
    let logs = MenuItem::with_id(app, "logs", "Open Logs", true, None::<&str>)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &show,
            &sep1,
            &settings_item,
            &permissions,
            &logs,
            &sep2,
            &quit,
        ],
    )?;

    // Monochrome menu-bar glyph. `icon_as_template` lets macOS recolor it for
    // light/dark menu bars via its alpha channel (the full-color app icon would
    // just sit there colored and look out of place in the bar).
    let tray_icon = tauri::include_image!("icons/tray-template.png");

    TrayIconBuilder::new()
        .tooltip("AI Buddy")
        .icon(tray_icon)
        .icon_as_template(true)
        .menu(&menu)
        .on_menu_event(|app, event| handle_menu_event(app, event.id.as_ref()))
        .build(app)?;

    Ok(())
}

fn handle_menu_event(app: &AppHandle, id: &str) {
    match id {
        "show" => {
            crate::show_tool_palette(app);
        }
        "settings" => {
            crate::show_settings(app);
        }
        "permissions" => {
            let app_handle = app.clone();
            app.dialog()
                .message(
                    "AI Buddy needs two macOS permissions:\n\n\
                     • Accessibility — to read your selected text and paste results back.\n\
                     • Automation (System Events) — to send the Copy/Paste keystrokes.\n\n\
                     Click OK to open System Settings › Privacy & Security › Accessibility, \
                     then enable AI Buddy.",
                )
                .title("Permissions Help")
                .show(move |_| {
                    if let Err(e) = app_handle
                        .opener()
                        .open_url(ACCESSIBILITY_PANE, None::<&str>)
                    {
                        settings::log(
                            &app_handle,
                            &format!("failed to open accessibility pane: {e}"),
                        );
                    }
                });
        }
        "logs" => match settings::logs_path(app) {
            Ok(path) => {
                let path_str = path.to_string_lossy().to_string();
                if let Err(e) = app.opener().open_path(path_str, None::<&str>) {
                    settings::log(app, &format!("failed to open logs: {e}"));
                }
            }
            Err(e) => settings::log(app, &format!("failed to resolve logs path: {e}")),
        },
        "quit" => {
            app.exit(0);
        }
        _ => {}
    }
}
