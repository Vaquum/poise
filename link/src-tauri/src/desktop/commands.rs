//! What the pairing and status window can ask for.

use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::controller::Controller;
use crate::status::Status;

/// The status plus the tray's wording of it, so the window says the same.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusView {
    #[serde(flatten)]
    pub status: Status,
    pub connection_line: String,
    pub snippets_line: String,
}

impl From<&Status> for StatusView {
    fn from(status: &Status) -> Self {
        Self {
            connection_line: status.connection_line(),
            snippets_line: status.snippets_line(),
            status: status.clone(),
        }
    }
}

#[tauri::command]
pub fn status(controller: State<'_, Arc<Controller>>) -> StatusView {
    StatusView::from(&controller.status())
}

/// Starts pairing with the Poise at `server`; progress arrives as status events.
#[tauri::command]
pub async fn pair(controller: State<'_, Arc<Controller>>, server: String) -> Result<(), String> {
    controller
        .begin_pairing(&server)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn cancel_pairing(controller: State<'_, Arc<Controller>>) {
    controller.cancel_pairing();
}

#[tauri::command]
pub fn open_verification(controller: State<'_, Arc<Controller>>) -> Result<(), String> {
    controller.open_verification()
}

#[tauri::command]
pub fn open_poise(controller: State<'_, Arc<Controller>>) -> Result<(), String> {
    controller.open_poise()
}
