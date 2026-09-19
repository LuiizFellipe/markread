use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
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

/// Active watcher for auto-reload; replaced each time a file is opened.
/// Watching the parent directory (not the file handle) keeps the watch alive
/// across editors that save via write-temp-then-rename (VS Code, others).
pub struct FileWatcher(pub Mutex<Option<RecommendedWatcher>>);

fn paths_match(a: &Path, b: &Path) -> bool {
    if a == b {
        return true;
    }
    #[cfg(windows)]
    return a.to_string_lossy().eq_ignore_ascii_case(&b.to_string_lossy());
    #[cfg(not(windows))]
    return false;
}

/// Watch `path` for external changes and emit `file-changed` to the window.
#[tauri::command]
pub fn watch_file(
    app: AppHandle,
    watcher: State<'_, FileWatcher>,
    path: String,
) -> Result<(), String> {
    let target = PathBuf::from(&path);
    let parent = target
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| format!("no parent directory: {path}"))?
        .to_path_buf();

    let mut fs_watcher = notify::recommended_watcher({
        let app = app.clone();
        let target = target.clone();
        move |result: Result<Event, notify::Error>| {
            let Ok(event) = result else { return };
            if event.paths.iter().any(|p| paths_match(p, &target)) {
                let _ = app.emit_to(
                    "main",
                    "file-changed",
                    target.to_string_lossy().into_owned(),
                );
            }
        }
    })
    .map_err(|e| e.to_string())?;
    fs_watcher
        .watch(&parent, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;
    *watcher.0.lock().unwrap() = Some(fs_watcher);
    Ok(())
}

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
pub fn get_reading_position(app: AppHandle, path: String) -> Option<settings::ReadingEntry> {
    settings::load(&app)
        .reading_positions
        .into_iter()
        .find(|entry| entry.path == path)
}

/// Upsert the reading position (most-recently-read first, capped so the
/// settings file stays small even with heavy usage).
#[tauri::command]
pub fn set_reading_position(
    app: AppHandle,
    path: String,
    scroll_top: f64,
    scroll_height: f64,
    anchor_id: Option<String>,
    anchor_offset: f64,
) {
    let mut app_settings = settings::load(&app);
    app_settings
        .reading_positions
        .retain(|entry| entry.path != path);
    app_settings.reading_positions.insert(
        0,
        settings::ReadingEntry {
            path,
            scroll_top,
            scroll_height,
            anchor_id,
            anchor_offset,
        },
    );
    app_settings.reading_positions.truncate(100);
    settings::save(&app, &app_settings);
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

/* ---------- folder mode (light workspace) ---------- */

const MAX_LISTED_FILES: usize = 2000;
const MAX_SEARCH_HITS: usize = 200;
const MAX_SEARCH_FILE_SIZE: u64 = 1024 * 1024;
const MAX_SEARCH_TOTAL_BYTES: u64 = 64 * 1024 * 1024;
const SKIPPED_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    "venv",
    ".venv",
    "__pycache__",
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    pub name: String,
    pub rel_path: String,
    pub size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderListing {
    pub dir: String,
    pub files: Vec<FileEntry>,
    pub truncated: bool,
}

/// Depth-first walk collecting markdown files below `root`, skipping hidden
/// and well-known generated directories. Returns whether the listing was
/// truncated at MAX_LISTED_FILES.
fn walk_markdown_files(root: &Path, out: &mut Vec<FileEntry>) -> bool {
    let mut stack = vec![root.to_path_buf()];
    while let Some(current) = stack.pop() {
        let Ok(entries) = fs::read_dir(&current) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
            if file_type.is_dir() {
                let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                    continue;
                };
                if name.starts_with('.') || SKIPPED_DIRS.contains(&name) {
                    continue;
                }
                stack.push(path);
            } else if file_type.is_file() && has_markdown_ext(&path) {
                if out.len() >= MAX_LISTED_FILES {
                    return true;
                }
                let rel_path = path
                    .strip_prefix(root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .into_owned();
                out.push(FileEntry {
                    path: path.to_string_lossy().into_owned(),
                    name: path
                        .file_name()
                        .map(|name| name.to_string_lossy().into_owned())
                        .unwrap_or_default(),
                    rel_path,
                    size: entry.metadata().map(|m| m.len()).unwrap_or(0),
                });
            }
        }
    }
    false
}

