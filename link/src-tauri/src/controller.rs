//! The core of Poise Link, without any user interface: pairing, the paired
//! session, and leaving it. The desktop app and the tests drive it the same way.
//!
//! Methods that start work spawn Tokio tasks, so call them from within a
//! Tokio runtime. [`Controller::start`] and [`Controller::sign_out`] use the
//! credential store, which can wait on the person (an unlock prompt), so the
//! desktop app calls them off its event loop.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, Weak};

use reqwest::{Client, Url};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;

use crate::connection::{self, Ended, Timing};
use crate::credentials::{Saved, SecretStore, TokenStore};
use crate::duties::{self, Context, snippets::espanso::Locator};
use crate::http;
use crate::link_api::LinkApi;
use crate::pairing::{self, PairingError};
use crate::platform::{Autostart, Browser, Notice, Notifier};
use crate::settings::SettingsStore;
use crate::status::{Connection, Snippets, Status, StatusHandle};

/// The operating-system services the core uses.
pub struct Platform {
    pub secrets: Box<dyn SecretStore>,
    pub notifier: Arc<dyn Notifier>,
    pub browser: Arc<dyn Browser>,
    pub autostart: Arc<dyn Autostart>,
    pub espanso: Locator,
}

struct Session {
    task: JoinHandle<()>,
    sync_now: mpsc::UnboundedSender<()>,
}

pub struct Controller {
    http: Client,
    config_dir: PathBuf,
    tokens: Arc<TokenStore>,
    settings: Arc<SettingsStore>,
    status: StatusHandle,
    notifier: Arc<dyn Notifier>,
    browser: Arc<dyn Browser>,
    autostart: Arc<dyn Autostart>,
    espanso: Arc<Locator>,
    timing: Timing,
    session: Mutex<Option<Session>>,
    pairing: Mutex<Option<JoinHandle<()>>>,
}

impl Controller {
    /// Loads the saved settings from `config_dir`. Nothing runs until
    /// [`Controller::start`] or [`Controller::pair`].
    pub fn new(platform: Platform, config_dir: &Path, timing: Timing) -> io::Result<Arc<Self>> {
        let settings = Arc::new(SettingsStore::open(config_dir)?);
        let saved = settings.get();
        let status = StatusHandle::new(Status {
            connection: Connection::SignedOut { reason: None },
            snippets: Snippets::NotSynced,
            server: saved.server,
            endpoint: saved.endpoint,
            login: saved.login,
            notifications: saved.notifications,
        });
        Ok(Arc::new(Self {
            http: http::client().map_err(io::Error::other)?,
            config_dir: config_dir.to_path_buf(),
            tokens: Arc::new(TokenStore::new(platform.secrets, config_dir)),
            settings,
            status,
            notifier: platform.notifier,
            browser: platform.browser,
            autostart: platform.autostart,
            espanso: Arc::new(platform.espanso),
            timing,
            session: Mutex::new(None),
            pairing: Mutex::new(None),
        }))
    }

    pub fn status(&self) -> Status {
        self.status.get()
    }

    pub fn subscribe(&self) -> watch::Receiver<Status> {
        self.status.subscribe()
    }

    /// Resumes the saved pairing, if there is one. Returns whether it did.
    pub fn start(self: &Arc<Self>) -> bool {
        let saved = self.settings.get();
        let Some(endpoint) = saved.endpoint.as_deref() else {
            return false;
        };
        let endpoint = match Url::parse(endpoint) {
            Ok(endpoint) => endpoint,
            Err(error) => {
                self.signed_out(Some(format!(
                    "The saved workspace address {endpoint:?} is invalid ({error}); pair again."
                )));
                return false;
            }
        };
        match self.tokens.load() {
            Ok(Some(token)) => {
                self.start_session(endpoint, token);
                true
            }
            Ok(None) => {
                self.signed_out(Some("The device token is missing; pair again.".to_owned()));
                false
            }
            Err(error) => {
                log::error!("{error}");
                self.signed_out(Some(format!("{error}.")));
                false
            }
        }
    }

