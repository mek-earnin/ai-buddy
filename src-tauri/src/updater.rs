//! In-app updates via GitHub Releases (Tauri updater plugin).
//!
//! Driven entirely from the Rust side so the menu-bar app can check, prompt and
//! install without showing the webview. The update payload is the
//! `.app.tar.gz` artifact emitted by `createUpdaterArtifacts`, verified against
//! the bundled minisign public key (`plugins.updater.pubkey`) before install.
//!
//! Apple code signing and updater signing are independent: Gatekeeper trusts
//! the `.app`'s Apple signature, while the updater trusts the minisign
//! signature. Both must be produced at build time (see `scripts/release.sh`).

use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::settings;

/// Update availability snapshot for the UI badge (camelCase to match the
/// frontend convention used by the other commands).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    /// The currently installed version (e.g. "2.1.1").
    pub current_version: String,
    /// Whether a newer version is available on the update endpoint.
    pub available: bool,
    /// The available version, when `available` is true.
    pub version: Option<String>,
    /// Release notes for the available version, when present.
    pub notes: Option<String>,
}

/// The installed app version, for display in the UI (e.g. the brand header).
#[tauri::command]
pub fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Silently check the update endpoint and report whether a newer version
/// exists. Backs the passive "update available" badge — never shows a dialog.
/// Errors (e.g. no published manifest yet in dev) surface to the caller, which
/// simply hides the badge.
#[tauri::command]
pub async fn fetch_update_status(app: AppHandle) -> Result<UpdateStatus, String> {
    let current_version = app.package_info().version.to_string();
    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await {
        Ok(Some(update)) => Ok(UpdateStatus {
            current_version,
            available: true,
            version: Some(update.version.clone()),
            notes: update.body.clone(),
        }),
        Ok(None) => Ok(UpdateStatus {
            current_version,
            available: false,
            version: None,
            notes: None,
        }),
        Err(e) => Err(e.to_string()),
    }
}

/// Start the interactive update flow (confirm dialog → download → relaunch).
/// Invoked when the user clicks the UI "update" badge.
#[tauri::command]
pub fn install_update(app: AppHandle) {
    check_for_updates(&app, false);
}

/// Check GitHub Releases for a newer version and, if found, offer to install it.
///
/// `silent` controls the no-update / error UX: a background (startup) check
/// stays quiet unless an update is available, while a user-initiated check
/// ("Check for Updates…") always reports the outcome. The whole flow runs on a
/// background task so it never blocks the menu/main thread.
pub fn check_for_updates(app: &AppHandle, silent: bool) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let updater = match app.updater() {
            Ok(updater) => updater,
            Err(e) => {
                report_error(&app, silent, &format!("updater unavailable: {e}"));
                return;
            }
        };

        match updater.check().await {
            Ok(Some(update)) => prompt_and_install(&app, update),
            Ok(None) => {
                if !silent {
                    app.dialog()
                        .message("You're already on the latest version.")
                        .title("AI Buddy")
                        .show(|_| {});
                }
            }
            Err(e) => report_error(&app, silent, &format!("update check failed: {e}")),
        }
    });
}

/// Ask the user to install the available update; on confirmation, download,
/// install and relaunch into the new version.
fn prompt_and_install(app: &AppHandle, update: Update) {
    let version = update.version.clone();
    let notes = update.body.clone().unwrap_or_default();

    let mut message = format!("AI Buddy {version} is available.");
    if !notes.trim().is_empty() {
        message.push_str("\n\n");
        message.push_str(notes.trim());
    }
    message.push_str("\n\nInstall now and restart?");

    let app = app.clone();
    app.dialog()
        .message(message)
        .title("Update available")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Install & Restart".to_string(),
            "Later".to_string(),
        ))
        .show(move |install| {
            if !install {
                return;
            }
            let app = app.clone();
            let version = version.clone();
            tauri::async_runtime::spawn(async move {
                settings::log(&app, &format!("downloading update {version}"));
                match update.download_and_install(|_chunk, _total| {}, || {}).await {
                    Ok(()) => {
                        settings::log(&app, &format!("update {version} installed; restarting"));
                        app.restart();
                    }
                    Err(e) => {
                        report_error(&app, false, &format!("update install failed: {e}"));
                    }
                }
            });
        });
}

/// Log the failure, and surface it to the user unless this was a silent check.
fn report_error(app: &AppHandle, silent: bool, message: &str) {
    settings::log(app, message);
    if !silent {
        app.dialog()
            .message(message)
            .title("Update error")
            .kind(MessageDialogKind::Error)
            .show(|_| {});
    }
}
