//! Start at login on macOS: a launchd agent that also keeps Poise Link
//! running. launchd starts Poise Link at login, and again whenever it ends
//! other than by Quit: after a crash, or after a signal such as `kill`. Quit
//! exits with status 0, and launchd then leaves it stopped until the next
//! login.
//!
//! launchd restarts only the copy it started itself, so while the agent is
//! installed that copy is the one that runs:
//! - A copy started another way (from the Finder, or by the installer) asks
//!   launchd to start its copy, or asks the copy launchd runs for its window,
//!   and quits ([`arrange`]).
//! - Turning start at login on hands the running copy over to launchd
//!   ([`hand_over`]).
//! - launchd's copy asks any other copy to quit before it takes over
//!   ([`take_over`]).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::Duration;

use crate::fsutil::{self, Access};

/// The agent's label. launchd gives it to the copy it starts as `XPC_SERVICE_NAME`.
pub const LABEL: &str = "com.vaquum.poise.link";
/// The app's bundle identifier, which System Settings shows the agent under.
const BUNDLE_ID: &str = "com.vaquum.poise.link";
/// Passed by the agent, so a start at login stays in the tray.
pub const AUTOSTART_ARG: &str = "--autostart";
/// The login item Poise Link 0.1 wrote: it started Poise Link at login and never again.
pub const LEGACY_FILE_NAME: &str = "Poise Link.plist";
/// Left in the settings folder by a copy the person opened, so that the copy
/// launchd starts in its place shows the window.
pub const WINDOW_REQUEST_FILE_NAME: &str = "show-window";
/// How long launchd's copy waits for another copy to quit, before asking it to and again after.
pub const QUIT_WAIT: Duration = Duration::from_secs(3);
const POLL: Duration = Duration::from_millis(100);
/// How often launchd's copy looks for a window request while it runs.
pub const WINDOW_REQUEST_POLL: Duration = Duration::from_secs(1);
/// `launchctl print` for a service launchd does not know.
const NO_SUCH_SERVICE: i32 = 113;

/// The agent for `program`: launchd starts it with [`AUTOSTART_ARG`] at
/// login, and again whenever it exits with a status other than 0.
pub fn plist(program: &Path) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{LABEL}</string>
  <key>AssociatedBundleIdentifiers</key>
  <array>
    <string>{BUNDLE_ID}</string>
  </array>
  <key>ProgramArguments</key>
  <array>
    <string>{program}</string>
    <string>{AUTOSTART_ARG}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
</dict>
</plist>
"#,
        program = xml_text(&program.to_string_lossy()),
    )
}

fn xml_text(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// The agent's file in a `LaunchAgents` folder.
#[derive(Debug, Clone)]
pub struct LaunchAgent {
    dir: PathBuf,
    program: PathBuf,
}

impl LaunchAgent {
    pub fn new(dir: PathBuf, program: PathBuf) -> Self {
        Self { dir, program }
    }

    /// `~/Library/LaunchAgents`, for this program.
    pub fn for_this_user() -> io::Result<Self> {
        let home = dirs::home_dir()
            .ok_or_else(|| io::Error::other("the operating system reports no home folder"))?;
        Ok(Self::new(
            home.join("Library").join("LaunchAgents"),
            std::env::current_exe()?,
        ))
    }

    pub fn path(&self) -> PathBuf {
        self.dir.join(file_name())
    }

    /// The Poise Link the agent is written for.
    pub fn program(&self) -> &Path {
        &self.program
    }

    /// Start at login is on.
    pub fn installed(&self) -> bool {
        self.path().is_file()
    }

    /// Writes the agent for this program, unless it already says the same,
    /// and removes Poise Link 0.1's login item. launchd reads the file at the
    /// next login, or when it is loaded ([`Launchd::bootstrap`]).
    pub fn install(&self) -> io::Result<()> {
        fs::create_dir_all(&self.dir)?;
        let contents = plist(&self.program);
        if fs::read_to_string(self.path()).ok().as_deref() != Some(contents.as_str()) {
            fsutil::write_atomically(
                &self.dir,
                &file_name(),
                contents.as_bytes(),
                Access::Default,
            )?;
        }
        fsutil::remove_if_present(&self.dir.join(LEGACY_FILE_NAME))
    }

    /// Start at login off. A copy launchd runs keeps running: unloading the
    /// agent would stop it. It is not started at the next login.
    pub fn remove(&self) -> io::Result<()> {
        fsutil::remove_if_present(&self.path())?;
        fsutil::remove_if_present(&self.dir.join(LEGACY_FILE_NAME))
    }

    /// Replaces Poise Link 0.1's login item with the agent, so start at login
    /// stays on. Says whether there was one.
    pub fn migrate(&self) -> io::Result<bool> {
        if !self.dir.join(LEGACY_FILE_NAME).is_file() {
            return Ok(false);
        }
        self.install()?;
        Ok(true)
    }
}

fn file_name() -> String {
    format!("{LABEL}.plist")
}

/// The agent's state in launchd.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Job {
    /// Not loaded: no login has read the file since it was written, and
    /// nothing loaded it.
    NotLoaded,
    /// Loaded as the file was then, for `program`. When its copy does not
    /// run, it was quit, or launchd waits before starting it again.
    Loaded { running: bool, program: PathBuf },
}

