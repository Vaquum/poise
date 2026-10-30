// Without this, Windows opens a console window beside the app in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    poise_link::run()
}
