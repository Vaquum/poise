//! Poise Link, the desktop companion to a Poise workspace: it keeps Espanso's
//! `poise.yml` in sync with the person's snippets and shows Poise alerts as
//! native notifications, even while the browser is closed.
//!
//! The core (pairing, the event stream, the duties) knows nothing about the
//! user interface, so tests drive it directly; `desktop` connects it to the
//! tray, the window and the operating system.

pub mod backoff;
pub mod connection;
pub mod controller;
pub mod credentials;
pub mod duties;
pub mod fsutil;
pub mod http;
#[cfg(unix)]
pub mod launch_agent;
pub mod link_api;
pub mod pairing;
pub mod platform;
pub mod settings;
pub mod sse;
pub mod status;

mod desktop;

pub use desktop::run;