impl Job {
    /// launchd's copy of `program` runs.
    pub fn runs(&self, program: &Path) -> bool {
        matches!(self, Job::Loaded { running: true, program: loaded } if loaded == program)
    }
}

/// What Poise Link asks of launchd.
pub trait Launchd {
    fn job(&self) -> Result<Job, String>;
    /// Loads the agent, which starts its copy.
    fn bootstrap(&self, plist: &Path) -> Result<(), String>;
    /// Starts the copy of a loaded agent.
    fn kickstart(&self) -> Result<(), String>;
    /// Unloads the agent, which stops its copy.
    fn bootout(&self) -> Result<(), String>;
}

/// `launchctl`, in the person's login session.
pub struct Launchctl {
    domain: String,
}

impl Launchctl {
    pub fn for_this_user() -> Self {
        Self {
            domain: format!("gui/{}", user_id()),
        }
    }

    fn service(&self) -> String {
        format!("{}/{LABEL}", self.domain)
    }

    fn run(&self, args: &[&str]) -> Result<Output, String> {
        Command::new("/bin/launchctl")
            .args(args)
            .output()
            .map_err(|error| format!("could not run launchctl: {error}"))
    }

    fn succeed(&self, args: &[&str]) -> Result<(), String> {
        let output = self.run(args)?;
        if output.status.success() {
            Ok(())
        } else {
            Err(failure(args[0], &output))
        }
    }
}

impl Launchd for Launchctl {
    fn job(&self) -> Result<Job, String> {
        let output = self.run(&["print", &self.service()])?;
        match output.status.code() {
            Some(0) => Ok(job_state(&String::from_utf8_lossy(&output.stdout))),
            Some(NO_SUCH_SERVICE) => Ok(Job::NotLoaded),
            _ => Err(failure("print", &output)),
        }
    }

    fn bootstrap(&self, plist: &Path) -> Result<(), String> {
        self.succeed(&["bootstrap", &self.domain, &plist.to_string_lossy()])
    }

    fn kickstart(&self) -> Result<(), String> {
        self.succeed(&["kickstart", &self.service()])
    }

    fn bootout(&self) -> Result<(), String> {
        self.succeed(&["bootout", &self.service()])
    }
}

fn failure(command: &str, output: &Output) -> String {
    format!(
        "launchctl {command} answered {}: {}",
        output.status,
        String::from_utf8_lossy(&output.stderr).trim()
    )
}

/// A loaded service as `launchctl print` reports it: its top-level `program`
/// line, and a `state = running` line while its copy runs.
pub fn job_state(print: &str) -> Job {
    Job::Loaded {
        running: print.lines().any(|line| line == "\tstate = running"),
        program: print
            .lines()
            .find_map(|line| line.strip_prefix("\tprogram = "))
            .map(PathBuf::from)
            .unwrap_or_default(),
    }
}

fn user_id() -> u32 {
    // SAFETY: getuid has no preconditions and cannot fail.
    unsafe { libc::getuid() }
}

