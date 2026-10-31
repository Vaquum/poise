//! Replacing a file in one step.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::Path;

/// Who may read a file written by [`write_atomically`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    /// The usual permissions for a new file.
    Default,
    /// Readable and writable by its owner only (mode 0600 on Unix). On
    /// Windows, files under the person's profile are already theirs alone.
    OwnerOnly,
}

/// The temporary name [`write_atomically`] writes `name` under first.
pub fn temp_name(name: &str) -> String {
    format!(".{name}.tmp")
}

/// Replaces `dir/name` with `contents` in one atomic rename: the bytes go to a
/// temporary file in the same folder, are flushed to disk, and only then take
/// the final name, so a reader sees the old file or the new one and never a
/// partial write. Nothing else in `dir` is touched.
pub fn write_atomically(dir: &Path, name: &str, contents: &[u8], access: Access) -> io::Result<()> {
    let temp = dir.join(temp_name(name));
    // A temporary file left behind by an interrupted write is ours to replace.
    remove_if_present(&temp)?;
    let result =
        write_and_rename(&temp, &dir.join(name), contents, access).and_then(|()| sync_dir(dir));
    if result.is_err()
        && let Err(cleanup) = remove_if_present(&temp)
    {
        log::warn!("could not remove {}: {cleanup}", temp.display());
    }
    result
}

fn write_and_rename(temp: &Path, target: &Path, contents: &[u8], access: Access) -> io::Result<()> {
    let mut options = OpenOptions::new();
    // create_new refuses to follow anything already at the temporary path.
    options.write(true).create_new(true);
    #[cfg(unix)]
    if access == Access::OwnerOnly {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    #[cfg(not(unix))]
    let _ = access;
    let mut file = options.open(temp)?;
    file.write_all(contents)?;
    file.sync_all()?;
    drop(file);
    fs::rename(temp, target)
}

/// Makes the rename itself durable.
#[cfg(unix)]
fn sync_dir(dir: &Path) -> io::Result<()> {
    fs::File::open(dir)?.sync_all()
}

#[cfg(not(unix))]
fn sync_dir(_dir: &Path) -> io::Result<()> {
    Ok(())
}

pub fn remove_if_present(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    fn listing(dir: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
        fs::read_dir(dir)
            .unwrap()
            .map(|entry| {
                let path = entry.unwrap().path();
                let contents = if path.is_file() {
                    fs::read(&path).unwrap()
                } else {
                    Vec::new()
                };
                (path, contents)
            })
            .collect()
    }

    #[test]
    fn creates_the_file_and_leaves_no_temporary_file() {
        let dir = tempfile::tempdir().unwrap();
        write_atomically(dir.path(), "poise.yml", b"one", Access::Default).unwrap();
        assert_eq!(fs::read(dir.path().join("poise.yml")).unwrap(), b"one");
        assert!(!dir.path().join(".poise.yml.tmp").exists());
    }

    #[test]
    fn replaces_an_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("poise.yml"), b"old").unwrap();
        write_atomically(dir.path(), "poise.yml", b"new", Access::Default).unwrap();
        assert_eq!(fs::read(dir.path().join("poise.yml")).unwrap(), b"new");
    }

    #[test]
    fn never_touches_other_files_in_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("base.yml"), b"matches: []\n").unwrap();
        fs::write(dir.path().join("_private.yml"), b"secret").unwrap();
        fs::create_dir(dir.path().join("packages")).unwrap();
        let before = listing(dir.path());

        write_atomically(dir.path(), "poise.yml", b"new", Access::Default).unwrap();

        let mut after = listing(dir.path());
        assert_eq!(
            after.remove(&dir.path().join("poise.yml")),
            Some(b"new".to_vec())
        );
        assert_eq!(after, before);
    }

    #[test]
    fn replaces_a_stale_temporary_file() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(".poise.yml.tmp"), b"half written").unwrap();
        write_atomically(dir.path(), "poise.yml", b"whole", Access::Default).unwrap();
        assert_eq!(fs::read(dir.path().join("poise.yml")).unwrap(), b"whole");
        assert!(!dir.path().join(".poise.yml.tmp").exists());
    }

    #[test]
    fn failed_rename_keeps_the_folder_as_it_was() {
        let dir = tempfile::tempdir().unwrap();
        // A non-empty directory where the file should go makes the rename fail.
        fs::create_dir(dir.path().join("poise.yml")).unwrap();
        fs::write(dir.path().join("poise.yml").join("keep"), b"x").unwrap();
        fs::write(dir.path().join("base.yml"), b"base").unwrap();
        let before = listing(dir.path());

        let result = write_atomically(dir.path(), "poise.yml", b"new", Access::Default);

        assert!(result.is_err());
        assert_eq!(listing(dir.path()), before);
        assert_eq!(
            fs::read(dir.path().join("poise.yml").join("keep")).unwrap(),
            b"x"
        );
    }

    #[test]
    fn missing_folder_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("absent");
        assert!(write_atomically(&missing, "poise.yml", b"x", Access::Default).is_err());
        assert!(!missing.exists());
    }

    #[cfg(unix)]
    #[test]
    fn owner_only_files_are_mode_0600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("token"), b"old").unwrap();
        fs::set_permissions(dir.path().join("token"), fs::Permissions::from_mode(0o644)).unwrap();

        write_atomically(dir.path(), "token", b"secret", Access::OwnerOnly).unwrap();

        let mode = fs::metadata(dir.path().join("token"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[cfg(unix)]
    #[test]
    fn a_link_planted_at_the_temporary_path_is_not_followed() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let victim = outside.path().join("victim");
        fs::write(&victim, b"untouched").unwrap();
        std::os::unix::fs::symlink(&victim, dir.path().join(".poise.yml.tmp")).unwrap();

        write_atomically(dir.path(), "poise.yml", b"new", Access::Default).unwrap();

        assert_eq!(fs::read(&victim).unwrap(), b"untouched");
        assert_eq!(fs::read(dir.path().join("poise.yml")).unwrap(), b"new");
    }
}
