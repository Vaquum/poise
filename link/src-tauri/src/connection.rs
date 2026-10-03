//! A paired session: holds the workspace's event stream open, reconnecting
//! with backoff, and runs the duties.
//!
//! Every duty is its own task. Events reach the duties that asked for their
//! type, ticks arrive on each duty's interval, and "Sync now" reaches all of
//! them. The session ends only when the workspace stops accepting the device
//! token (HTTP 401 from the stream or from any duty's request).

use std::convert::Infallible;
use std::time::Duration;

use tokio::sync::mpsc;
use tokio::task::JoinSet;
use tokio::time::MissedTickBehavior;

use crate::backoff::{self, Backoff};
use crate::duties::{Context, Duty, DutyError, Input};
use crate::link_api::ApiError;
use crate::sse;
use crate::status::Connection;

#[derive(Debug, Clone)]
pub struct Timing {
    pub backoff_base: Duration,
    pub backoff_max: Duration,
    /// The workspace pings every 20 seconds; this much silence means the
    /// connection is dead even if the socket has not noticed.
    pub idle_timeout: Duration,
    /// How often snippets are checked even without a `snippets` event.
    pub snippet_interval: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            backoff_base: backoff::DEFAULT_BASE,
            backoff_max: backoff::DEFAULT_MAX,
            idle_timeout: Duration::from_secs(60),
            snippet_interval: Duration::from_secs(10 * 60),
        }
    }
}

/// Why a session ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ended {
    /// The workspace answered 401: the device was revoked.
    Revoked,
}

struct Route {
    events: &'static [&'static str],
    inputs: mpsc::Sender<Input>,
}

/// Runs until the device is revoked. Dropping the future (or aborting its
/// task) stops the stream and every duty.
pub async fn run(
    context: Context,
    duties: Vec<Box<dyn Duty>>,
    timing: Timing,
    mut sync_requests: mpsc::UnboundedReceiver<()>,
) -> Ended {
    let (revoked_tx, mut revoked_rx) = mpsc::channel::<()>(1);
    let mut tasks = JoinSet::new();
    let mut routes = Vec::new();
    for duty in duties {
        let (inputs, receiver) = mpsc::channel(64);
        if let Some(every) = duty.interval() {
            tasks.spawn(tick(every, inputs.clone()));
        }
        routes.push(Route {
            events: duty.events(),
            inputs,
        });
        tasks.spawn(run_duty(
            duty,
            receiver,
            context.clone(),
            revoked_tx.clone(),
        ));
    }

    let forward_sync_requests = async {
        while sync_requests.recv().await.is_some() {
            for route in &routes {
                // A full queue already holds work that will fetch the latest state.
                if route.inputs.try_send(Input::SyncNow).is_err() {
                    log::info!("sync already queued");
                }
            }
        }
        // The controller dropped its sender; keep the session running regardless.
        std::future::pending::<Infallible>().await
    };

    let ended = tokio::select! {
        ended = stream(&context, &routes, &timing) => ended,
        _ = revoked_rx.recv() => Ended::Revoked,
        never = forward_sync_requests => match never {},
    };
    tasks.abort_all();
    ended
}

async fn run_duty(
    mut duty: Box<dyn Duty>,
    mut inputs: mpsc::Receiver<Input>,
    context: Context,
    revoked: mpsc::Sender<()>,
) {
    while let Some(input) = inputs.recv().await {
        match duty.handle(input, &context).await {
            Ok(()) => {}
            Err(DutyError::Unauthorized) => {
                // A full channel means the session already knows.
                let _already_signalled = revoked.try_send(());
                return;
            }
            Err(DutyError::Failed(error)) => log::error!("{}: {error}", duty.name()),
        }
    }
}

async fn tick(every: Duration, inputs: mpsc::Sender<Input>) {
    let mut interval = tokio::time::interval(every);
    interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        interval.tick().await;
        if inputs.send(Input::Tick).await.is_err() {
            return;
        }
    }
}

#[derive(Debug, thiserror::Error)]
enum StreamError {
    #[error(transparent)]
    Api(#[from] ApiError),
    #[error("the event stream broke: {0}")]
    Read(#[from] reqwest::Error),
    #[error("no data from the workspace for {0:?}")]
    Idle(Duration),
    #[error("the workspace closed the event stream")]
    Closed,
    #[error(transparent)]
    Parse(#[from] sse::SseError),
}

async fn stream(context: &Context, routes: &[Route], timing: &Timing) -> Ended {
    let mut backoff = Backoff::new(timing.backoff_base, timing.backoff_max);
    context.status.set_connection(Connection::Connecting);
    loop {
        let error = match read_events(context, routes, timing, &mut backoff).await {
            Err(StreamError::Api(ApiError::Unauthorized)) => return Ended::Revoked,
            Err(error) => error,
            Ok(never) => match never {},
        };
        let delay = backoff.next_delay(backoff::random_pick);
        log::warn!("event stream: {error}; reconnecting in {delay:?}");
        context.status.set_connection(Connection::Reconnecting {
            error: error.to_string(),
        });
        tokio::time::sleep(delay).await;
    }
}

async fn read_events(
    context: &Context,
    routes: &[Route],
    timing: &Timing,
    backoff: &mut Backoff,
) -> Result<Infallible, StreamError> {
    let last_event_id = context.settings.get().last_event_id;
    let mut response = context.api.open_events(last_event_id.as_deref()).await?;
    context.status.set_connection(Connection::Connected);
    let mut parser = sse::Parser::new();
    loop {
        let chunk = tokio::time::timeout(timing.idle_timeout, response.chunk())
            .await
            .map_err(|_| StreamError::Idle(timing.idle_timeout))??
            .ok_or(StreamError::Closed)?;
        let events = parser.feed(&chunk)?;
        if let Some(retry) = parser.retry() {
            backoff.set_base(retry, timing.backoff_base);
        }
        for event in events {
            // An event means the connection is healthy again.
            backoff.reset();
            for route in routes
                .iter()
                .filter(|route| route.events.contains(&event.event.as_str()))
            {
                if route
                    .inputs
                    .send(Input::Event(event.clone()))
                    .await
                    .is_err()
                {
                    log::error!("a duty stopped; dropped a {} event", event.event);
                }
            }
        }
    }
}
