//! The snippet duty: keeps `poise.yml` in Espanso's match folder equal to the
//! workspace's snippets. Sync is one way; Poise is where snippets are edited.

pub mod document;
pub mod espanso;

use std::fmt::Display;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;

use super::{BoxFuture, Context, Duty, DutyError, Input};
use crate::fsutil::{self, Access};
use crate::link_api::{ApiError, SnippetsResponse};
use crate::platform::Notice;
use crate::status::Snippets;
use espanso::{Locator, MatchFolder};

/// The one file Poise Link writes in Espanso's match folder.
pub const FILE_NAME: &str = "poise.yml";
/// How long `espanso path config` may take before the sync gives up.
const LOCATE_TIMEOUT: Duration = Duration::from_secs(10);

pub struct SnippetSync {
    espanso: Arc<Locator>,
    backup_dir: PathBuf,
    every: Duration,
    last: Option<Written>,
}

/// The workspace version last written, and the exact bytes written for it.
struct Written {
    version: String,
    etag: Option<String>,
    contents: String,
    count: usize,
}

enum Reason {
    /// A `snippets` event announced this version.
    Announced(Option<String>),
    Periodic,
    /// "Sync now": fetch everything again.
    Forced,
}

#[derive(Deserialize)]
struct Announcement {
    version: String,
}

impl SnippetSync {
    /// `backup_dir` receives a copy of any `poise.yml` Poise Link did not write
    /// before it is replaced.
    pub fn new(espanso: Arc<Locator>, backup_dir: PathBuf, every: Duration) -> Self {
        Self {
            espanso,
            backup_dir,
            every,
            last: None,
        }
    }

    async fn locate(&self) -> Result<MatchFolder, String> {
        let espanso = Arc::clone(&self.espanso);
        let lookup = tokio::task::spawn_blocking(move || espanso.locate());
        match tokio::time::timeout(LOCATE_TIMEOUT, lookup).await {
            Ok(Ok(found)) => found.map_err(|error| error.to_string()),
            Ok(Err(join)) => Err(format!("looking for Espanso's folder failed: {join}")),
            Err(_) => Err(format!(
                "`espanso path config` did not answer within {LOCATE_TIMEOUT:?}"
            )),
        }
    }

