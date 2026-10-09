//! What Poise Link is doing right now, as the tray and the window show it.

use serde::Serialize;
use tokio::sync::watch;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Connection {
    /// Not paired. `reason` says why when that was not the person's choice.
    SignedOut {
        reason: Option<String>,
    },
    /// Device pairing is under way; the code is known once the server answered.
    Pairing {
        user_code: Option<String>,
        verification_uri: Option<String>,
    },
    Connecting,
    Connected,
    Reconnecting {
        error: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Snippets {
    NotSynced,
    /// `at` is the local time of the last successful check.
    Synced {
        at: String,
        count: usize,
        file: String,
    },
    EspansoMissing {
        detail: String,
    },
    /// The workspace sent something other than plain snippets; the old file was kept.
    Rejected {
        reason: String,
    },
    Failed {
        error: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub connection: Connection,
    pub snippets: Snippets,
    /// The Poise address the person paired with (or last entered).
    pub server: Option<String>,
    /// Their workspace address.
    pub endpoint: Option<String>,
    pub login: Option<String>,
    pub notifications: bool,
}

impl Status {
    /// The code a pairing in progress shows, once the server has issued it.
    pub fn pairing_code(&self) -> Option<&str> {
        match &self.connection {
            Connection::Pairing {
                user_code: Some(code),
                ..
            } => Some(code),
            _ => None,
        }
    }

    /// Whether a device token is in use (connected or trying to be).
    pub fn is_paired(&self) -> bool {
        matches!(
            self.connection,
            Connection::Connecting | Connection::Connected | Connection::Reconnecting { .. }
        )
    }

    /// The tray's connection line.
    pub fn connection_line(&self) -> String {
        match &self.connection {
            Connection::SignedOut { .. } => "Signed out".to_owned(),
            Connection::Pairing { .. } => "Pairing…".to_owned(),
            Connection::Connecting => "Connecting…".to_owned(),
            Connection::Connected => match &self.login {
                Some(login) => format!("Connected as {login}"),
                None => "Connected".to_owned(),
            },
            Connection::Reconnecting { .. } => "Reconnecting…".to_owned(),
        }
    }

    /// The tray's snippet line.
    pub fn snippets_line(&self) -> String {
        match &self.snippets {
            Snippets::NotSynced => "Snippets not synced yet".to_owned(),
            Snippets::Synced { at, count, .. } => {
                let noun = if *count == 1 { "snippet" } else { "snippets" };
                format!("{count} {noun}, last synced {at}")
            }
            Snippets::EspansoMissing { .. } => "Espanso not found".to_owned(),
            Snippets::Rejected { .. } => "Snippets rejected, kept the previous file".to_owned(),
            Snippets::Failed { .. } => "Snippet sync failed".to_owned(),
        }
    }
}

/// Shared, observable status: the core writes it, the tray and window watch it.
#[derive(Debug, Clone)]
pub struct StatusHandle {
    sender: watch::Sender<Status>,
}

impl StatusHandle {
    pub fn new(initial: Status) -> Self {
        Self {
            sender: watch::Sender::new(initial),
        }
    }

    pub fn get(&self) -> Status {
        self.sender.borrow().clone()
    }

    pub fn subscribe(&self) -> watch::Receiver<Status> {
        self.sender.subscribe()
    }

    /// Applies `change` and wakes watchers only if something changed.
    pub fn update(&self, change: impl FnOnce(&mut Status)) {
        self.sender.send_if_modified(|status| {
            let before = status.clone();
            change(status);
            *status != before
        });
    }

    pub fn set_connection(&self, connection: Connection) {
        self.update(|status| status.connection = connection);
    }

    pub fn set_snippets(&self, snippets: Snippets) {
        self.update(|status| status.snippets = snippets);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(connection: Connection, snippets: Snippets) -> Status {
        Status {
            connection,
            snippets,
            server: Some("https://poise.example.com/".into()),
            endpoint: Some("https://octocat.poise.example.com/".into()),
            login: Some("octocat".into()),
            notifications: true,
        }
    }

    #[test]
    fn connection_lines() {
        let line = |c| status(c, Snippets::NotSynced).connection_line();
        assert_eq!(line(Connection::SignedOut { reason: None }), "Signed out");
        assert_eq!(line(Connection::Connected), "Connected as octocat");
        assert_eq!(
            line(Connection::Reconnecting { error: "x".into() }),
            "Reconnecting…"
        );
        assert_eq!(line(Connection::Connecting), "Connecting…");
    }

    #[test]
    fn snippet_lines() {
        let line = |s| status(Connection::Connected, s).snippets_line();
        let synced = |count| Snippets::Synced {
            at: "14:03".into(),
            count,
            file: "/m/poise.yml".into(),
        };
        assert_eq!(line(synced(12)), "12 snippets, last synced 14:03");
        assert_eq!(line(synced(1)), "1 snippet, last synced 14:03");
        assert_eq!(
            line(Snippets::EspansoMissing { detail: "x".into() }),
            "Espanso not found"
        );
        assert_eq!(
            line(Snippets::Rejected { reason: "x".into() }),
            "Snippets rejected, kept the previous file"
        );
    }

    #[test]
    fn has_a_pairing_code_only_once_the_server_has_issued_one() {
        let waiting = Connection::Pairing {
            user_code: None,
            verification_uri: None,
        };
        assert_eq!(status(waiting, Snippets::NotSynced).pairing_code(), None);
        let issued = Connection::Pairing {
            user_code: Some("WDJB-MJHT".into()),
            verification_uri: None,
        };
        assert_eq!(
            status(issued, Snippets::NotSynced).pairing_code(),
            Some("WDJB-MJHT")
        );
        assert_eq!(
            status(Connection::Connected, Snippets::NotSynced).pairing_code(),
            None
        );
    }

    #[test]
    fn serializes_for_the_window() {
        let json = serde_json::to_value(status(
            Connection::Pairing {
                user_code: Some("WDJB-MJHT".into()),
                verification_uri: None,
            },
            Snippets::NotSynced,
        ))
        .unwrap();
        assert_eq!(json["connection"]["state"], "pairing");
        assert_eq!(json["connection"]["userCode"], "WDJB-MJHT");
        assert_eq!(json["snippets"]["state"], "notSynced");
    }

    #[test]
    fn watchers_wake_only_on_change() {
        let handle = StatusHandle::new(status(Connection::Connecting, Snippets::NotSynced));
        let mut watcher = handle.subscribe();
        watcher.mark_unchanged();
        handle.set_connection(Connection::Connecting);
        assert!(!watcher.has_changed().unwrap());
        handle.set_connection(Connection::Connected);
        assert!(watcher.has_changed().unwrap());
    }
}
