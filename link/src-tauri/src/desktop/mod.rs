//! The desktop app: Tauri plugins, the tray, the pairing and status window,
//! and the operating-system services the core asks for.

mod commands;
mod notifier;
mod tray;

use std::sync::Arc;

use reqwest::Url;
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_opener::OpenerExt;

use crate::connection::Timing;
use crate::controller::{Controller, Platform};
use crate::credentials::OsCredentialStore;
use crate::duties::snippets::espanso::Locator;
use crate::platform::{Autostart, Browser};
use crate::status::{Connection, Status};
use commands::StatusView;
use notifier::DesktopNotifier;
use tray::Tray;

/// Passed by the login item, so a start at login stays in the tray.
const AUTOSTART_ARG: &str = "--autostart";
const MAIN_WINDOW: &str = "main";
const STATUS_EVENT: &str = "status";
const MAX_LOG_BYTES: u128 = 2 * 1024 * 1024;

pub fn run() {
    let autostarted = std::env::args().any(|arg| arg == AUTOSTART_ARG);
    tauri::Builder::default()
        // Registered first: a second launch only shows the running copy's window.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_window(app)
        }))
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .max_file_size(MAX_LOG_BYTES)
                .build(),
        )
        // The launcher choice only matters on macOS; `init` takes it on every system.
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![AUTOSTART_ARG]),
        ))
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
    let config_dir = dirs::config_dir()
        .ok_or("the operating system reports no configuration folder")?
        .join(&identifier);
    let handle = app.handle().clone();
    let platform = Platform {
        secrets: Box::new(OsCredentialStore::new(&identifier)),
        notifier: Arc::new(DesktopNotifier::new(handle.clone())),
        browser: Arc::new(SystemBrowser(handle.clone())),
        autostart: Arc::new(LoginItem(handle.clone())),
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
        if !paired || !autostarted {
            show_window(&handle);
        }
    });
    Ok(())
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
            let was_pairing = matches!(previous.connection, Connection::Pairing { .. });
            let signed_out = matches!(status.connection, Connection::SignedOut { .. });
            if was_pairing && status.is_paired() {
                // Paired: start at login was turned on and the window steps aside to the tray.
                tray.show_autostart(controller.autostart_enabled());
                hide_window(&app);
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

struct LoginItem(AppHandle);

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
