//! Start at login on macOS: a launchd agent that also keeps Poise Link
//! running. launchd starts Poise Link at login, and again whenever it ends
//! other than by Quit: after a crash, or after a signal such as `kill`. Quit
//! exits with status 0, and launchd then leaves it stopped until the next
//! login.
//!
//! launchd restarts only the copy it started itself, so while the agent is
//! installed that copy is the one that runs:
//! - A copy started another way (from the Finder, or by the installer) asks
//!   launchd to start its copy, and quits ([`arrange`]).
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
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Job {
    /// Not loaded: no login has read the file since it was written, and
    /// nothing loaded it.
    NotLoaded,
    /// Loaded, and its copy does not run: it was quit, or launchd waits
    /// before starting it again.
    Stopped,
    Running,
}

/// What Poise Link asks of launchd.
pub trait Launchd {
    fn job(&self) -> Result<Job, String>;
    /// Loads the agent, which starts its copy.
    fn bootstrap(&self, plist: &Path) -> Result<(), String>;
    /// Starts the copy of a loaded agent.
    fn kickstart(&self) -> Result<(), String>;
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
}

fn failure(command: &str, output: &Output) -> String {
    format!(
        "launchctl {command} answered {}: {}",
        output.status,
        String::from_utf8_lossy(&output.stderr).trim()
    )
}

/// The state `launchctl print` reports for a loaded service: a top-level
/// `state = running` line while its copy runs.
pub fn job_state(print: &str) -> Job {
    if print.lines().any(|line| line == "\tstate = running") {
        Job::Running
    } else {
        Job::Stopped
    }
}

fn user_id() -> u32 {
    // SAFETY: getuid has no preconditions and cannot fail.
    unsafe { libc::getuid() }
}

/// The other running copies of Poise Link of this person.
pub trait Copies {
    fn others(&self) -> Vec<u32>;
    fn ask_to_quit(&self, pid: u32);
}

/// The processes of this person that run this program.
pub struct Processes;

impl Copies for Processes {
    fn others(&self) -> Vec<u32> {
        let Some(name) = std::env::current_exe().ok().and_then(|path| {
            path.file_name()
                .map(|name| name.to_string_lossy().into_owned())
        }) else {
            return Vec::new();
        };
        let own = std::process::id();
        match Command::new("/usr/bin/pgrep")
            .args(["-x", "-U", &user_id().to_string(), &name])
            .output()
        {
            Ok(output) => String::from_utf8_lossy(&output.stdout)
                .lines()
                .filter_map(|line| line.trim().parse().ok())
                .filter(|pid| *pid != own)
                .collect(),
            Err(error) => {
                log::warn!("could not list the running copies of Poise Link: {error}");
                Vec::new()
            }
        }
    }

