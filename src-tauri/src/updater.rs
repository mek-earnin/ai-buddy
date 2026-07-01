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

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::settings;

/// Minimum gap between network update checks. Frequent triggers (every window
/// show) within this window reuse the cached status instead of hitting GitHub.
const MIN_CHECK_INTERVAL: Duration = Duration::from_secs(60 * 60);

/// How often the background loop re-checks so long-running sessions still
/// surface new versions without a restart.
const PERIODIC_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

/// Event name the frontend listens on to refresh the "update available" badge.
const UPDATE_STATUS_EVENT: &str = "update-status";

/// Shared, throttled update-check state. Caches the last known status and the
/// time of the last network check so we can serve the badge cheaply and avoid
/// hammering the update endpoint when the palette is opened repeatedly.
#[derive(Default)]
pub struct UpdateState {
    inner: Mutex<UpdateStateInner>,
}

#[derive(Default)]
struct UpdateStateInner {
    /// When the last network check completed (success or error).
    last_check: Option<Instant>,
    /// Last successful status, reused while still fresh.
    cached: Option<UpdateStatus>,
    /// A background check is currently running — dedupes concurrent triggers.
    in_flight: bool,
}

/// Update availability snapshot for the UI badge (camelCase to match the
/// frontend convention used by the other commands).
#[derive(Clone, serde::Serialize)]
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
///
/// Returns the cached status when the last check is still fresh (within
/// `MIN_CHECK_INTERVAL`) so the initial mount and any manual refresh don't
/// re-hit the network needlessly. Errors (e.g. no published manifest yet in
/// dev) surface to the caller, which simply hides the badge.
#[tauri::command]
pub async fn fetch_update_status(app: AppHandle) -> Result<UpdateStatus, String> {
    if let Some(state) = app.try_state::<UpdateState>() {
        if let Ok(guard) = state.inner.lock() {
            if let (Some(last), Some(cached)) = (guard.last_check, guard.cached.as_ref()) {
                if last.elapsed() < MIN_CHECK_INTERVAL {
                    return Ok(cached.clone());
                }
            }
        }
    }
    check_and_cache(&app).await
}

/// Run the network check, update the shared cache, emit `update-status` for the
/// badge, and return the fresh status. `last_check` is stamped on both success
/// and error so a persistently failing endpoint (e.g. dev with no manifest)
/// still throttles rather than retrying on every trigger.
async fn check_and_cache(app: &AppHandle) -> Result<UpdateStatus, String> {
    let current_version = app.package_info().version.to_string();
    let result: Result<UpdateStatus, String> = match app.updater() {
        Ok(updater) => match updater.check().await {
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
        },
        Err(e) => Err(e.to_string()),
    };

    if let Some(state) = app.try_state::<UpdateState>() {
        if let Ok(mut guard) = state.inner.lock() {
            guard.last_check = Some(Instant::now());
            if let Ok(status) = &result {
                guard.cached = Some(status.clone());
            }
        }
    }

    if let Ok(status) = &result {
        let _ = app.emit(UPDATE_STATUS_EVENT, status.clone());
    }

    result
}

/// Trigger a background update check if the cached status is stale, refreshing
/// the badge via the `update-status` event. Cheap no-op when a recent check
/// exists or one is already running, so it's safe to call on every window show
/// without flooding the endpoint.
pub fn maybe_refresh_update_status(app: &AppHandle) {
    let should_check = {
        let Some(state) = app.try_state::<UpdateState>() else {
            return;
        };
        let Ok(mut guard) = state.inner.lock() else {
            return;
        };
        let fresh = guard
            .last_check
            .is_some_and(|t| t.elapsed() < MIN_CHECK_INTERVAL);
        if fresh || guard.in_flight {
            false
        } else {
            guard.in_flight = true;
            true
        }
    };
    if !should_check {
        return;
    }

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = check_and_cache(&app).await;
        if let Some(state) = app.try_state::<UpdateState>() {
            if let Ok(mut guard) = state.inner.lock() {
                guard.in_flight = false;
            }
        }
    });
}

/// Spawn a background loop that silently refreshes the update status every
/// `PERIODIC_INTERVAL`. Uses a parked OS thread (not a runtime timer) so it
/// needs no extra dependency; the actual check runs on the Tauri async runtime.
pub fn spawn_periodic_check(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(PERIODIC_INTERVAL);
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = check_and_cache(&app).await;
        });
    });
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
