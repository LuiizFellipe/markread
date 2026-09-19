use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;

/// Where the reader stopped in a file, so reopening restores the position.
/// `anchor_id`/`anchor_offset` pin the scroll to a heading, surviving edits
/// that change the content height.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReadingEntry {
    pub path: String,
    pub scroll_top: f64,
    pub scroll_height: f64,
    pub anchor_id: Option<String>,
    pub anchor_offset: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub language: String,
    pub recent_files: Vec<String>,
    pub reading_positions: Vec<ReadingEntry>,
    pub last_folder: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            language: "en".to_string(),
            recent_files: Vec::new(),
            reading_positions: Vec::new(),
            last_folder: None,
        }
    }
}

fn settings_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|dir| dir.join("settings.json"))
}

/// Serializes settings access so concurrent read-modify-write commands
/// (e.g. debounced position saves vs. recent-file pushes) cannot silently
/// drop each other's updates.
static SETTINGS_LOCK: Mutex<()> = Mutex::new(());

pub fn load(app: &tauri::AppHandle) -> Settings {
    let _guard = SETTINGS_LOCK.lock().unwrap();
    load_unlocked(app)
}

/// Hold the lock across load → mutate → save so interleaved commands each
/// see and extend the latest state instead of overwriting it wholesale.
pub fn update<T>(app: &tauri::AppHandle, f: impl FnOnce(&mut Settings) -> T) -> T {
    let _guard = SETTINGS_LOCK.lock().unwrap();
    let mut settings = load_unlocked(app);
    let result = f(&mut settings);
    save_unlocked(app, &settings);
    result
}

fn load_unlocked(app: &tauri::AppHandle) -> Settings {
    settings_path(app)
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_default()
}

fn save_unlocked(app: &tauri::AppHandle, settings: &Settings) {
    let Some(path) = settings_path(app) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(settings) {
        // Write to a temp file and rename over the target so a crash or a
        // concurrent reader never observes a half-written settings.json.
        let tmp = path.with_extension("json.tmp");
        if fs::write(&tmp, json).is_ok() {
            let _ = fs::rename(&tmp, &path);
        }
    }
}