#[tauri::command]
pub fn list_markdown_files(dir: String) -> Result<FolderListing, String> {
    let root = PathBuf::from(&dir);
    if !root.is_dir() {
        return Err(format!("not a directory: {dir}"));
    }
    let mut files = Vec::new();
    let truncated = walk_markdown_files(&root, &mut files);
    files.sort_by(|a, b| a.rel_path.to_lowercase().cmp(&b.rel_path.to_lowercase()));
    Ok(FolderListing {
        dir,
        files,
        truncated,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: String,
    pub name: String,
    pub line: u32,
    pub text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderSearchResults {
    pub hits: Vec<SearchHit>,
    pub truncated: bool,
}

/// Case-insensitive line search across the folder's markdown files,
/// bounded in file count, file size and total bytes scanned.
#[tauri::command]
pub fn search_markdown_files(dir: String, query: String) -> Result<FolderSearchResults, String> {
    let root = PathBuf::from(&dir);
    if !root.is_dir() {
        return Err(format!("not a directory: {dir}"));
    }
    let needle = query.to_lowercase();
    if needle.trim().is_empty() {
        return Ok(FolderSearchResults {
            hits: Vec::new(),
            truncated: false,
        });
    }

    let mut files = Vec::new();
    walk_markdown_files(&root, &mut files);
    files.sort_by(|a, b| a.rel_path.to_lowercase().cmp(&b.rel_path.to_lowercase()));

    let mut hits = Vec::new();
    let mut truncated = false;
    let mut scanned_bytes = 0u64;
    for file in &files {
        if hits.len() >= MAX_SEARCH_HITS {
            truncated = true;
            break;
        }
        let Ok(meta) = fs::metadata(&file.path) else {
            continue;
        };
        if meta.len() > MAX_SEARCH_FILE_SIZE || scanned_bytes + meta.len() > MAX_SEARCH_TOTAL_BYTES
        {
            continue;
        }
        let Ok(content) = fs::read_to_string(&file.path) else {
            continue;
        };
        scanned_bytes += meta.len();
        for (idx, line) in content.lines().enumerate() {
            if line.to_lowercase().contains(&needle) {
                hits.push(SearchHit {
                    path: file.path.clone(),
                    name: file.name.clone(),
                    line: (idx + 1) as u32,
                    text: search_snippet(line, &needle),
                });
                if hits.len() >= MAX_SEARCH_HITS {
                    truncated = true;
                    break;
                }
            }
        }
    }
    Ok(FolderSearchResults { hits, truncated })
}

/// Trim a matching line around the first match for display.
fn search_snippet(line: &str, needle: &str) -> String {
    let lowered = line.to_lowercase();
    let Some(match_pos) = lowered.find(needle) else {
        return line.chars().take(160).collect();
    };
    let start = lowered
        .char_indices()
        .map(|(i, _)| i)
        .filter(|&i| i + 80 < match_pos)
        .max()
        .unwrap_or(0);
    let end = lowered
        .char_indices()
        .map(|(i, _)| i)
        .find(|&i| i >= match_pos + needle.len() + 80)
        .unwrap_or(line.len());
    let mut snippet = line[start..end].trim().to_string();
    if start > 0 {
        snippet.insert_str(0, "…");
    }
    if end < line.len() {
        snippet.push('…');
    }
    snippet
}

#[tauri::command]
pub fn set_last_folder(app: AppHandle, path: Option<String>) {
    let mut app_settings = settings::load(&app);
    app_settings.last_folder = path;
    settings::save(&app, &app_settings);
}

#[tauri::command]
pub fn path_is_dir(path: String) -> bool {
    Path::new(&path).is_dir()
}