    /// Checks `server` and runs pairing in the background, reporting progress
    /// and failures through the status.
    pub fn begin_pairing(self: &Arc<Self>, server: &str) -> Result<(), PairingError> {
        let server = pairing::parse_server_address(server)?;
        let this = Arc::clone(self);
        let task = tokio::spawn(async move {
            if let Err(error) = this.pair(server).await {
                log::warn!("pairing failed: {error}");
                this.signed_out(Some(capitalize(&error.to_string())));
            }
        });
        if let Some(previous) = self.lock_pairing().replace(task) {
            previous.abort();
        }
        Ok(())
    }

    pub fn cancel_pairing(&self) {
        if let Some(task) = self.lock_pairing().take() {
            task.abort();
        }
        if matches!(self.status.get().connection, Connection::Pairing { .. }) {
            self.signed_out(None);
        }
    }

    /// The whole first-run flow: device code, confirmation in the browser,
    /// token into the credential store, start at login, then the session.
    pub async fn pair(self: &Arc<Self>, server: Url) -> Result<(), PairingError> {
        self.stop_session();
        let server_text = server.to_string();
        self.status.update(|status| {
            status.connection = Connection::Pairing {
                user_code: None,
                verification_uri: None,
            };
            status.server = Some(server_text.clone());
        });
        self.save_settings(|settings| settings.server = Some(server_text))?;

        let code = pairing::request_code(&self.http, &server).await?;
        self.status.set_connection(Connection::Pairing {
            user_code: Some(code.user_code.clone()),
            verification_uri: Some(code.verification_uri.to_string()),
        });
        if let Err(error) = self.browser.open(&code.verification_uri) {
            // The window shows the address and code, so the person can still open it themselves.
            log::warn!(
                "could not open {} in the browser: {error}",
                code.verification_uri
            );
        }

        let paired =
            pairing::wait_for_token(&self.http, &server, &code, tokio::time::sleep).await?;

        let tokens = Arc::clone(&self.tokens);
        let token = paired.access_token.clone();
        let saved = tokio::task::spawn_blocking(move || tokens.save(&token))
            .await
            .map_err(|error| PairingError::Storage(error.to_string()))?;
        match saved {
            Ok(Saved::CredentialStore) => {}
            Ok(Saved::File(path)) => log::warn!("device token kept in {}", path.display()),
            Err(error) => return Err(PairingError::Storage(error.to_string())),
        }
        let endpoint = paired.endpoint.to_string();
        self.save_settings(|settings| {
            settings.endpoint = Some(endpoint.clone());
            settings.login = Some(paired.login.clone());
            settings.last_event_id = None;
            settings.delivered_alerts.clear();
        })?;
        self.status.update(|status| {
            status.endpoint = Some(endpoint);
            status.login = Some(paired.login.clone());
        });
        if let Err(error) = self.autostart.enable() {
            log::error!("could not turn on start at login: {error}");
        }
        self.start_session(paired.endpoint.clone(), paired.access_token);
        self.notifier.notify(Notice {
            title: "Poise Link is paired".to_owned(),
            body: format!(
                "Signed in as {}. Snippets and alerts now come from {}. Poise Link keeps running in the menu bar or system tray.",
                paired.login, paired.endpoint
            ),
            url: None,
        });
        Ok(())
    }

    pub fn sync_now(&self) {
        if let Some(session) = self.lock_session().as_ref()
            && session.sync_now.send(()).is_err()
        {
            log::error!("sync requested, but the session has stopped");
        }
    }

    pub fn set_notifications(&self, on: bool) -> io::Result<()> {
        self.settings
            .update(|settings| settings.notifications = on)?;
        self.status.update(|status| status.notifications = on);
        Ok(())
    }

    pub fn set_autostart(&self, on: bool) -> Result<(), String> {
        if on {
            self.autostart.enable()
        } else {
            self.autostart.disable()
        }
    }

    pub fn autostart_enabled(&self) -> Result<bool, String> {
        self.autostart.is_enabled()
    }

