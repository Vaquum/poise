//! The desktop app: Tauri plugins, the tray, the pairing and status window,
//! and the operating-system services the core asks for.

mod commands;
mod notifier;
mod tray;

use std::sync::Arc;

use reqwest::Url;
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};
#[cfg(not(target_os = "macos"))]
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_opener::OpenerExt;

use crate::connection::Timing;
use crate::controller::{Controller, Platform};
use crate::credentials::OsCredentialStore;
use crate::duties::snippets::espanso::Locator;
#[cfg(target_os = "macos")]
use crate::launch_agent::{self, Arrangement, LaunchAgent, Launchctl, Processes, Start};
use crate::platform::{Autostart, Browser};
use crate::status::{Connection, Status};
use commands::StatusView;
use notifier::DesktopNotifier;
use tray::Tray;

/// Passed by the login item, so a start at login stays in the tray.
const AUTOSTART_ARG: &str = "--autostart";
/// What Poise Link's settings folder is named after.
const IDENTIFIER: &str = "com.vaquum.poise.link";
const MAIN_WINDOW: &str = "main";
const STATUS_EVENT: &str = "status";
const MAX_LOG_BYTES: u128 = 2 * 1024 * 1024;
/// How long a copy handing over to launchd keeps running after start at login is turned on.
#[cfg(target_os = "macos")]
const HAND_OVER_DELAY: std::time::Duration = std::time::Duration::from_secs(2);

pub fn run() {
    let autostarted = std::env::args().any(|arg| arg == AUTOSTART_ARG);
    // Before the tray or a window exists: with start at login on, launchd's copy is the one that runs.
    #[cfg(target_os = "macos")]
    let arranged = match arrange(autostarted) {
        Ok(Start::HandedOver) => return,
        Ok(Start::Here) => None,
        Err(error) => Some(error),
    };
    let builder = tauri::Builder::default()
        // Registered first: a second launch only shows the running copy's window.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // A start at login while Poise Link already runs asks for nothing.
            if !args.iter().any(|arg| arg == AUTOSTART_ARG) {
                show_window(app)
            }
        }))
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .max_file_size(MAX_LOG_BYTES)
                .build(),
        );
    // macOS has its own launch agent (crate::launch_agent), which also keeps Poise Link running.
    #[cfg(not(target_os = "macos"))]
    let builder = builder.plugin(tauri_plugin_autostart::init(
        MacosLauncher::LaunchAgent,
        Some(vec![AUTOSTART_ARG]),
    ));
    builder
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::status,
            commands::pair,
            commands::cancel_pairing,
            commands::open_verification,
            commands::open_poise,
        ])
        .on_window_event(|window, event| {
            // Closing the window keeps Poise Link running in the tray.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if let Err(error) = window.hide() {
                    log::error!("could not hide the window: {error}");
                }
            }
        })
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            if let Some(error) = &arranged {
                log::error!(
                    "could not hand Poise Link to launchd, so nothing starts it again if it stops: {error}"
                );
            }
            setup(app, autostarted)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Poise Link could not start")
        .run(|_app, event| {
            // Only Quit (an explicit exit code) ends Poise Link, not closing its window.
            if let RunEvent::ExitRequested {
                code: None, api, ..
            } = event
            {
                api.prevent_exit();
            }
        });
}

fn setup(app: &mut tauri::App, autostarted: bool) -> Result<(), Box<dyn std::error::Error>> {
    // A tray app: no Dock icon.
    #[cfg(target_os = "macos")]
    app.set_activation_policy(tauri::ActivationPolicy::Accessory);

    let identifier = app.config().identifier.clone();
    let config_dir = settings_dir()?;
    let handle = app.handle().clone();
    // A copy the person opened handed over to this one, which launchd started.
    #[cfg(target_os = "macos")]
    let asked_for_window = launch_agent::take_window_request(&config_dir);
    #[cfg(not(target_os = "macos"))]
    let asked_for_window = false;
    let platform = Platform {
        secrets: Box::new(OsCredentialStore::new(&identifier)),
        notifier: Arc::new(DesktopNotifier::new(handle.clone())),
        browser: Arc::new(SystemBrowser(handle.clone())),
        autostart: Arc::new(login_item(&handle)?),
        espanso: Locator::system(),
    };
    let controller = Controller::new(platform, &config_dir, Timing::default())?;
    app.manage(Arc::clone(&controller));

    let tray = Tray::create(&handle, &controller)?;
    tray.show_autostart(controller.autostart_enabled());
    watch_status(handle.clone(), Arc::clone(&controller), tray);

    // Reading the device token can wait on an unlock prompt, so not on the event loop.
    tauri::async_runtime::spawn_blocking(move || {
        let paired = controller.start();
        if !paired || !autostarted || asked_for_window {
            show_window(&handle);
        }
    });
    Ok(())
}

fn settings_dir() -> Result<std::path::PathBuf, &'static str> {
    Ok(dirs::config_dir()
        .ok_or("the operating system reports no configuration folder")?
        .join(IDENTIFIER))
}

/// Decides, before anything shows, whether this process runs Poise Link or
/// hands over to launchd's copy (see crate::launch_agent).
#[cfg(target_os = "macos")]
fn arrange(autostarted: bool) -> Result<Start, String> {
    let agent = LaunchAgent::for_this_user().map_err(|error| error.to_string())?;
    let settings_dir = settings_dir()?;
    launch_agent::arrange(&Arrangement {
        agent: &agent,
        launchd: &Launchctl::for_this_user(),
        copies: &Processes,
        by_launchd: launch_agent::by_launchd(),
        show_window: !autostarted,
        settings_dir: &settings_dir,
        sleep: &std::thread::sleep,
    })
}

