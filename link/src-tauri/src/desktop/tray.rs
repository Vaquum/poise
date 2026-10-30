//! The tray (menu bar) icon and its menu.

use std::sync::Arc;

use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Wry};

use crate::controller::Controller;
use crate::status::Status;

const OPEN: &str = "open";
const SYNC: &str = "sync";
const NOTIFICATIONS: &str = "notifications";
const AUTOSTART: &str = "autostart";
const SIGN_OUT: &str = "sign-out";
const QUIT: &str = "quit";

pub struct Tray {
    connection: MenuItem<Wry>,
    snippets: MenuItem<Wry>,
    open: MenuItem<Wry>,
    sync: MenuItem<Wry>,
    notifications: CheckMenuItem<Wry>,
    autostart: CheckMenuItem<Wry>,
    sign_out: MenuItem<Wry>,
}

impl Tray {
    pub fn create(app: &AppHandle, controller: &Arc<Controller>) -> tauri::Result<Arc<Self>> {
        let status = controller.status();
        let tray = Arc::new(Self {
            connection: MenuItem::with_id(
                app,
                "connection",
                status.connection_line(),
                false,
                None::<&str>,
            )?,
            snippets: MenuItem::with_id(
                app,
                "snippets",
                status.snippets_line(),
                false,
                None::<&str>,
            )?,
            open: MenuItem::with_id(app, OPEN, "Open Poise", false, None::<&str>)?,
            sync: MenuItem::with_id(app, SYNC, "Sync now", false, None::<&str>)?,
            notifications: CheckMenuItem::with_id(
                app,
                NOTIFICATIONS,
                "Notifications",
                true,
                status.notifications,
                None::<&str>,
            )?,
            autostart: CheckMenuItem::with_id(
                app,
                AUTOSTART,
                "Start at login",
                true,
                false,
                None::<&str>,
            )?,
            sign_out: MenuItem::with_id(app, SIGN_OUT, "Sign out", false, None::<&str>)?,
        });
        let menu = Menu::with_items(
            app,
            &[
                &tray.connection,
                &tray.snippets,
                &PredefinedMenuItem::separator(app)?,
                &tray.open,
                &tray.sync,
                &PredefinedMenuItem::separator(app)?,
                &tray.notifications,
                &tray.autostart,
                &PredefinedMenuItem::separator(app)?,
                &tray.sign_out,
                &MenuItem::with_id(app, QUIT, "Quit", true, None::<&str>)?,
            ],
        )?;
        let for_menu = Arc::clone(&tray);
        let controller = Arc::clone(controller);
        TrayIconBuilder::with_id("poise-link")
            .icon(icon())
            .icon_as_template(cfg!(target_os = "macos"))
            .tooltip("Poise Link")
            .menu(&menu)
            .show_menu_on_left_click(true)
            .on_menu_event(move |app, event| for_menu.handle(app, &controller, event.id().as_ref()))
            .build(app)?;
        tray.render(&status);
        Ok(tray)
    }

    /// Brings the menu in line with `status`.
    pub fn render(&self, status: &Status) {
        let paired = status.is_paired();
        for result in [
            self.connection.set_text(status.connection_line()),
            self.snippets.set_text(status.snippets_line()),
            self.open.set_enabled(paired),
            self.sync.set_enabled(paired),
            self.sign_out.set_enabled(paired),
            self.notifications.set_checked(status.notifications),
        ] {
            if let Err(error) = result {
                log::error!("could not update the tray menu: {error}");
            }
        }
    }

    /// Shows whether start at login is on, as the operating system reports it.
    pub fn show_autostart(&self, enabled: Result<bool, String>) {
        match enabled {
            Ok(on) => {
                if let Err(error) = self.autostart.set_checked(on) {
                    log::error!("could not update the tray menu: {error}");
                }
            }
            Err(error) => log::error!("could not read the start-at-login setting: {error}"),
        }
    }

    fn handle(&self, app: &AppHandle, controller: &Arc<Controller>, id: &str) {
        match id {
            OPEN => {
                if let Err(error) = controller.open_poise() {
                    log::error!("could not open Poise: {error}");
                }
            }
            SYNC => controller.sync_now(),
            NOTIFICATIONS => match self.notifications.is_checked() {
                Ok(on) => {
                    if let Err(error) = controller.set_notifications(on) {
                        log::error!("could not save the notification setting: {error}");
                    }
                }
                Err(error) => log::error!("could not read the tray menu: {error}"),
            },
            AUTOSTART => {
                match self.autostart.is_checked() {
                    Ok(on) => match controller.set_autostart(on) {
                        Ok(()) if on => super::hand_over_to_launchd(app),
                        Ok(()) => {}
                        Err(error) => log::error!("could not change start at login: {error}"),
                    },
                    Err(error) => log::error!("could not read the tray menu: {error}"),
                }
                self.show_autostart(controller.autostart_enabled());
            }
            SIGN_OUT => {
                let controller = Arc::clone(controller);
                tauri::async_runtime::spawn_blocking(move || {
                    if let Err(error) = controller.sign_out() {
                        log::error!("could not sign out cleanly: {error}");
                    }
                });
            }
            QUIT => app.exit(0),
            _ => {}
        }
    }
}

/// A monochrome template image on macOS, which the menu bar tints; the
/// full-colour icon elsewhere, where tray backgrounds can be light or dark.
fn icon() -> Image<'static> {
    if cfg!(target_os = "macos") {
        tauri::include_image!("icons/tray-template.png")
    } else {
        tauri::include_image!("icons/32x32.png")
    }
}