/// Something for Poise Link's log. A start is arranged before the log is set
/// up, so its notes are logged once it is.
pub type Note = (log::Level, String);

/// The other running copies of Poise Link of this person.
pub trait Copies {
    fn others(&self) -> Result<Vec<u32>, String>;
    fn ask_to_quit(&self, pid: u32) -> Result<(), String>;
}

/// The processes of this person that run this program.
pub struct Processes;

impl Copies for Processes {
    fn others(&self) -> Result<Vec<u32>, String> {
        let name = std::env::current_exe()
            .ok()
            .and_then(|path| {
                path.file_name()
                    .map(|name| name.to_string_lossy().into_owned())
            })
            .ok_or("could not tell this program's name, to find its other copies")?;
        let output = Command::new("/usr/bin/pgrep")
            .args(["-x", "-U", &user_id().to_string(), &name])
            .output()
            .map_err(|error| format!("could not list the running copies of Poise Link: {error}"))?;
        let own = std::process::id();
        Ok(String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| line.trim().parse().ok())
            .filter(|pid| *pid != own)
            .collect())
    }

    fn ask_to_quit(&self, pid: u32) -> Result<(), String> {
        let process =
            libc::pid_t::try_from(pid).map_err(|_| format!("{pid} is not a process ID"))?;
        // SAFETY: kill only sends a signal; the process is this person's own copy of Poise Link.
        if unsafe { libc::kill(process, libc::SIGTERM) } != 0 {
            return Err(format!(
                "could not ask Poise Link {pid} to quit: {}",
                io::Error::last_os_error()
            ));
        }
        Ok(())
    }
}

/// How a start of Poise Link goes on, decided before its tray or window exist.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Start {
    /// This process runs Poise Link.
    Here,
    /// launchd starts its copy instead, and this process quits.
    HandedOver,
}

/// An arranged start, with what to log about it once the log exists.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Arranged {
    pub start: Start,
    pub notes: Vec<Note>,
}

impl From<Start> for Arranged {
    fn from(start: Start) -> Self {
        Self {
            start,
            notes: Vec::new(),
        }
    }
}

/// The start being arranged.
pub struct Arrangement<'a> {
    pub agent: &'a LaunchAgent,
    pub launchd: &'a dyn Launchd,
    pub copies: &'a dyn Copies,
    /// launchd started this copy.
    pub by_launchd: bool,
    /// The person opened Poise Link, rather than start at login: its window shows.
    pub show_window: bool,
    /// Poise Link's settings folder.
    pub settings_dir: &'a Path,
    pub sleep: &'a dyn Fn(Duration),
}

/// Decides who runs Poise Link while start at login is on: always the copy
/// launchd started, which launchd restarts. Any other start hands over to it.
pub fn arrange(start: &Arrangement) -> Result<Arranged, String> {
    start
        .agent
        .migrate()
        .map_err(|error| format!("could not replace Poise Link 0.1's login item: {error}"))?;
    if start.by_launchd {
        return Ok(Arranged {
            start: Start::Here,
            notes: take_over(start.copies, start.sleep),
        });
    }
    if !start.agent.installed() {
        return Ok(Start::Here.into());
    }
    // A Poise Link opened from another place than the agent names (moved, or
    // installed elsewhere) is the one that runs from now on.
    start.agent.install().map_err(|error| {
        format!(
            "could not point the launch agent at {}: {error}",
            start.agent.program().display()
        )
    })?;
    let job = start.launchd.job()?;
    if job.runs(start.agent.program()) {
        // launchd's copy may still be starting, before it listens for a
        // second launch: never run beside it. It looks for the request every
        // second, and as it starts.
        if start.show_window {
            request_window(start.settings_dir).map_err(|error| {
                format!("could not ask launchd's copy to show its window: {error}")
            })?;
        }
        return Ok(Start::HandedOver.into());
    }
    if start.show_window {
        request_window(start.settings_dir)
            .map_err(|error| format!("could not ask launchd's copy to show its window: {error}"))?;
    }
    if let Err(error) = start_job(start.agent, start.launchd, &job) {
        // This process runs Poise Link after all, and shows its own window.
        take_window_request(start.settings_dir);
        return Err(error);
    }
    Ok(Start::HandedOver.into())
}

