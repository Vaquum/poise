//! The alert duty: turns the workspace's `alert` events into native
//! notifications, each exactly once, even across reconnects and restarts.

use reqwest::Url;
use serde::Deserialize;

use super::{BoxFuture, Context, Duty, DutyError, Input};
use crate::platform::Notice;
use crate::sse;

/// How many delivered alert ids are remembered to recognise a replay.
pub const REMEMBERED: usize = 200;

#[derive(Debug)]
pub struct Alerts;

#[derive(Deserialize)]
struct Alert {
    id: String,
    title: String,
    body: String,
    url: String,
}

impl Duty for Alerts {
    fn name(&self) -> &'static str {
        "alerts"
    }

    fn events(&self) -> &'static [&'static str] {
        &["alert"]
    }

    fn handle<'a>(
        &'a mut self,
        input: Input,
        context: &'a Context,
    ) -> BoxFuture<'a, Result<(), DutyError>> {
        Box::pin(async move {
            match input {
                Input::Event(event) => deliver(context, &event),
                Input::Tick | Input::SyncNow => Ok(()),
            }
        })
    }
}

fn deliver(context: &Context, event: &sse::Event) -> Result<(), DutyError> {
    let stream_id = event.id.clone().filter(|id| !id.is_empty());
    let alert: Alert = match serde_json::from_str(&event.data) {
        Ok(alert) => alert,
        Err(error) => {
            // Move past it, so that reconnecting does not replay it again and again.
            if let Some(id) = stream_id {
                remember(context, id, None)?;
            }
            return Err(DutyError::Failed(format!(
                "unreadable alert event: {error}"
            )));
        }
    };
    let settings = context.settings.get();
    if settings.delivered_alerts.contains(&alert.id) {
        log::info!(
            "alert {} was delivered before; not notifying again",
            alert.id
        );
    } else if settings.notifications {
        let url = match resolve_url(context.api.endpoint(), &alert.url) {
            Ok(url) => Some(url),
            Err(problem) => {
                log::warn!(
                    "alert {}: {problem}; its notification opens nothing",
                    alert.id
                );
                None
            }
        };
        context.notifier.notify(Notice {
            title: alert.title,
            body: alert.body,
            url,
        });
    } else {
        log::info!("notifications are off; alert {} was not shown", alert.id);
    }
    let resume_id = stream_id.unwrap_or_else(|| alert.id.clone());
    remember(context, resume_id, Some(alert.id))
}

/// Records where the stream may resume and, when given, a delivered alert id.
fn remember(
    context: &Context,
    resume_id: String,
    delivered: Option<String>,
) -> Result<(), DutyError> {
    context
        .settings
        .update(|settings| {
            settings.last_event_id = Some(resume_id);
            if let Some(id) = delivered
                && !settings.delivered_alerts.contains(&id)
            {
                settings.delivered_alerts.push(id);
                let excess = settings.delivered_alerts.len().saturating_sub(REMEMBERED);
                settings.delivered_alerts.drain(..excess);
            }
        })
        .map_err(|error| {
            DutyError::Failed(format!("could not record the delivered alert: {error}"))
        })
}

