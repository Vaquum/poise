//! The operating-system services the core relies on. The desktop app
//! implements them with Tauri plugins; tests substitute recorders.

use reqwest::Url;

/// A native notification.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notice {
    pub title: String,
    pub body: String,
    /// Opened in the browser when the person clicks the notification.
    pub url: Option<Url>,
}

pub trait Notifier: Send + Sync {
    /// Shows `notice`. Failures are the notifier's to log: there is nothing
    /// the caller could do differently.
    fn notify(&self, notice: Notice);
}

pub trait Browser: Send + Sync {
    fn open(&self, url: &Url) -> Result<(), String>;
}

/// Start at login (a LaunchAgent on macOS, the Run key on Windows, an XDG
/// autostart entry on Linux).
pub trait Autostart: Send + Sync {
    fn enable(&self) -> Result<(), String>;
    fn disable(&self) -> Result<(), String>;
    fn is_enabled(&self) -> Result<bool, String>;
}