/// Start at login was turned on in a copy launchd did not start: launchd
/// starts its copy, which takes over from this one. The caller then quits.
pub fn hand_over(agent: &LaunchAgent, launchd: &dyn Launchd) -> Result<(), String> {
    start_job(agent, launchd, &launchd.job()?)
}

fn start_job(agent: &LaunchAgent, launchd: &dyn Launchd, job: &Job) -> Result<(), String> {
    match job {
        Job::NotLoaded => launchd.bootstrap(&agent.path()),
        // Loaded for a Poise Link in another place: loading the agent again,
        // as it is now, stops that copy and starts this one.
        Job::Loaded { program, .. } if program != agent.program() => {
            launchd.bootout()?;
            launchd.bootstrap(&agent.path())
        }
        Job::Loaded { running: false, .. } => launchd.kickstart(),
        Job::Loaded { running: true, .. } => Ok(()),
    }
}

/// launchd's copy takes over from any other copy. A copy handing over quits
/// at once; any other is asked to (SIGTERM) after [`QUIT_WAIT`]. Says what
/// happened, for the log.
pub fn take_over(copies: &dyn Copies, sleep: &dyn Fn(Duration)) -> Vec<Note> {
    let mut notes = Vec::new();
    if wait_until_alone(copies, sleep, &mut notes) {
        return notes;
    }
    match copies.others() {
        Ok(others) => {
            for pid in others {
                notes.push(match copies.ask_to_quit(pid) {
                    Ok(()) => (
                        log::Level::Warn,
                        format!("asked Poise Link {pid}, which launchd did not start, to quit"),
                    ),
                    Err(error) => (log::Level::Warn, error),
                });
            }
        }
        Err(error) => notes.push((log::Level::Warn, error)),
    }
    if !wait_until_alone(copies, sleep, &mut notes) {
        notes.push((
            log::Level::Error,
            "another copy of Poise Link is still running".to_owned(),
        ));
    }
    notes
}

fn wait_until_alone(copies: &dyn Copies, sleep: &dyn Fn(Duration), notes: &mut Vec<Note>) -> bool {
    for _ in 0..QUIT_WAIT.as_millis() / POLL.as_millis() {
        if alone(copies, notes) {
            return true;
        }
        sleep(POLL);
    }
    alone(copies, notes)
}

/// No other copy runs. When the copies cannot be listed there is no one to
/// wait for; the single-instance plugin still keeps a second copy from running.
fn alone(copies: &dyn Copies, notes: &mut Vec<Note>) -> bool {
    match copies.others() {
        Ok(others) => others.is_empty(),
        Err(error) => {
            notes.push((log::Level::Warn, error));
            true
        }
    }
}

/// Asks the copy launchd starts next to show its window.
pub fn request_window(settings_dir: &Path) -> io::Result<()> {
    fs::create_dir_all(settings_dir)?;
    fs::write(settings_dir.join(WINDOW_REQUEST_FILE_NAME), b"")
}

/// Whether a copy the person opened asked this one to show its window. The
/// request is used up. launchd's copy looks when it starts and every
/// [`WINDOW_REQUEST_POLL`] after.
pub fn take_window_request(settings_dir: &Path) -> bool {
    fs::remove_file(settings_dir.join(WINDOW_REQUEST_FILE_NAME)).is_ok()
}