/// Start at login was just turned on. On macOS, a copy launchd did not start
/// hands over to launchd's, which launchd starts again if it ever stops.
fn hand_over_to_launchd(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        if launch_agent::by_launchd() {
            return;
        }
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            // The notification that pairing succeeded, and the first sync, go first.
            tokio::time::sleep(HAND_OVER_DELAY).await;
            let agent = match LaunchAgent::for_this_user() {
                Ok(agent) => agent,
                Err(error) => {
                    log::error!("could not find the launch agent: {error}");
                    return;
                }
            };
            if !agent.installed() {
                // Start at login was turned off again meanwhile.
                return;
            }
            match launch_agent::hand_over(&agent, &Launchctl::for_this_user()) {
                Ok(()) => {
                    log::info!(
                        "launchd runs Poise Link from now on, and starts it again if it stops"
                    );
                    app.exit(0);
                }
                Err(error) => log::error!(
                    "could not hand Poise Link to launchd, so nothing starts it again if it stops: {error}"
                ),
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// Keeps the tray and the window in step with the core's status.
fn watch_status(app: AppHandle, controller: Arc<Controller>, tray: Arc<Tray>) {
    let mut updates = controller.subscribe();
    tauri::async_runtime::spawn(async move {
        let mut previous: Status = updates.borrow_and_update().clone();
        while updates.changed().await.is_ok() {
            let status = updates.borrow_and_update().clone();
            tray.render(&status);
            if let Err(error) = app.emit(STATUS_EVENT, StatusView::from(&status)) {
                log::error!("could not update the window: {error}");
            }
            let code = status.pairing_code();
            if code.is_some() && code != previous.pairing_code() {
                // A code to enter in Poise: a tray app has no Dock icon to find the
                // window by, so it comes forward and stays above other windows
                // until pairing ends.
                show_window(&app);
                keep_on_top(&app, true);
            } else if code.is_none() && previous.pairing_code().is_some() {
                keep_on_top(&app, false);
            }
            let was_pairing = matches!(previous.connection, Connection::Pairing { .. });
            let signed_out = matches!(status.connection, Connection::SignedOut { .. });
            if was_pairing && status.is_paired() {
                // Paired: start at login was turned on and the window steps aside to the tray.
                tray.show_autostart(controller.autostart_enabled());
                hide_window(&app);
                if controller.autostart_enabled() == Ok(true) {
                    hand_over_to_launchd(&app);
                }
            } else if previous.is_paired() && signed_out {
                // Signed out or revoked: back to pairing.
                show_window(&app);
            }
            previous = status;
        }
    });
}

fn show_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        log::error!("the {MAIN_WINDOW} window is missing");
        return;
    };
    if let Err(error) = window
        .show()
        .and_then(|()| window.unminimize())
        .and_then(|()| window.set_focus())
    {
        log::error!("could not show the window: {error}");
    }
}

fn keep_on_top(app: &AppHandle, on_top: bool) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW)
        && let Err(error) = window.set_always_on_top(on_top)
    {
        log::error!("could not change whether the window stays on top: {error}");
    }
}

fn hide_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW)
        && let Err(error) = window.hide()
    {
        log::error!("could not hide the window: {error}");
    }
}

struct SystemBrowser(AppHandle);

impl Browser for SystemBrowser {
    fn open(&self, url: &Url) -> Result<(), String> {
        self.0
            .opener()
            .open_url(url.as_str(), None::<&str>)
            .map_err(|error| error.to_string())
    }
}

/// Start at login: on macOS the launch agent, elsewhere the autostart plugin.
#[cfg(target_os = "macos")]
fn login_item(_app: &AppHandle) -> Result<LaunchAgentItem, std::io::Error> {
    Ok(LaunchAgentItem(LaunchAgent::for_this_user()?))
}

#[cfg(not(target_os = "macos"))]
fn login_item(app: &AppHandle) -> Result<LoginItem, std::io::Error> {
    Ok(LoginItem(app.clone()))
}

#[cfg(target_os = "macos")]
struct LaunchAgentItem(LaunchAgent);

#[cfg(target_os = "macos")]
impl Autostart for LaunchAgentItem {
    fn enable(&self) -> Result<(), String> {
        self.0.install().map_err(|error| error.to_string())
    }

    fn disable(&self) -> Result<(), String> {
        self.0.remove().map_err(|error| error.to_string())
    }

    fn is_enabled(&self) -> Result<bool, String> {
        Ok(self.0.installed())
    }
}

#[cfg(not(target_os = "macos"))]
struct LoginItem(AppHandle);

#[cfg(not(target_os = "macos"))]
impl Autostart for LoginItem {
    fn enable(&self) -> Result<(), String> {
        self.0
            .autolaunch()
            .enable()
            .map_err(|error| error.to_string())
    }

    fn disable(&self) -> Result<(), String> {
        self.0
            .autolaunch()
            .disable()
            .map_err(|error| error.to_string())
    }

    fn is_enabled(&self) -> Result<bool, String> {
        self.0
            .autolaunch()
            .is_enabled()
            .map_err(|error| error.to_string())
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_settings_folder_is_named_after_the_app() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
        assert_eq!(config["identifier"], super::IDENTIFIER);
    }
}
