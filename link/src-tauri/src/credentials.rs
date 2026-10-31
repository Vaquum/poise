//! Where the device token is kept: the operating system's credential store
//! (Keychain, Windows Credential Manager, the Secret Service on Linux), or,
//! when that store is unavailable, a file only the person can read.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::fsutil::{self, Access};

/// The fallback file's name in the configuration folder.
pub const TOKEN_FILE: &str = "device-token";
const ACCOUNT: &str = "device-token";

/// A store for one secret.
pub trait SecretStore: Send + Sync {
    fn set(&self, secret: &str) -> Result<(), String>;
    /// `Ok(None)` when no secret is stored.
    fn get(&self) -> Result<Option<String>, String>;
    /// Succeeds when there is nothing to delete.
    fn delete(&self) -> Result<(), String>;
}

/// The operating system's credential store.
pub struct OsCredentialStore {
    service: String,
}

impl OsCredentialStore {
    /// `service` names the entry; Poise Link uses its bundle identifier.
    pub fn new(service: &str) -> Self {
        Self {
            service: service.to_owned(),
        }
    }

    fn entry(&self) -> Result<keyring::Entry, String> {
        keyring::Entry::new(&self.service, ACCOUNT).map_err(|e| e.to_string())
    }
}

impl SecretStore for OsCredentialStore {
    fn set(&self, secret: &str) -> Result<(), String> {
        self.entry()?
            .set_password(secret)
            .map_err(|e| e.to_string())
    }

    fn get(&self) -> Result<Option<String>, String> {
        match self.entry()?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }

    fn delete(&self) -> Result<(), String> {
        match self.entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }
}

/// Where a saved token ended up.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Saved {
    CredentialStore,
    File(PathBuf),
}

/// The device token, kept in the credential store with a private file as
/// the fallback.
pub struct TokenStore {
    store: Box<dyn SecretStore>,
    dir: PathBuf,
}

impl TokenStore {
    pub fn new(store: Box<dyn SecretStore>, config_dir: &Path) -> Self {
        Self {
            store,
            dir: config_dir.to_path_buf(),
        }
    }

    fn file(&self) -> PathBuf {
        self.dir.join(TOKEN_FILE)
    }

    pub fn save(&self, token: &str) -> io::Result<Saved> {
        match self.store.set(token) {
            Ok(()) => {
                // A token in the credential store never also lingers in a file.
                fsutil::remove_if_present(&self.file())?;
                Ok(Saved::CredentialStore)
            }
            Err(error) => {
                log::warn!(
                    "the operating system's credential store is unavailable ({error}); keeping the \
                     device token in {} instead, readable only by you",
                    self.file().display()
                );
                fs::create_dir_all(&self.dir)?;
                fsutil::write_atomically(
                    &self.dir,
                    TOKEN_FILE,
                    token.as_bytes(),
                    Access::OwnerOnly,
                )?;
                Ok(Saved::File(self.file()))
            }
        }
    }

    pub fn load(&self) -> io::Result<Option<String>> {
        match self.store.get() {
            Ok(Some(token)) => Ok(Some(token)),
            Ok(None) => self.read_file(),
            Err(error) => match self.read_file()? {
                Some(token) => Ok(Some(token)),
                None => Err(io::Error::other(format!(
                    "could not read the device token from the credential store: {error}"
                ))),
            },
        }
    }

    /// Forgets the token everywhere it may be.
    pub fn clear(&self) -> io::Result<()> {
        let file = fsutil::remove_if_present(&self.file());
        self.store.delete().map_err(|error| {
            io::Error::other(format!("could not remove the device token: {error}"))
        })?;
        file
    }

