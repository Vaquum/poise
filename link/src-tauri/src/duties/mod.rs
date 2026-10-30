//! Duties are the local jobs Poise Link does for the paired workspace:
//! keeping Espanso's snippets in sync and turning alerts into notifications.
//!
//! Each duty runs as its own task. It receives the event-stream events it
//! names, ticks on its own interval, and reacts to "Sync now". A new local job
//! is a new module implementing [`Duty`] plus one line in [`standard`]; the
//! pairing, connection and tray code does not change.

pub mod alerts;
pub mod snippets;

use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use crate::link_api::LinkApi;
use crate::platform::Notifier;
use crate::settings::SettingsStore;
use crate::sse;
use crate::status::StatusHandle;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// What wakes a duty.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Input {
    /// An event of a type the duty listed in [`Duty::events`].
    Event(sse::Event),
    /// Its [`Duty::interval`] came round (also once when the session starts).
    Tick,
    /// The person chose "Sync now".
    SyncNow,
}

#[derive(Debug, thiserror::Error)]
pub enum DutyError {
    /// The workspace no longer accepts this device; the session ends.
    #[error("the device token was not accepted")]
    Unauthorized,
    #[error("{0}")]
    Failed(String),
}

/// What every duty may use.
#[derive(Clone)]
pub struct Context {
    pub api: LinkApi,
    pub settings: Arc<SettingsStore>,
    pub status: StatusHandle,
    pub notifier: Arc<dyn Notifier>,
}

pub trait Duty: Send + 'static {
    /// A short name for log lines.
    fn name(&self) -> &'static str;

    /// The event-stream event types this duty receives.
    fn events(&self) -> &'static [&'static str];

    /// How often the duty runs by itself, if at all.
    fn interval(&self) -> Option<Duration> {
        None
    }

    /// Handles one input. Inputs arrive one at a time, in order.
    fn handle<'a>(
        &'a mut self,
        input: Input,
        context: &'a Context,
    ) -> BoxFuture<'a, Result<(), DutyError>>;
}

/// The duties a paired device runs.
pub fn standard(
    espanso: Arc<snippets::espanso::Locator>,
    config_dir: PathBuf,
    snippet_interval: Duration,
) -> Vec<Box<dyn Duty>> {
    vec![
        Box::new(snippets::SnippetSync::new(
            espanso,
            config_dir,
            snippet_interval,
        )),
        Box::new(alerts::Alerts),
    ]
}
