//! What Poise Link remembers between runs, kept in `state.json` in its
//! configuration folder. The device token is not here: it lives in the
//! operating system's credential store (see [`crate::credentials`]).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::fsutil::{self, Access};

pub const FILE_NAME: &str = "state.json";
/// Where an unreadable `state.json` is moved so it can be inspected.
pub const QUARANTINE_NAME: &str = "state.json.corrupt";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    /// The Poise address the person paired with (or last entered).
    pub server: Option<String>,
    /// Their workspace address, from pairing.
    pub endpoint: Option<String>,
    pub login: Option<String>,
    /// Whether alerts become notifications.
    pub notifications: bool,
    /// Sent as `Last-Event-ID` so a reconnect only replays newer alerts.
    pub last_event_id: Option<String>,
    /// Recently delivered alert ids, so a replayed alert never notifies twice.
    pub delivered_alerts: Vec<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            server: None,
            endpoint: None,
            login: None,
            notifications: true,
            last_event_id: None,
            delivered_alerts: Vec::new(),
        }
    }
}

#[derive(Debug)]
pub struct SettingsStore {
    dir: PathBuf,
    current: Mutex<Settings>,
}

impl SettingsStore {
    /// Loads `state.json` from `dir`, creating the folder if needed. A file
    /// that cannot be parsed is moved aside to `state.json.corrupt` and
    /// reported, and Poise Link starts unpaired.
    pub fn open(dir: &Path) -> io::Result<Self> {
        fs::create_dir_all(dir)?;
        let path = dir.join(FILE_NAME);
        let settings = match fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice(&bytes) {
                Ok(settings) => settings,
                Err(error) => {
                    let quarantine = dir.join(QUARANTINE_NAME);
                    fs::rename(&path, &quarantine)?;
                    log::error!(
                        "{} could not be read ({error}); moved it to {} and starting unpaired",
                        path.display(),
                        quarantine.display()
                    );
                    Settings::default()
                }
            },
            Err(error) if error.kind() == io::ErrorKind::NotFound => Settings::default(),
            Err(error) => return Err(error),
        };
        Ok(Self {
            dir: dir.to_path_buf(),
            current: Mutex::new(settings),
        })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn get(&self) -> Settings {
        self.lock().clone()
    }

    /// Applies `change` and saves the result before returning.
    pub fn update(&self, change: impl FnOnce(&mut Settings)) -> io::Result<()> {
        let mut current = self.lock();
        let mut next = current.clone();
        change(&mut next);
        if next == *current {
            return Ok(());
        }
        let json = serde_json::to_vec_pretty(&next).map_err(io::Error::other)?;
        fsutil::write_atomically(&self.dir, FILE_NAME, &json, Access::OwnerOnly)?;
        *current = next;
        Ok(())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Settings> {
        // A panic while holding the lock leaves the last saved value intact.
        self.current
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_with_defaults_when_nothing_was_saved() {
        let dir = tempfile::tempdir().unwrap();
        let store = SettingsStore::open(&dir.path().join("nested")).unwrap();
        assert_eq!(store.get(), Settings::default());
        assert!(store.get().notifications);
    }

    #[test]
    fn saves_and_reloads() {
        let dir = tempfile::tempdir().unwrap();
        let store = SettingsStore::open(dir.path()).unwrap();
        store
            .update(|s| {
                s.endpoint = Some("https://octocat.poise.example.com/".into());
                s.notifications = false;
            })
            .unwrap();

        let reopened = SettingsStore::open(dir.path()).unwrap();
        assert_eq!(
            reopened.get().endpoint.as_deref(),
            Some("https://octocat.poise.example.com/")
        );
        assert!(!reopened.get().notifications);
    }

    #[test]
    fn a_corrupt_file_is_moved_aside_not_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(FILE_NAME), b"{ not json").unwrap();

        let store = SettingsStore::open(dir.path()).unwrap();

        assert_eq!(store.get(), Settings::default());
        assert!(!dir.path().join(FILE_NAME).exists());
        assert_eq!(
            fs::read(dir.path().join(QUARANTINE_NAME)).unwrap(),
            b"{ not json"
        );
    }

    #[test]
    fn unknown_and_missing_fields_are_tolerated() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join(FILE_NAME),
            br#"{"login":"octocat","future":1}"#,
        )
        .unwrap();
        let store = SettingsStore::open(dir.path()).unwrap();
        assert_eq!(store.get().login.as_deref(), Some("octocat"));
        assert!(store.get().notifications);
    }
}