    fn ask_to_quit(&self, pid: u32) {
        let Ok(pid) = libc::pid_t::try_from(pid) else {
            return;
        };
        // SAFETY: kill only sends a signal; the process is this person's own copy of Poise Link.
        if unsafe { libc::kill(pid, libc::SIGTERM) } != 0 {
            log::warn!(
                "could not ask Poise Link {pid} to quit: {}",
                io::Error::last_os_error()
            );
        }
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
pub fn arrange(start: &Arrangement) -> Result<Start, String> {
    start
        .agent
        .migrate()
        .map_err(|error| format!("could not replace Poise Link 0.1's login item: {error}"))?;
    if start.by_launchd {
        take_over(start.copies, start.sleep);
        return Ok(Start::Here);
    }
    if !start.agent.installed() {
        return Ok(Start::Here);
    }
    let job = start.launchd.job()?;
    if job == Job::Running {
        // The single-instance plugin passes this start on to launchd's copy.
        return Ok(Start::Here);
    }
    if start.show_window {
        request_window(start.settings_dir)
            .map_err(|error| format!("could not ask launchd's copy to show its window: {error}"))?;
    }
    if let Err(error) = start_job(start.agent, start.launchd, job) {
        // This process runs Poise Link after all, and shows its own window.
        take_window_request(start.settings_dir);
        return Err(error);
    }
    Ok(Start::HandedOver)
}

/// Start at login was turned on in a copy launchd did not start: launchd
/// starts its copy, which takes over from this one. The caller then quits.
pub fn hand_over(agent: &LaunchAgent, launchd: &dyn Launchd) -> Result<(), String> {
    start_job(agent, launchd, launchd.job()?)
}

fn start_job(agent: &LaunchAgent, launchd: &dyn Launchd, job: Job) -> Result<(), String> {
    match job {
        Job::NotLoaded => launchd.bootstrap(&agent.path()),
        Job::Stopped => launchd.kickstart(),
        Job::Running => Ok(()),
    }
}

/// launchd's copy takes over from any other copy. A copy handing over quits
/// at once; any other is asked to (SIGTERM) after [`QUIT_WAIT`].
pub fn take_over(copies: &dyn Copies, sleep: &dyn Fn(Duration)) {
    if wait_until_alone(copies, sleep) {
        return;
    }
    for pid in copies.others() {
        log::warn!("asking Poise Link {pid}, which launchd did not start, to quit");
        copies.ask_to_quit(pid);
    }
    if !wait_until_alone(copies, sleep) {
        log::error!("another copy of Poise Link is still running");
    }
}

fn wait_until_alone(copies: &dyn Copies, sleep: &dyn Fn(Duration)) -> bool {
    for _ in 0..QUIT_WAIT.as_millis() / POLL.as_millis() {
        if copies.others().is_empty() {
            return true;
        }
        sleep(POLL);
    }
    copies.others().is_empty()
}

/// Asks the copy launchd starts next to show its window.
pub fn request_window(settings_dir: &Path) -> io::Result<()> {
    fs::create_dir_all(settings_dir)?;
    fs::write(settings_dir.join(WINDOW_REQUEST_FILE_NAME), b"")
}

/// Whether a copy the person opened asked this one to show its window. The
/// request is used up.
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

    #[derive(Default)]
    struct FakeLaunchd {
        job: Cell<Option<Job>>,
        fails: Cell<bool>,
        calls: RefCell<Vec<String>>,
    }

    impl FakeLaunchd {
        fn with(job: Job) -> Self {
            let launchd = Self::default();
            launchd.job.set(Some(job));
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
                .get()
                .ok_or_else(|| "launchctl print failed".to_owned())
        }

        fn bootstrap(&self, plist: &Path) -> Result<(), String> {
            self.calls
                .borrow_mut()
                .push(format!("bootstrap {}", plist.display()));
            if self.fails.get() {
                return Err("launchctl bootstrap failed".to_owned());
            }
            self.job.set(Some(Job::Running));
            Ok(())
        }

        fn kickstart(&self) -> Result<(), String> {
            self.calls.borrow_mut().push("kickstart".to_owned());
            if self.fails.get() {
                return Err("launchctl kickstart failed".to_owned());
            }
            self.job.set(Some(Job::Running));
            Ok(())
        }
    }

    /// Other copies, each quitting after being listed `lasts` more times, or
    /// when asked to quit if it obeys.
    #[derive(Default)]
    struct FakeCopies {
        running: RefCell<Vec<(u32, u32)>>,
        obeys: bool,
        asked: RefCell<Vec<u32>>,
    }

    impl FakeCopies {
        fn running(copies: &[(u32, u32)], obeys: bool) -> Self {
            Self {
                running: RefCell::new(copies.to_vec()),
                obeys,
                asked: RefCell::default(),
            }
        }
    }

    impl Copies for FakeCopies {
        fn others(&self) -> Vec<u32> {
            let mut running = self.running.borrow_mut();
            running.retain(|(_, lasts)| *lasts > 0);
            for (_, lasts) in running.iter_mut() {
                *lasts -= 1;
            }
            running.iter().map(|(pid, _)| *pid).collect()
        }

        fn ask_to_quit(&self, pid: u32) {
            self.asked.borrow_mut().push(pid);
            if self.obeys {
                self.running
                    .borrow_mut()
                    .retain(|(running, _)| *running != pid);
            }
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
        let agent = LaunchAgent::new(
            agents.clone(),
            PathBuf::from("/Applications/Poise Link.app/Contents/MacOS/poise-link"),
        );
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
        for (job, call) in [(Job::NotLoaded, "bootstrap"), (Job::Stopped, "kickstart")] {
            let fixture = fixture();
            fixture.agent.install().unwrap();
            let launchd = FakeLaunchd::with(job);
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
    fn a_copy_opened_while_launchds_runs_passes_the_start_on() {
        let fixture = fixture();
        fixture.agent.install().unwrap();
        let launchd = FakeLaunchd::with(Job::Running);
        let start = arrange_with(&fixture, &launchd, &FakeCopies::default(), false, true);
        assert_eq!(start, Ok(Start::Here));
        assert_eq!(launchd.calls(), ["print"]);
        assert!(!take_window_request(&fixture.settings));
    }

    #[test]
    fn when_launchd_cannot_start_its_copy_this_one_runs_and_shows_its_own_window() {
        let fixture = fixture();
        fixture.agent.install().unwrap();
        let launchd = FakeLaunchd::with(Job::Stopped);
        launchd.fails.set(true);
        let start = arrange_with(&fixture, &launchd, &FakeCopies::default(), false, true);
        assert_eq!(start, Err("launchctl kickstart failed".to_owned()));
        assert!(!take_window_request(&fixture.settings));
    }

    #[test]
    fn launchds_copy_waits_for_a_copy_that_hands_over() {
        let fixture = fixture();
        fixture.agent.install().unwrap();
        let launchd = FakeLaunchd::with(Job::Running);
        let copies = FakeCopies::running(&[(41, 5)], true);
        let start = arrange_with(&fixture, &launchd, &copies, true, false);
        assert_eq!(start, Ok(Start::Here));
        assert!(copies.asked.borrow().is_empty());
        assert!(copies.others().is_empty());
        assert!(launchd.calls().is_empty());
    }

    #[test]
    fn launchds_copy_asks_a_copy_that_stays_to_quit() {
        let copies = FakeCopies::running(&[(41, u32::MAX), (42, u32::MAX)], true);
        let slept = Cell::new(Duration::ZERO);
        take_over(&copies, &|delay| slept.set(slept.get() + delay));
        assert_eq!(*copies.asked.borrow(), [41, 42]);
        assert!(copies.others().is_empty());
        assert_eq!(slept.get(), QUIT_WAIT);
    }

    #[test]
    fn launchds_copy_gives_up_waiting_on_a_copy_that_will_not_quit() {
        let copies = FakeCopies::running(&[(41, u32::MAX)], false);
        let slept = Cell::new(Duration::ZERO);
        take_over(&copies, &|delay| slept.set(slept.get() + delay));
        assert_eq!(*copies.asked.borrow(), [41]);
        assert_eq!(slept.get(), QUIT_WAIT * 2);
    }

    #[test]
    fn turning_start_at_login_on_hands_the_running_copy_to_launchd() {
        let fixture = fixture();
        fixture.agent.install().unwrap();
        for (job, calls) in [
            (
                Job::NotLoaded,
                vec![
                    "print".to_owned(),
                    format!("bootstrap {}", fixture.agent.path().display()),
                ],
            ),
            (
                Job::Stopped,
                vec!["print".to_owned(), "kickstart".to_owned()],
            ),
            (Job::Running, vec!["print".to_owned()]),
        ] {
            let launchd = FakeLaunchd::with(job);
            assert_eq!(hand_over(&fixture.agent, &launchd), Ok(()), "{job:?}");
            assert_eq!(launchd.calls(), calls, "{job:?}");
        }
    }

    #[test]
    fn launchctl_print_tells_a_running_copy_from_a_stopped_one() {
        let running = "gui/501/com.vaquum.poise.link = {\n\tactive count = 1\n\tstate = running\n\tpid = 501\n\tendpoints = {\n\t\tstate = active\n\t}\n}\n";
        let stopped = "gui/501/com.vaquum.poise.link = {\n\tactive count = 0\n\tstate = not running\n\tendpoints = {\n\t\tstate = active\n\t}\n}\n";
        assert_eq!(job_state(running), Job::Running);
        assert_eq!(job_state(stopped), Job::Stopped);
    }
}