/// launchd started this process as the agent.
pub fn by_launchd() -> bool {
    std::env::var("XPC_SERVICE_NAME").is_ok_and(|name| name == LABEL)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    const PROGRAM: &str = "/Applications/Poise Link.app/Contents/MacOS/poise-link";
    const ELSEWHERE: &str = "/Users/someone/Applications/Poise Link.app/Contents/MacOS/poise-link";

    /// The agent loaded for this Poise Link, or for one in another place.
    fn loaded(running: bool) -> Job {
        Job::Loaded {
            running,
            program: PathBuf::from(PROGRAM),
        }
    }

    fn loaded_elsewhere(running: bool) -> Job {
        Job::Loaded {
            running,
            program: PathBuf::from(ELSEWHERE),
        }
    }

    #[derive(Default)]
    struct FakeLaunchd {
        job: RefCell<Option<Job>>,
        fails: Cell<bool>,
        calls: RefCell<Vec<String>>,
    }

    impl FakeLaunchd {
        fn with(job: Job) -> Self {
            let launchd = Self::default();
            launchd.job.replace(Some(job));
            launchd
        }

        fn calls(&self) -> Vec<String> {
            self.calls.borrow().clone()
        }
    }

    impl Launchd for FakeLaunchd {
        fn job(&self) -> Result<Job, String> {
            self.calls.borrow_mut().push("print".to_owned());
            self.job
                .borrow()
                .clone()
                .ok_or_else(|| "launchctl print failed".to_owned())
        }

        fn bootstrap(&self, plist: &Path) -> Result<(), String> {
            self.calls
                .borrow_mut()
                .push(format!("bootstrap {}", plist.display()));
            if self.fails.get() {
                return Err("launchctl bootstrap failed".to_owned());
            }
            // The agent on disk names this program: the fixtures write it so.
            self.job.replace(Some(loaded(true)));
            Ok(())
        }

        fn kickstart(&self) -> Result<(), String> {
            self.calls.borrow_mut().push("kickstart".to_owned());
            if self.fails.get() {
                return Err("launchctl kickstart failed".to_owned());
            }
            let mut job = self.job.borrow_mut();
            if let Some(Job::Loaded { running, .. }) = job.as_mut() {
                *running = true;
            }
            Ok(())
        }

        fn bootout(&self) -> Result<(), String> {
            self.calls.borrow_mut().push("bootout".to_owned());
            self.job.replace(Some(Job::NotLoaded));
            Ok(())
        }
    }

    /// Other copies, each quitting after being listed `lasts` more times, or
    /// when asked to quit if it obeys.
    #[derive(Default)]
    struct FakeCopies {
        running: RefCell<Vec<(u32, u32)>>,
        obeys: bool,
        /// pgrep fails.
        unlisted: bool,
        asked: RefCell<Vec<u32>>,
    }

    impl FakeCopies {
        fn running(copies: &[(u32, u32)], obeys: bool) -> Self {
            Self {
                running: RefCell::new(copies.to_vec()),
                obeys,
                ..Self::default()
            }
        }
    }

    impl Copies for FakeCopies {
        fn others(&self) -> Result<Vec<u32>, String> {
            if self.unlisted {
                return Err("pgrep failed".to_owned());
            }
            let mut running = self.running.borrow_mut();
            running.retain(|(_, lasts)| *lasts > 0);
            for (_, lasts) in running.iter_mut() {
                *lasts -= 1;
            }
            Ok(running.iter().map(|(pid, _)| *pid).collect())
        }

        fn ask_to_quit(&self, pid: u32) -> Result<(), String> {
            self.asked.borrow_mut().push(pid);
            if self.obeys {
                self.running
                    .borrow_mut()
                    .retain(|(running, _)| *running != pid);
            }
            Ok(())
        }
    }

    struct Fixture {
        _dir: tempfile::TempDir,
        agents: PathBuf,
        settings: PathBuf,
        agent: LaunchAgent,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let agents = dir.path().join("LaunchAgents");
        let settings = dir.path().join("com.vaquum.poise.link");
        let agent = LaunchAgent::new(agents.clone(), PathBuf::from(PROGRAM));
        Fixture {
            _dir: dir,
            agents,
            settings,
            agent,
        }
    }

    fn arrange_with(
        fixture: &Fixture,
        launchd: &FakeLaunchd,
        copies: &FakeCopies,
        by_launchd: bool,
        show_window: bool,
    ) -> Result<Start, String> {
        arranged(fixture, launchd, copies, by_launchd, show_window).map(|arranged| arranged.start)
    }

    fn arranged(
        fixture: &Fixture,
        launchd: &FakeLaunchd,
        copies: &FakeCopies,
        by_launchd: bool,
        show_window: bool,
    ) -> Result<Arranged, String> {
        arrange(&Arrangement {
            agent: &fixture.agent,
            launchd,
            copies,
            by_launchd,
            show_window,
            settings_dir: &fixture.settings,
            sleep: &|_| {},
        })
    }

    #[test]
    fn the_agent_restarts_poise_link_unless_it_exits_with_status_0() {
        let plist = plist(Path::new(
            "/Applications/Poise Link.app/Contents/MacOS/poise-link",
        ));
        for line in [
            "<string>com.vaquum.poise.link</string>",
            "<string>/Applications/Poise Link.app/Contents/MacOS/poise-link</string>\n    <string>--autostart</string>",
            "<key>RunAtLoad</key>\n  <true/>",
            "<key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>\n  </dict>",
            "<key>LimitLoadToSessionType</key>\n  <string>Aqua</string>",
        ] {
            assert!(plist.contains(line), "{line} missing from\n{plist}");
        }
    }

    #[test]
    fn system_settings_shows_the_agent_under_the_app() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(config["identifier"], BUNDLE_ID);
    }

    #[test]
    fn the_agent_escapes_its_program_path() {
        let plist = plist(Path::new("/Users/a&b/<Apps>/poise-link"));
        assert!(plist.contains("<string>/Users/a&amp;b/&lt;Apps&gt;/poise-link</string>"));
    }

    #[test]
    fn installing_writes_the_agent_and_removes_the_old_login_item() {
        let fixture = fixture();
        fs::create_dir_all(&fixture.agents).unwrap();
        fs::write(fixture.agents.join(LEGACY_FILE_NAME), "old").unwrap();
        fixture.agent.install().unwrap();
        assert_eq!(
            fs::read_to_string(fixture.agents.join("com.vaquum.poise.link.plist")).unwrap(),
            plist(Path::new(
                "/Applications/Poise Link.app/Contents/MacOS/poise-link"
            ))
        );
        assert!(!fixture.agents.join(LEGACY_FILE_NAME).exists());
        assert!(fixture.agent.installed());

        fixture.agent.remove().unwrap();
        assert!(!fixture.agent.installed());
        assert_eq!(fs::read_dir(&fixture.agents).unwrap().count(), 0);
    }

    #[test]
    fn the_old_login_item_becomes_the_agent_and_nothing_else_does() {
        let fixture = fixture();
        assert!(!fixture.agent.migrate().unwrap());
        assert!(!fixture.agent.installed());

        fs::create_dir_all(&fixture.agents).unwrap();
        fs::write(fixture.agents.join(LEGACY_FILE_NAME), "old").unwrap();
        assert!(fixture.agent.migrate().unwrap());
        assert!(fixture.agent.installed());
        assert!(!fixture.agents.join(LEGACY_FILE_NAME).exists());
    }

    #[test]
    fn without_start_at_login_poise_link_runs_wherever_it_was_opened() {
        let fixture = fixture();
        let launchd = FakeLaunchd::with(Job::NotLoaded);
        let start = arrange_with(&fixture, &launchd, &FakeCopies::default(), false, true);
        assert_eq!(start, Ok(Start::Here));
        assert!(launchd.calls().is_empty());
    }

    #[test]
    fn a_copy_opened_by_the_person_has_launchd_start_its_own_and_show_the_window() {
        for (job, call) in [(Job::NotLoaded, "bootstrap"), (loaded(false), "kickstart")] {
            let fixture = fixture();
            fixture.agent.install().unwrap();
            let launchd = FakeLaunchd::with(job.clone());
            let start = arrange_with(&fixture, &launchd, &FakeCopies::default(), false, true);
            assert_eq!(start, Ok(Start::HandedOver), "{job:?}");
            assert!(
                launchd.calls()[1].starts_with(call),
                "{job:?}: {:?}",
                launchd.calls()
            );
            if job == Job::NotLoaded {
                assert_eq!(
                    launchd.calls()[1],
                    format!("bootstrap {}", fixture.agent.path().display())
                );
            }
            // launchd's copy finds the request when it starts.
            assert!(take_window_request(&fixture.settings));
            assert!(!take_window_request(&fixture.settings));
        }
    }

    #[test]
    fn a_start_at_login_by_an_old_login_item_hands_over_without_a_window() {
        let fixture = fixture();
        fs::create_dir_all(&fixture.agents).unwrap();
        fs::write(fixture.agents.join(LEGACY_FILE_NAME), "old").unwrap();
        let launchd = FakeLaunchd::with(Job::NotLoaded);
        let start = arrange_with(&fixture, &launchd, &FakeCopies::default(), false, false);
        assert_eq!(start, Ok(Start::HandedOver));
        assert!(fixture.agent.installed());
        assert!(!take_window_request(&fixture.settings));
    }

    #[test]
    fn a_copy_opened_while_launchds_runs_asks_it_for_its_window_and_quits() {
        // Never runs beside launchd's copy, which may still be starting and taking over.
        let fixture = fixture();
        fixture.agent.install().unwrap();
        let launchd = FakeLaunchd::with(loaded(true));
        let start = arrange_with(&fixture, &launchd, &FakeCopies::default(), false, true);
        assert_eq!(start, Ok(Start::HandedOver));
        assert_eq!(launchd.calls(), ["print"]);
        assert!(take_window_request(&fixture.settings));
    }

    #[test]
    fn a_start_at_login_while_launchds_copy_runs_quits_without_a_window() {
        let fixture = fixture();
        fixture.agent.install().unwrap();
        let launchd = FakeLaunchd::with(loaded(true));
        let start = arrange_with(&fixture, &launchd, &FakeCopies::default(), false, false);
        assert_eq!(start, Ok(Start::HandedOver));
        assert!(!take_window_request(&fixture.settings));
    }

    #[test]
    fn when_launchd_cannot_start_its_copy_this_one_runs_and_shows_its_own_window() {
        let fixture = fixture();
        fixture.agent.install().unwrap();
        let launchd = FakeLaunchd::with(loaded(false));
        launchd.fails.set(true);
        let start = arrange_with(&fixture, &launchd, &FakeCopies::default(), false, true);
        assert_eq!(start, Err("launchctl kickstart failed".to_owned()));
        assert!(!take_window_request(&fixture.settings));
    }

    #[test]
    fn launchds_copy_waits_for_a_copy_that_hands_over() {
        let fixture = fixture();
        fixture.agent.install().unwrap();
        let launchd = FakeLaunchd::with(loaded(true));
        let copies = FakeCopies::running(&[(41, 5)], true);
        let arranged = arranged(&fixture, &launchd, &copies, true, false);
        assert_eq!(arranged, Ok(Start::Here.into()));
        assert!(copies.asked.borrow().is_empty());
        assert_eq!(copies.others(), Ok(Vec::new()));
        assert!(launchd.calls().is_empty());
    }

    #[test]
    fn what_launchds_copy_did_to_take_over_reaches_the_log() {
        // The start is arranged before the log is set up: the caller logs these once it is.
        let fixture = fixture();
        let copies = FakeCopies::running(&[(41, u32::MAX)], false);
        let arranged = arranged(&fixture, &FakeLaunchd::default(), &copies, true, false).unwrap();
        assert_eq!(arranged.start, Start::Here);
        assert_eq!(
            arranged.notes,
            [
                (
                    log::Level::Warn,
                    "asked Poise Link 41, which launchd did not start, to quit".to_owned()
                ),
                (
                    log::Level::Error,
                    "another copy of Poise Link is still running".to_owned()
                ),
            ]
        );
    }

    #[test]
    fn launchds_copy_runs_when_the_copies_cannot_be_listed_and_says_so() {
        let copies = FakeCopies {
            unlisted: true,
            ..FakeCopies::default()
        };
        let notes = take_over(&copies, &|_| {});
        assert_eq!(notes, [(log::Level::Warn, "pgrep failed".to_owned())]);
        assert!(copies.asked.borrow().is_empty());
    }

    #[test]
    fn launchds_copy_asks_a_copy_that_stays_to_quit() {
        let copies = FakeCopies::running(&[(41, u32::MAX), (42, u32::MAX)], true);
        let slept = Cell::new(Duration::ZERO);
        let notes = take_over(&copies, &|delay| slept.set(slept.get() + delay));
        assert_eq!(*copies.asked.borrow(), [41, 42]);
        assert_eq!(copies.others(), Ok(Vec::new()));
        assert_eq!(slept.get(), QUIT_WAIT);
        assert_eq!(notes.len(), 2);
        assert!(notes.iter().all(|(level, _)| *level == log::Level::Warn));
    }

    #[test]
    fn launchds_copy_gives_up_waiting_on_a_copy_that_will_not_quit() {
        let copies = FakeCopies::running(&[(41, u32::MAX)], false);
        let slept = Cell::new(Duration::ZERO);
        let notes = take_over(&copies, &|delay| slept.set(slept.get() + delay));
        assert_eq!(*copies.asked.borrow(), [41]);
        assert_eq!(slept.get(), QUIT_WAIT * 2);
        assert_eq!(
            notes.last().map(|(level, _)| *level),
            Some(log::Level::Error)
        );
    }

    #[test]
    fn turning_start_at_login_on_hands_the_running_copy_to_launchd() {
        let fixture = fixture();
        fixture.agent.install().unwrap();
        let bootstrap = format!("bootstrap {}", fixture.agent.path().display());
        for (job, calls) in [
            (Job::NotLoaded, vec!["print", &bootstrap]),
            (loaded(false), vec!["print", "kickstart"]),
            (loaded(true), vec!["print"]),
            // Loaded for a Poise Link in another place: reloaded for this one.
            (
                loaded_elsewhere(false),
                vec!["print", "bootout", &bootstrap],
            ),
        ] {
            let launchd = FakeLaunchd::with(job.clone());
            assert_eq!(hand_over(&fixture.agent, &launchd), Ok(()), "{job:?}");
            assert_eq!(launchd.calls(), calls, "{job:?}");
        }
    }

    #[test]
    fn a_poise_link_opened_from_another_place_takes_the_agent_over() {
        for job in [loaded_elsewhere(true), loaded_elsewhere(false)] {
            let fixture = fixture();
            // Installed elsewhere first, or moved since: the agent names that copy.
            LaunchAgent::new(fixture.agents.clone(), PathBuf::from(ELSEWHERE))
                .install()
                .unwrap();
            let launchd = FakeLaunchd::with(job.clone());
            let start = arrange_with(&fixture, &launchd, &FakeCopies::default(), false, true);
            assert_eq!(start, Ok(Start::HandedOver), "{job:?}");
            assert_eq!(
                launchd.calls(),
                [
                    "print".to_owned(),
                    "bootout".to_owned(),
                    format!("bootstrap {}", fixture.agent.path().display()),
                ],
                "{job:?}"
            );
            assert_eq!(
                fs::read_to_string(fixture.agent.path()).unwrap(),
                plist(Path::new(PROGRAM)),
                "{job:?}"
            );
            assert!(take_window_request(&fixture.settings), "{job:?}");
        }
    }

    #[test]
    fn launchctl_print_tells_which_copy_is_loaded_and_whether_it_runs() {
        let running = "gui/501/com.vaquum.poise.link = {\n\tactive count = 1\n\tpath = /Users/me/Library/LaunchAgents/com.vaquum.poise.link.plist\n\tstate = running\n\n\tprogram = /Applications/Poise Link.app/Contents/MacOS/poise-link\n\targuments = {\n\t\t/Applications/Poise Link.app/Contents/MacOS/poise-link\n\t\t--autostart\n\t}\n\tpid = 501\n\tendpoints = {\n\t\tstate = active\n\t}\n}\n";
        let stopped = "gui/501/com.vaquum.poise.link = {\n\tactive count = 0\n\tstate = not running\n\n\tprogram = /Users/someone/Applications/Poise Link.app/Contents/MacOS/poise-link\n\tendpoints = {\n\t\tstate = active\n\t}\n}\n";
        assert_eq!(job_state(running), loaded(true));
        assert_eq!(job_state(stopped), loaded_elsewhere(false));
        assert!(job_state(running).runs(Path::new(PROGRAM)));
        assert!(!job_state(stopped).runs(Path::new(ELSEWHERE)));
    }
}
