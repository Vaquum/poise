//! Native notifications.
//!
//! The notification plugin shows a title and a body on desktop but ignores
//! clicks there, so a notification that should open a page is shown through
//! notify-rust (the library the plugin itself uses), and a thread waits for
//! the person to click it.

use std::borrow::Cow;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use notify_rust::NotificationResponse;
use reqwest::Url;
use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

use crate::platform::{Notice, Notifier};

/// Each clickable notification holds a thread until it is clicked or
/// dismissed; past this many, new ones are shown without their link.
const MAX_WAITING: usize = 32;

pub struct DesktopNotifier {
    app: AppHandle,
    waiting: Arc<AtomicUsize>,
}

impl DesktopNotifier {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            waiting: Arc::new(AtomicUsize::new(0)),
        }
    }

    fn show_plain(&self, title: &str, body: &str) {
        if let Err(error) = self
            .app
            .notification()
            .builder()
            .title(title)
            .body(body)
            .show()
        {
            log::error!("could not show a notification: {error}");
        }
    }

    fn reserve_waiter(&self) -> bool {
        if self.waiting.fetch_add(1, Ordering::SeqCst) < MAX_WAITING {
            true
        } else {
            self.waiting.fetch_sub(1, Ordering::SeqCst);
            false
        }
    }

    fn show_clickable(&self, title: String, body: String, url: Url) {
        let app = self.app.clone();
        let waiting = Arc::clone(&self.waiting);
        let spawned = std::thread::Builder::new()
            .name("poise-link-notification".to_owned())
            .spawn(move || {
                show_and_wait(&app, &title, &body, &url);
                waiting.fetch_sub(1, Ordering::SeqCst);
            });
        if let Err(error) = spawned {
            self.waiting.fetch_sub(1, Ordering::SeqCst);
            log::error!("could not start a notification thread: {error}");
        }
    }
}

impl Notifier for DesktopNotifier {
    fn notify(&self, notice: Notice) {
        let body = display_body(&notice.body, body_is_markup()).into_owned();
        match notice.url {
            Some(url) if self.reserve_waiter() => self.show_clickable(notice.title, body, url),
            Some(url) => {
                log::warn!(
                    "{MAX_WAITING} notifications are still waiting for a click; showing one without its link to {url}"
                );
                self.show_plain(&notice.title, &body);
            }
            None => self.show_plain(&notice.title, &body),
        }
    }
}

/// Notification servers that advertise `body-markup` (several Linux desktops)
/// read the body as markup, where the workspace could place links to any
/// scheme. Escaped, it shows exactly as written.
fn display_body(body: &str, markup: bool) -> Cow<'_, str> {
    if !markup || !body.contains(['&', '<', '>']) {
        return Cow::Borrowed(body);
    }
    Cow::Owned(
        body.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;"),
    )
}

#[cfg(all(unix, not(target_os = "macos")))]
fn body_is_markup() -> bool {
    static MARKUP: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *MARKUP.get_or_init(|| match notify_rust::get_capabilities() {
        Ok(capabilities) => capabilities
            .iter()
            .any(|capability| capability == "body-markup"),
        Err(error) => {
            log::warn!(
                "could not ask the notification server what it supports ({error}); escaping markup"
            );
            true
        }
    })
}

/// macOS and Windows show notification text as plain text.
#[cfg(not(all(unix, not(target_os = "macos"))))]
fn body_is_markup() -> bool {
    false
}

/// Shows the notification and blocks this thread until the person clicks or
/// dismisses it. A click opens `url`.
fn show_and_wait(app: &AppHandle, title: &str, body: &str, url: &Url) {
    let mut notification = notify_rust::Notification::new();
    notification.summary(title).body(body).auto_icon();
    // XDG notification servers make the notification clickable through its "default" action.
    #[cfg(all(unix, not(target_os = "macos")))]
    notification.action("default", "Open");
    #[cfg(windows)]
    if running_installed() {
        notification.app_id(&app.config().identifier);
    }
    #[cfg(target_os = "macos")]
    attribute_to_app(app);

    let handle = match notification.show() {
        Ok(handle) => handle,
        Err(error) => {
            log::error!("could not show a notification: {error}");
            return;
        }
    };
    let waited = handle.wait_for_response(|response: &NotificationResponse| {
        if matches!(
            response,
            NotificationResponse::Default | NotificationResponse::Action(_)
        ) && let Err(error) = app.opener().open_url(url.as_str(), None::<&str>)
        {
            log::error!("could not open {url}: {error}");
        }
    });
    if let Err(error) = waited {
        log::warn!("lost track of a notification: {error}");
    }
}

/// Makes notifications appear as Poise Link's, as the notification plugin
/// does: an unbundled development build borrows Terminal's identity.
#[cfg(target_os = "macos")]
fn attribute_to_app(app: &AppHandle) {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let identifier = if tauri::is_dev() {
            "com.apple.Terminal".to_owned()
        } else {
            app.config().identifier.clone()
        };
        // Fails harmlessly when the notification plugin already set it.
        if let Err(error) = notify_rust::set_application(&identifier) {
            log::info!("notification identity left as it was: {error}");
        }
    });
}

/// Installed copies have a Start menu entry carrying the app id; development
/// builds run from the Cargo target folder and have none.
#[cfg(windows)]
fn running_installed() -> bool {
    use std::path::Path;
    match tauri::utils::platform::current_exe() {
        Ok(exe) => exe.parent().is_some_and(|dir| {
            !(dir.ends_with(Path::new("target").join("debug"))
                || dir.ends_with(Path::new("target").join("release")))
        }),
        Err(error) => {
            log::warn!("could not locate the running executable: {error}");
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markup_in_a_body_is_shown_as_text_where_servers_read_markup() {
        let body =
            r#"Done <a href="file:///etc/passwd">here</a> & <img src="https://x.example/t.png">"#;
        assert_eq!(
            display_body(body, true),
            "Done &lt;a href=\"file:///etc/passwd\"&gt;here&lt;/a&gt; &amp; &lt;img src=\"https://x.example/t.png\"&gt;"
        );
        assert_eq!(display_body(body, false), body);
        assert!(matches!(display_body("plain text", true), Cow::Borrowed(_)));
    }
}
