use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_dialog::DialogExt;

use crate::{menu, settings};

/// File path handed to the app at startup (argv, macOS open event) that the
/// frontend picks up with `take_pending_file` once its listener is attached.
pub struct PendingFile(pub Mutex<Option<String>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub path: String,
    pub name: String,
    pub dir: String,
    pub content: String,
    pub size: u64,
}

#[tauri::command]
pub fn read_markdown_file(path: String) -> Result<FileInfo, String> {
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    let file_path = PathBuf::from(&path);
    let name = file_path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.clone());
    let dir = file_path
        .parent()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(FileInfo {
        path,
        name,
        dir,
        content,
        size: meta.len(),
    })
}

#[tauri::command]
pub fn write_markdown_file(path: String, content: String) -> Result<FileInfo, String> {
    let file_path = PathBuf::from(&path);
    if !has_markdown_ext(&file_path) {
        return Err(format!("not a markdown file: {path}"));
    }
    fs::write(&file_path, content.as_bytes()).map_err(|e| e.to_string())?;
    read_markdown_file(path)
}

#[tauri::command]
pub fn get_recent_files(app: AppHandle) -> Vec<String> {
    settings::load(&app)
        .recent_files
        .into_iter()
        .filter(|p| fs::metadata(p).is_ok())
        .collect()
}

#[tauri::command]
pub fn push_recent_file(app: AppHandle, path: String) {
    let mut app_settings = settings::load(&app);
    app_settings.recent_files.retain(|p| p != &path);
    app_settings.recent_files.insert(0, path);
    app_settings.recent_files.truncate(10);
    settings::save(&app, &app_settings);
    let _ = menu::refresh(&app);
}

#[tauri::command]
pub fn clear_recent_files(app: AppHandle) {
    let mut app_settings = settings::load(&app);
    app_settings.recent_files.clear();
    settings::save(&app, &app_settings);
    let _ = menu::refresh(&app);
}

#[tauri::command]
pub fn get_settings(app: AppHandle) -> settings::Settings {
    settings::load(&app)
}

#[tauri::command]
pub fn set_language(app: AppHandle, language: String) -> Result<(), String> {
    let mut app_settings = settings::load(&app);
    app_settings.language = language;
    settings::save(&app, &app_settings);
    menu::refresh(&app).map_err(|e| e.to_string())?;
    let _ = app.emit("language-changed", app_settings.language);
    Ok(())
}

#[tauri::command]
pub fn take_pending_file(pending: State<'_, PendingFile>) -> Option<String> {
    pending.0.lock().unwrap().take()
}

/// Show the native About dialog.
pub fn show_about(app: &AppHandle) {
    let version = app.package_info().version.clone();
    app.dialog()
        .message(format!(
            "MarkRead {version}\n\nA clean Markdown reader for Linux, macOS and Windows.\nMIT License"
        ))
        .title("About MarkRead")
        .show(|_| {});
}

/// Extract the first markdown file path from command-line arguments
/// (Windows/Linux file association launches).
pub fn find_markdown_arg(args: &[String]) -> Option<String> {
    args.iter()
        .skip(1)
        .filter(|arg| !arg.starts_with('-'))
        .find(|arg| {
            let path = Path::new(arg.as_str());
            path.is_file() && has_markdown_ext(path)
        })
        .cloned()
}

pub fn has_markdown_ext(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.to_ascii_lowercase())
            .as_deref(),
        Some("md" | "markdown" | "mdown" | "mkd")
    )
}