    /// Opens the person's workspace in the browser.
    pub fn open_poise(&self) -> Result<(), String> {
        let endpoint = self
            .status
            .get()
            .endpoint
            .ok_or("Poise Link is not paired")?;
        let url = Url::parse(&endpoint).map_err(|error| error.to_string())?;
        self.browser.open(&url)
    }

    /// Opens the pairing confirmation page again.
    pub fn open_verification(&self) -> Result<(), String> {
        match self.status.get().connection {
            Connection::Pairing {
                verification_uri: Some(uri),
                ..
            } => self
                .browser
                .open(&Url::parse(&uri).map_err(|error| error.to_string())?),
            _ => Err("no pairing is waiting for confirmation".to_owned()),
        }
    }

    /// Forgets the pairing on this computer. The device stays listed in
    /// Poise until it is revoked there.
    pub fn sign_out(&self) -> io::Result<()> {
        self.stop_session();
        // Signed out here even if the credential store fails; the caller still gets its error.
        let forgotten = self.forget_pairing();
        self.signed_out(None);
        forgotten
    }

    fn start_session(self: &Arc<Self>, endpoint: Url, token: String) {
        self.stop_session();
        let context = Context {
            api: LinkApi::new(self.http.clone(), endpoint, token),
            settings: Arc::clone(&self.settings),
            status: self.status.clone(),
            notifier: Arc::clone(&self.notifier),
        };
        let duties = duties::standard(
            Arc::clone(&self.espanso),
            self.config_dir.clone(),
            self.timing.snippet_interval,
        );
        let (sync_now, sync_requests) = mpsc::unbounded_channel();
        let timing = self.timing.clone();
        let this: Weak<Self> = Arc::downgrade(self);
        let task = tokio::spawn(async move {
            match connection::run(context, duties, timing, sync_requests).await {
                Ended::Revoked => {
                    if let Some(controller) = this.upgrade() {
                        controller.revoked().await;
                    }
                }
            }
        });
        *self.lock_session() = Some(Session { task, sync_now });
    }

    fn stop_session(&self) {
        if let Some(session) = self.lock_session().take() {
            session.task.abort();
        }
    }

    /// The workspace no longer accepts this device: it was revoked in Poise.
    async fn revoked(self: Arc<Self>) {
        // Runs inside the session's own task, which is ending: release it without aborting.
        self.lock_session().take();
        log::warn!("the workspace no longer accepts this device; signing out");
        let this = Arc::clone(&self);
        match tokio::task::spawn_blocking(move || this.forget_pairing()).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => log::error!("could not forget the revoked pairing: {error}"),
            Err(error) => log::error!("could not forget the revoked pairing: {error}"),
        }
        self.signed_out(Some(
            "This device was signed out of Poise. Pair it again to continue.".to_owned(),
        ));
        self.notifier.notify(Notice {
            title: "Poise Link was signed out".to_owned(),
            body: "This device is no longer paired with Poise. Open Poise Link to pair it again."
                .to_owned(),
            url: None,
        });
    }

    fn forget_pairing(&self) -> io::Result<()> {
        let tokens = self.tokens.clear();
        self.settings.update(|settings| {
            settings.endpoint = None;
            settings.login = None;
            settings.last_event_id = None;
            settings.delivered_alerts.clear();
        })?;
        tokens
    }

    fn signed_out(&self, reason: Option<String>) {
        self.status.update(|status| {
            status.connection = Connection::SignedOut { reason };
            status.endpoint = None;
            status.login = None;
            status.snippets = Snippets::NotSynced;
        });
    }

    fn save_settings(
        &self,
        change: impl FnOnce(&mut crate::settings::Settings),
    ) -> Result<(), PairingError> {
        self.settings
            .update(change)
            .map_err(|error| PairingError::Storage(format!("could not save settings: {error}")))
    }

    fn lock_session(&self) -> MutexGuard<'_, Option<Session>> {
        self.session
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn lock_pairing(&self) -> MutexGuard<'_, Option<JoinHandle<()>>> {
        self.pairing
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn capitalize(message: &str) -> String {
    let mut chars = message.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}
