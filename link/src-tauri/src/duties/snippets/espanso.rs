//! Finding Espanso's match folder.
//!
//! `espanso path config` names Espanso's configuration folder when the
//! `espanso` command is on PATH. Otherwise the folder is where Espanso keeps
//! it by default on each operating system. Match files live in its `match`
//! subfolder, which Espanso creates on its first run.

use std::ffi::OsString;
use std::io;
use std::path::PathBuf;
use std::process::{Command, Stdio};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    MacOs,
    Linux,
    Windows,
}

impl Os {
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            Os::MacOs
        } else if cfg!(windows) {
            Os::Windows
        } else {
            Os::Linux
        }
    }
}

/// The parts of the process environment the lookup reads.
pub trait Environment: Send + Sync {
    fn var(&self, name: &str) -> Option<OsString>;
    fn home_dir(&self) -> Option<PathBuf>;
}

pub struct SystemEnvironment;

impl Environment for SystemEnvironment {
    fn var(&self, name: &str) -> Option<OsString> {
        std::env::var_os(name)
    }

    fn home_dir(&self) -> Option<PathBuf> {
        dirs::home_dir()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Output {
    pub success: bool,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

/// Runs a program from PATH. Fails with [`io::ErrorKind::NotFound`] when the
/// program is not on PATH.
pub trait CommandRunner: Send + Sync {
    fn run(&self, program: &str, args: &[&str]) -> io::Result<Output>;
}

pub struct SystemRunner;

impl CommandRunner for SystemRunner {
    fn run(&self, program: &str, args: &[&str]) -> io::Result<Output> {
        let output = Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .output()?;
        Ok(Output {
            success: output.status.success(),
            stdout: output.stdout,
            stderr: output.stderr,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MatchFolder {
    Found(PathBuf),
    /// Espanso is not installed, or has never run: this folder does not exist.
    Missing(PathBuf),
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum LocateError {
    #[error("`espanso path config` failed: {0}")]
    Command(String),
    #[error("{0} is not set, so Espanso's folder cannot be found")]
    MissingVariable(&'static str),
    #[error("the home folder is unknown, so Espanso's folder cannot be found")]
    NoHome,
}

pub struct Locator {
    os: Os,
    env: Box<dyn Environment>,
    runner: Box<dyn CommandRunner>,
}

impl Locator {
    pub fn new(os: Os, env: Box<dyn Environment>, runner: Box<dyn CommandRunner>) -> Self {
        Self { os, env, runner }
    }

    pub fn system() -> Self {
        Self::new(
            Os::current(),
            Box::new(SystemEnvironment),
            Box::new(SystemRunner),
        )
    }

    pub fn locate(&self) -> Result<MatchFolder, LocateError> {
        let config = match self.runner.run("espanso", &["path", "config"]) {
            Ok(output) if output.success => config_path_from(&output.stdout)?,
            Ok(output) => {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
                return Err(LocateError::Command(if stderr.is_empty() {
                    "it exited with an error".to_owned()
                } else {
                    stderr
                }));
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                default_config_dir(self.os, &*self.env)?
            }
            Err(error) => return Err(LocateError::Command(error.to_string())),
        };
        let folder = config.join("match");
        Ok(if folder.is_dir() {
            MatchFolder::Found(folder)
        } else {
            MatchFolder::Missing(folder)
        })
    }
}

fn config_path_from(stdout: &[u8]) -> Result<PathBuf, LocateError> {
    let text = String::from_utf8_lossy(stdout);
    let path = text.trim();
    if path.is_empty() || path.lines().count() != 1 {
        return Err(LocateError::Command(format!(
            "expected one folder path, got {path:?}"
        )));
    }
    Ok(PathBuf::from(path))
}

/// Where Espanso keeps its configuration when nothing says otherwise.
pub fn default_config_dir(os: Os, env: &dyn Environment) -> Result<PathBuf, LocateError> {
    let config_home = match os {
        Os::MacOs => env
            .home_dir()
            .ok_or(LocateError::NoHome)?
            .join("Library")
            .join("Application Support"),
        Os::Linux => {
            // XDG: an unset, empty or relative XDG_CONFIG_HOME means ~/.config.
            match env
                .var("XDG_CONFIG_HOME")
                .map(PathBuf::from)
                .filter(|path| path.is_absolute())
            {
                Some(path) => path,
                None => env.home_dir().ok_or(LocateError::NoHome)?.join(".config"),
            }
        }
        Os::Windows => env
            .var("APPDATA")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .ok_or(LocateError::MissingVariable("APPDATA"))?,
    };
    Ok(config_home.join("espanso"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::fs;
    use std::path::Path;
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    struct FakeEnv {
        vars: HashMap<&'static str, OsString>,
        home: Option<PathBuf>,
    }

    impl Environment for FakeEnv {
        fn var(&self, name: &str) -> Option<OsString> {
            self.vars.get(name).cloned()
        }
        fn home_dir(&self) -> Option<PathBuf> {
            self.home.clone()
        }
    }

    enum Reply {
        NotOnPath,
        Exit {
            success: bool,
            stdout: String,
            stderr: String,
        },
        Broken,
    }

    fn exit(success: bool, stdout: &str, stderr: &str) -> Reply {
        Reply::Exit {
            success,
            stdout: stdout.to_owned(),
            stderr: stderr.to_owned(),
        }
    }

    struct FakeRunner {
        reply: Reply,
        calls: Arc<Mutex<Vec<String>>>,
    }

    impl CommandRunner for FakeRunner {
        fn run(&self, program: &str, args: &[&str]) -> io::Result<Output> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("{program} {}", args.join(" ")));
            match &self.reply {
                Reply::NotOnPath => Err(io::Error::from(io::ErrorKind::NotFound)),
                Reply::Exit {
                    success,
                    stdout,
                    stderr,
                } => Ok(Output {
                    success: *success,
                    stdout: stdout.as_bytes().to_vec(),
                    stderr: stderr.as_bytes().to_vec(),
                }),
                Reply::Broken => Err(io::Error::from(io::ErrorKind::PermissionDenied)),
            }
        }
    }

    fn locate(os: Os, env: FakeEnv, reply: Reply) -> Result<MatchFolder, LocateError> {
        let runner = FakeRunner {
            reply,
            calls: Arc::default(),
        };
        Locator::new(os, Box::new(env), Box::new(runner)).locate()
    }

    fn home(path: &Path) -> FakeEnv {
        FakeEnv {
            home: Some(path.to_path_buf()),
            ..FakeEnv::default()
        }
    }

    #[test]
    fn runs_espanso_path_config() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let runner = FakeRunner {
            reply: Reply::NotOnPath,
            calls: Arc::clone(&calls),
        };
        let locator = Locator::new(Os::Linux, Box::new(FakeEnv::default()), Box::new(runner));
        assert_eq!(locator.locate(), Err(LocateError::NoHome));
        assert_eq!(
            *calls.lock().unwrap(),
            vec!["espanso path config".to_owned()]
        );
    }

    #[test]
    fn uses_the_folder_espanso_reports() {
        let root = tempfile::tempdir().unwrap();
        let config = root.path().join("custom espanso");
        fs::create_dir_all(config.join("match")).unwrap();
        let stdout = format!("{}\n", config.display());

        // The reported folder wins over the default on every OS.
        for os in [Os::MacOs, Os::Linux, Os::Windows] {
            let found = locate(os, home(root.path()), exit(true, &stdout, ""));
            assert_eq!(found, Ok(MatchFolder::Found(config.join("match"))));
        }
    }

    #[test]
    fn a_failing_espanso_command_is_an_error_not_a_guess() {
        let root = tempfile::tempdir().unwrap();
        let failed = locate(
            Os::Linux,
            home(root.path()),
            exit(false, "", "missing config directory\n"),
        );
        assert_eq!(
            failed,
            Err(LocateError::Command("missing config directory".into()))
        );
        assert!(matches!(
            locate(Os::Linux, home(root.path()), Reply::Broken),
            Err(LocateError::Command(_))
        ));
        assert!(matches!(
            locate(Os::Linux, home(root.path()), exit(true, "  \n", "")),
            Err(LocateError::Command(_))
        ));
        assert!(matches!(
            locate(
                Os::Linux,
                home(root.path()),
                exit(true, "Config: /a\nPackages: /b\n", "")
            ),
            Err(LocateError::Command(_))
        ));
    }

    #[test]
    fn macos_default_is_in_application_support() {
        let root = tempfile::tempdir().unwrap();
        let folder = root
            .path()
            .join("Library/Application Support/espanso/match");
        fs::create_dir_all(&folder).unwrap();
        assert_eq!(
            locate(Os::MacOs, home(root.path()), Reply::NotOnPath),
            Ok(MatchFolder::Found(folder))
        );
    }

    #[test]
    fn linux_default_follows_xdg_config_home() {
        let root = tempfile::tempdir().unwrap();
        let xdg = root.path().join("xdg");
        fs::create_dir_all(xdg.join("espanso/match")).unwrap();
        let mut env = home(&root.path().join("home"));
        env.vars
            .insert("XDG_CONFIG_HOME", xdg.clone().into_os_string());
        assert_eq!(
            locate(Os::Linux, env, Reply::NotOnPath),
            Ok(MatchFolder::Found(xdg.join("espanso/match")))
        );
    }

    #[test]
    fn linux_default_falls_back_to_dot_config() {
        let root = tempfile::tempdir().unwrap();
        let folder = root.path().join(".config/espanso/match");
        fs::create_dir_all(&folder).unwrap();
        for xdg in [None, Some(""), Some("relative/path")] {
            let mut env = home(root.path());
            if let Some(value) = xdg {
                env.vars.insert("XDG_CONFIG_HOME", value.into());
            }
            assert_eq!(
                locate(Os::Linux, env, Reply::NotOnPath),
                Ok(MatchFolder::Found(folder.clone()))
            );
        }
    }

    #[test]
    fn windows_default_is_under_appdata() {
        let appdata = PathBuf::from(r"C:\Users\octo\AppData\Roaming");
        let mut env = FakeEnv::default();
        env.vars.insert("APPDATA", appdata.clone().into_os_string());
        // That folder does not exist on the test machine, so it is reported missing, by path.
        assert_eq!(
            locate(Os::Windows, env, Reply::NotOnPath),
            Ok(MatchFolder::Missing(appdata.join("espanso").join("match")))
        );
        assert_eq!(
            locate(Os::Windows, FakeEnv::default(), Reply::NotOnPath),
            Err(LocateError::MissingVariable("APPDATA"))
        );
    }

    #[test]
    fn no_match_folder_means_espanso_is_missing() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(
            locate(Os::MacOs, home(root.path()), Reply::NotOnPath),
            Ok(MatchFolder::Missing(
                root.path()
                    .join("Library/Application Support/espanso/match")
            ))
        );
        assert_eq!(
            locate(Os::MacOs, FakeEnv::default(), Reply::NotOnPath),
            Err(LocateError::NoHome)
        );
        assert_eq!(
            locate(Os::Linux, FakeEnv::default(), Reply::NotOnPath),
            Err(LocateError::NoHome)
        );
    }
}