/// The page an alert opens: its `url`, relative to the workspace, and only
/// ever a web page.
pub fn resolve_url(endpoint: &Url, url: &str) -> Result<Url, String> {
    let resolved = endpoint
        .join(url)
        .map_err(|error| format!("{url:?} is not a link: {error}"))?;
    match resolved.scheme() {
        "https" | "http" => Ok(resolved),
        other => Err(format!("{url:?} is not a web link ({other}:)")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http;
    use crate::link_api::LinkApi;
    use crate::platform::Notifier;
    use crate::settings::SettingsStore;
    use crate::status::{Connection, Snippets, Status, StatusHandle};
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    struct Recorder(Mutex<Vec<Notice>>);

    impl Notifier for Recorder {
        fn notify(&self, notice: Notice) {
            self.0.lock().unwrap().push(notice);
        }
    }

    fn endpoint() -> Url {
        Url::parse("https://octocat.poise.example.com/").unwrap()
    }

    fn context(dir: &std::path::Path) -> (Context, Arc<Recorder>) {
        let recorder = Arc::new(Recorder::default());
        let context = Context {
            api: LinkApi::new(http::client().unwrap(), endpoint(), "token".into()),
            settings: Arc::new(SettingsStore::open(dir).unwrap()),
            status: StatusHandle::new(Status {
                connection: Connection::Connected,
                snippets: Snippets::NotSynced,
                server: None,
                endpoint: None,
                login: None,
                notifications: true,
            }),
            notifier: Arc::clone(&recorder) as Arc<dyn Notifier>,
        };
        (context, recorder)
    }

    fn alert_event(id: &str, stream_id: Option<&str>, url: &str) -> sse::Event {
        sse::Event {
            event: "alert".into(),
            data: format!(
                r#"{{"id":"{id}","kind":"chat","title":"Turn finished","body":"Your turn is done","url":"{url}","created_at":"2026-10-03T10:00:00Z"}}"#
            ),
            id: stream_id.map(str::to_owned),
        }
    }

    #[test]
    fn notifies_once_per_alert_and_remembers_where_to_resume() {
        let dir = tempfile::tempdir().unwrap();
        let (context, recorder) = context(dir.path());

        deliver(&context, &alert_event("a1", Some("a1"), "/chat/7")).unwrap();
        deliver(&context, &alert_event("a1", Some("a1"), "/chat/7")).unwrap();

        let notices = recorder.0.lock().unwrap();
        assert_eq!(notices.len(), 1);
        assert_eq!(notices[0].title, "Turn finished");
        assert_eq!(
            notices[0].url.as_ref().unwrap().as_str(),
            "https://octocat.poise.example.com/chat/7"
        );
        let settings = context.settings.get();
        assert_eq!(settings.last_event_id.as_deref(), Some("a1"));
        assert_eq!(settings.delivered_alerts, vec!["a1".to_owned()]);
        // A restart reads the same record.
        assert_eq!(
            SettingsStore::open(dir.path())
                .unwrap()
                .get()
                .delivered_alerts,
            vec!["a1".to_owned()]
        );
    }

    #[test]
    fn resumes_from_the_alert_id_when_the_stream_gives_none() {
        let dir = tempfile::tempdir().unwrap();
        let (context, _) = context(dir.path());
        deliver(&context, &alert_event("a2", None, "/")).unwrap();
        assert_eq!(context.settings.get().last_event_id.as_deref(), Some("a2"));
    }

    #[test]
    fn notifications_off_records_but_does_not_show() {
        let dir = tempfile::tempdir().unwrap();
        let (context, recorder) = context(dir.path());
        context
            .settings
            .update(|s| s.notifications = false)
            .unwrap();

        deliver(&context, &alert_event("a3", Some("a3"), "/")).unwrap();

        assert!(recorder.0.lock().unwrap().is_empty());
        assert_eq!(
            context.settings.get().delivered_alerts,
            vec!["a3".to_owned()]
        );
    }

    #[test]
    fn an_unsafe_link_still_notifies_but_opens_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let (context, recorder) = context(dir.path());
        deliver(
            &context,
            &alert_event("a4", Some("a4"), "javascript:alert(1)"),
        )
        .unwrap();
        let notices = recorder.0.lock().unwrap();
        assert_eq!(notices.len(), 1);
        assert_eq!(notices[0].url, None);
    }

    #[test]
    fn an_unreadable_alert_is_skipped_past() {
        let dir = tempfile::tempdir().unwrap();
        let (context, recorder) = context(dir.path());
        let broken = sse::Event {
            event: "alert".into(),
            data: "{not json".into(),
            id: Some("a5".into()),
        };
        assert!(deliver(&context, &broken).is_err());
        assert!(recorder.0.lock().unwrap().is_empty());
        assert_eq!(context.settings.get().last_event_id.as_deref(), Some("a5"));
    }

    #[test]
    fn remembers_a_bounded_number_of_alerts() {
        let dir = tempfile::tempdir().unwrap();
        let (context, recorder) = context(dir.path());
        context
            .settings
            .update(|s| s.notifications = false)
            .unwrap();
        for n in 0..REMEMBERED + 5 {
            deliver(&context, &alert_event(&format!("id-{n}"), None, "/")).unwrap();
        }
        let delivered = context.settings.get().delivered_alerts;
        assert_eq!(delivered.len(), REMEMBERED);
        assert_eq!(delivered.first().map(String::as_str), Some("id-5"));
        assert!(recorder.0.lock().unwrap().is_empty());
    }

    #[test]
    fn links_resolve_against_the_workspace_and_must_be_web_pages() {
        let endpoint = endpoint();
        assert_eq!(
            resolve_url(&endpoint, "/behaviors?held=1")
                .unwrap()
                .as_str(),
            "https://octocat.poise.example.com/behaviors?held=1"
        );
        assert_eq!(
            resolve_url(&endpoint, "https://github.com/autonomio/poise/pull/1")
                .unwrap()
                .as_str(),
            "https://github.com/autonomio/poise/pull/1"
        );
        for unsafe_link in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "vscode://file/etc/passwd",
            "smb://evil.example/share",
            "data:text/html,<script>alert(1)</script>",
        ] {
            assert!(
                resolve_url(&endpoint, unsafe_link).is_err(),
                "{unsafe_link} was accepted"
            );
        }
    }
}