    async fn sync(&mut self, context: &Context, reason: Reason) -> Result<(), DutyError> {
        let folder = match self.locate().await {
            Ok(MatchFolder::Found(folder)) => folder,
            Ok(MatchFolder::Missing(folder)) => {
                context.status.set_snippets(Snippets::EspansoMissing {
                    detail: format!(
                        "Espanso's match folder {} does not exist. Install Espanso and start it once.",
                        folder.display()
                    ),
                });
                return Ok(());
            }
            Err(error) => return Err(failed(context, error)),
        };
        let file = folder.join(FILE_NAME);
        let on_disk = read_if_present(&file).map_err(|error| {
            failed(
                context,
                format!("could not read {}: {error}", file.display()),
            )
        })?;

        // What was written last, if the file still holds exactly that.
        let intact = self
            .last
            .as_ref()
            .filter(|last| on_disk.as_deref() == Some(last.contents.as_str()))
            .map(|last| (last.version.clone(), last.etag.clone(), last.count));
        if let (Reason::Announced(Some(announced)), Some((version, _, _))) = (&reason, &intact)
            && announced == version
        {
            return Ok(());
        }
        let if_none_match = match reason {
            Reason::Forced => None,
            _ => intact.as_ref().and_then(|(_, etag, _)| etag.clone()),
        };

        let response = match context.api.snippets(if_none_match.as_deref()).await {
            Ok(response) => response,
            Err(ApiError::Unauthorized) => return Err(DutyError::Unauthorized),
            Err(error) => return Err(failed(context, error)),
        };
        let (version, yaml, etag) = match response {
            SnippetsResponse::NotModified => match intact {
                Some((_, _, count)) if if_none_match.is_some() => {
                    set_synced(context, &file, count);
                    return Ok(());
                }
                _ => {
                    return Err(failed(
                        context,
                        "the workspace answered 304 Not Modified to a request that was not conditional",
                    ));
                }
            },
            SnippetsResponse::Fresh {
                version,
                yaml,
                etag,
            } => (version, yaml, etag),
        };

        let snippets = match document::parse(&yaml) {
            Ok(snippets) => snippets,
            Err(reason) => {
                log::error!(
                    "rejected snippets version {version} from the workspace, keeping {}: {reason}",
                    file.display()
                );
                context.status.set_snippets(Snippets::Rejected { reason });
                return Ok(());
            }
        };
        let contents = document::render(&snippets);
        if on_disk.as_deref() != Some(contents.as_str()) {
            if let Some(foreign) = on_disk
                .as_deref()
                .filter(|old| !old.trim().is_empty() && !document::is_managed(old))
            {
                let copy = self.back_up(foreign).map_err(|error| {
                    failed(
                        context,
                        format!("could not save a copy of {}: {error}", file.display()),
                    )
                })?;
                log::warn!(
                    "{} was not written by Poise Link; saved a copy to {}",
                    file.display(),
                    copy.display()
                );
                context.notifier.notify(Notice {
                    title: "Poise Link replaced Espanso's poise.yml".to_owned(),
                    body: format!(
                        "The file it replaced was not written by Poise Link. A copy is at {}; import it in Poise under Snippets.",
                        copy.display()
                    ),
                    url: None,
                });
            }
            fsutil::write_atomically(&folder, FILE_NAME, contents.as_bytes(), Access::Default)
                .map_err(|error| {
                    failed(
                        context,
                        format!("could not write {}: {error}", file.display()),
                    )
                })?;
            log::info!(
                "wrote {} snippets (version {version}) to {}",
                snippets.len(),
                file.display()
            );
        }
        set_synced(context, &file, snippets.len());
        self.last = Some(Written {
            version,
            etag,
            contents,
            count: snippets.len(),
        });
        Ok(())
    }

    fn back_up(&self, contents: &str) -> io::Result<PathBuf> {
        fs::create_dir_all(&self.backup_dir)?;
        let name = format!(
            "{FILE_NAME}.before-poise-link-{}",
            chrono::Local::now().format("%Y%m%d-%H%M%S")
        );
        fsutil::write_atomically(
            &self.backup_dir,
            &name,
            contents.as_bytes(),
            Access::OwnerOnly,
        )?;
        Ok(self.backup_dir.join(name))
    }
}

impl Duty for SnippetSync {
    fn name(&self) -> &'static str {
        "snippets"
    }

    fn events(&self) -> &'static [&'static str] {
        &["snippets"]
    }

    fn interval(&self) -> Option<Duration> {
        Some(self.every)
    }

    fn handle<'a>(
        &'a mut self,
        input: Input,
        context: &'a Context,
    ) -> BoxFuture<'a, Result<(), DutyError>> {
        Box::pin(async move {
            let reason = match input {
                Input::Event(event) => match serde_json::from_str::<Announcement>(&event.data) {
                    Ok(announcement) => Reason::Announced(Some(announcement.version)),
                    Err(error) => {
                        log::warn!(
                            "snippets event without a readable version ({error}); syncing anyway"
                        );
                        Reason::Announced(None)
                    }
                },
                Input::Tick => Reason::Periodic,
                Input::SyncNow => Reason::Forced,
            };
            self.sync(context, reason).await
        })
    }
}

fn set_synced(context: &Context, file: &Path, count: usize) {
    context.status.set_snippets(Snippets::Synced {
        at: chrono::Local::now().format("%H:%M").to_string(),
        count,
        file: file.display().to_string(),
    });
}

/// Records a failed sync in the status and hands the message to the duty runner to log.
fn failed(context: &Context, error: impl Display) -> DutyError {
    let error = error.to_string();
    context.status.set_snippets(Snippets::Failed {
        error: error.clone(),
    });
    DutyError::Failed(error)
}

fn read_if_present(file: &Path) -> io::Result<Option<String>> {
    match fs::read_to_string(file) {
        Ok(contents) => Ok(Some(contents)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}