    fn read_file(&self) -> io::Result<Option<String>> {
        match fs::read_to_string(self.file()) {
            Ok(token) => Ok(Some(token.trim().to_owned()).filter(|t| !t.is_empty())),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// An in-memory credential store; `broken` makes every call fail.
    #[derive(Clone, Default)]
    pub struct MemoryStore {
        pub secret: Arc<Mutex<Option<String>>>,
        pub broken: bool,
    }

    impl SecretStore for MemoryStore {
        fn set(&self, secret: &str) -> Result<(), String> {
            if self.broken {
                return Err("no credential store".into());
            }
            *self.secret.lock().unwrap() = Some(secret.to_owned());
            Ok(())
        }
        fn get(&self) -> Result<Option<String>, String> {
            if self.broken {
                return Err("no credential store".into());
            }
            Ok(self.secret.lock().unwrap().clone())
        }
        fn delete(&self) -> Result<(), String> {
            if self.broken {
                return Err("no credential store".into());
            }
            *self.secret.lock().unwrap() = None;
            Ok(())
        }
    }

    #[test]
    fn keeps_the_token_in_the_credential_store_and_never_in_a_file() {
        let dir = tempfile::tempdir().unwrap();
        let memory = MemoryStore::default();
        let tokens = TokenStore::new(Box::new(memory.clone()), dir.path());

        assert_eq!(tokens.save("tok-1").unwrap(), Saved::CredentialStore);

        assert_eq!(memory.secret.lock().unwrap().as_deref(), Some("tok-1"));
        assert!(!dir.path().join(TOKEN_FILE).exists());
        assert_eq!(tokens.load().unwrap().as_deref(), Some("tok-1"));
    }

    #[test]
    fn saving_to_the_credential_store_removes_an_old_fallback_file() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(TOKEN_FILE), "old-token").unwrap();
        let tokens = TokenStore::new(Box::new(MemoryStore::default()), dir.path());

        tokens.save("tok-2").unwrap();

        assert!(!dir.path().join(TOKEN_FILE).exists());
    }

    #[test]
    fn falls_back_to_a_private_file_when_the_store_is_unavailable() {
        let dir = tempfile::tempdir().unwrap();
        let broken = MemoryStore {
            broken: true,
            ..MemoryStore::default()
        };
        let tokens = TokenStore::new(Box::new(broken), &dir.path().join("config"));

        let saved = tokens.save("tok-3").unwrap();

        let file = dir.path().join("config").join(TOKEN_FILE);
        assert_eq!(saved, Saved::File(file.clone()));
        assert_eq!(fs::read_to_string(&file).unwrap(), "tok-3");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&file).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        assert_eq!(tokens.load().unwrap().as_deref(), Some("tok-3"));
    }

    #[test]
    fn an_unreadable_store_without_a_file_is_an_error_not_signed_out() {
        let dir = tempfile::tempdir().unwrap();
        let broken = MemoryStore {
            broken: true,
            ..MemoryStore::default()
        };
        let tokens = TokenStore::new(Box::new(broken), dir.path());
        assert!(tokens.load().is_err());
    }

    #[test]
    fn no_token_anywhere_loads_as_none() {
        let dir = tempfile::tempdir().unwrap();
        let tokens = TokenStore::new(Box::new(MemoryStore::default()), dir.path());
        assert_eq!(tokens.load().unwrap(), None);
    }

    #[test]
    fn clear_forgets_the_token_in_both_places() {
        let dir = tempfile::tempdir().unwrap();
        let memory = MemoryStore::default();
        *memory.secret.lock().unwrap() = Some("tok-4".into());
        fs::write(dir.path().join(TOKEN_FILE), "tok-4").unwrap();
        let tokens = TokenStore::new(Box::new(memory.clone()), dir.path());

        tokens.clear().unwrap();

        assert_eq!(*memory.secret.lock().unwrap(), None);
        assert!(!dir.path().join(TOKEN_FILE).exists());
        assert_eq!(tokens.load().unwrap(), None);
    }

    #[test]
    fn clear_removes_the_file_even_when_the_store_fails() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(TOKEN_FILE), "tok-5").unwrap();
        let broken = MemoryStore {
            broken: true,
            ..MemoryStore::default()
        };
        let tokens = TokenStore::new(Box::new(broken), dir.path());

        assert!(tokens.clear().is_err());
        assert!(!dir.path().join(TOKEN_FILE).exists());
    }
}
