use base64::Engine as _;
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

/// Active watcher for the open workspace folder; replaced per folder.
pub struct FolderWatcher(pub Mutex<Option<RecommendedWatcher>>);

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

/// Watch `dir` recursively and emit `folder-changed` when the workspace
/// listing may be stale (files or folders created, renamed, removed, or
/// written). The frontend debounces and re-lists.
#[tauri::command]
pub fn watch_folder(
    app: AppHandle,
    watcher: State<'_, FolderWatcher>,
    dir: String,
) -> Result<(), String> {
    let root = PathBuf::from(&dir);
    if !root.is_dir() {
        return Err(format!("not a directory: {dir}"));
    }
    let mut fs_watcher = notify::recommended_watcher({
        let app = app.clone();
        move |result: Result<Event, notify::Error>| {
            let Ok(event) = result else { return };
            // Plain access events carry no listing-relevant change.
            if matches!(event.kind, notify::EventKind::Access(_)) {
                return;
            }
            let _ = app.emit_to("main", "folder-changed", ());
        }
    })
    .map_err(|e| e.to_string())?;
    fs_watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    *watcher.0.lock().unwrap() = Some(fs_watcher);
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedImage {
    pub path: String,
    pub name: String,
}

const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif"];
const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;

/// Persist a pasted clipboard image next to the document. Bytes arrive as
/// base64 (the IPC is JSON), the name is generated server-side
/// (`pasted-image`, `-2`, `-3`… on collision) and the extension is
/// whitelisted, so the frontend never crafts a path. Async so the
/// decode + write never block the main thread.
#[tauri::command]
pub async fn save_clipboard_image(
    dir: String,
    data: String,
    ext: String,
) -> Result<SavedImage, String> {
    let ext = ext.to_ascii_lowercase();
    if !IMAGE_EXTENSIONS.contains(&ext.as_str()) {
        return Err(format!("unsupported image format: {ext}"));
    }
    // Reject oversized payloads before the base64 decode allocates ~3/4 of
    // the input size.
    if data.len() > MAX_IMAGE_BYTES / 3 * 4 + 4 {
        return Err(format!("image payload too large: {} bytes", data.len()));
    }
    let base = PathBuf::from(&dir);
    if !base.is_dir() {
        return Err(format!("not a directory: {dir}"));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| e.to_string())?;
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return Err(format!("image size out of range: {} bytes", bytes.len()));
    }
    let mut candidate = base.join(format!("pasted-image.{ext}"));
    let mut n = 1;
    while candidate.exists() {
        n += 1;
        candidate = base.join(format!("pasted-image-{n}.{ext}"));
    }
    fs::write(&candidate, bytes).map_err(|e| e.to_string())?;
    let name = candidate
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(SavedImage {
        path: candidate.to_string_lossy().into_owned(),
        name,
    })
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
    // Write-then-rename in the same directory: a crash mid-save cannot leave
    // the file truncated, and the watcher already tolerates rename saves.
    let tmp = file_path.with_extension(format!(
        "{}~",
        file_path
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or("md")
    ));
    if let Err(err) = fs::write(&tmp, content.as_bytes()) {
        let _ = fs::remove_file(&tmp);
        return Err(err.to_string());
    }
    if let Err(err) = fs::rename(&tmp, &file_path) {
        let _ = fs::remove_file(&tmp);
        return Err(err.to_string());
    }
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
    settings::update(&app, |app_settings| {
        app_settings.recent_files.retain(|p| p != &path);
        app_settings.recent_files.insert(0, path.clone());
        app_settings.recent_files.truncate(10);
    });
    let _ = menu::refresh(&app);
}

#[tauri::command]
pub fn clear_recent_files(app: AppHandle) {
    settings::update(&app, |app_settings| {
        app_settings.recent_files.clear();
    });
    let _ = menu::refresh(&app);
}

#[tauri::command]
pub fn get_settings(app: AppHandle) -> settings::Settings {
    settings::load(&app)
}

/// Case-stable key for per-path settings on case-insensitive filesystems,
/// so the same file opened from different sources shares one entry.
fn normalize_path_key(path: &str) -> String {
    #[cfg(windows)]
    {
        path.replace('/', "\\").to_lowercase()
    }
    #[cfg(not(windows))]
    {
        path.to_string()
    }
}

#[tauri::command]
pub fn get_reading_position(app: AppHandle, path: String) -> Option<settings::ReadingEntry> {
    let key = normalize_path_key(&path);
    settings::load(&app)
        .reading_positions
        .into_iter()
        .find(|entry| normalize_path_key(&entry.path) == key)
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
    let key = normalize_path_key(&path);
    settings::update(&app, |app_settings| {
        app_settings
            .reading_positions
            .retain(|entry| normalize_path_key(&entry.path) != key);
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
    });
}

#[tauri::command]
pub fn set_language(app: AppHandle, language: String) -> Result<(), String> {
    if !matches!(language.as_str(), "en" | "pt-BR" | "es") {
        return Err(format!("unsupported language: {language}"));
    }
    let current = settings::update(&app, |app_settings| {
        app_settings.language = language.clone();
        app_settings.language.clone()
    });
    menu::refresh(&app).map_err(|e| e.to_string())?;
    let _ = app.emit("language-changed", current);
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
const MAX_WALK_ENTRIES: usize = 50_000;
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
/// truncated (file cap or entry cap — the latter bounds walks of huge trees
/// with few markdown files).
fn walk_markdown_files(root: &Path, out: &mut Vec<FileEntry>) -> bool {
    let mut stack = vec![root.to_path_buf()];
    let mut visited = 0usize;
    while let Some(current) = stack.pop() {
        let Ok(entries) = fs::read_dir(&current) else {
            continue;
        };
        for entry in entries.flatten() {
            visited += 1;
            if visited > MAX_WALK_ENTRIES {
                return true;
            }
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
                    .replace('\\', "/");
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
    // Sort by directory, then name, so same-directory files stay contiguous
    // for the frontend's folder grouping.
    files.sort_by(|a, b| {
        let (dir_a, name_a) = split_rel_path(&a.rel_path);
        let (dir_b, name_b) = split_rel_path(&b.rel_path);
        dir_a
            .to_lowercase()
            .cmp(&dir_b.to_lowercase())
            .then_with(|| name_a.to_lowercase().cmp(&name_b.to_lowercase()))
    });
    Ok(FolderListing {
        dir,
        files,
        truncated,
    })
}

fn split_rel_path(rel_path: &str) -> (&str, &str) {
    match rel_path.rfind('/') {
        Some(idx) => (&rel_path[..idx], &rel_path[idx + 1..]),
        None => ("", rel_path),
    }
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
    files.sort_by(|a, b| {
        let (dir_a, name_a) = split_rel_path(&a.rel_path);
        let (dir_b, name_b) = split_rel_path(&b.rel_path);
        dir_a
            .to_lowercase()
            .cmp(&dir_b.to_lowercase())
            .then_with(|| name_a.to_lowercase().cmp(&name_b.to_lowercase()))
    });

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

/// Trim a matching line around the first match for display. Byte offsets
/// from `line.to_lowercase()` cannot index `line` (lowercasing can change
/// byte lengths, e.g. U+0130), so the window is computed over chars only —
/// approximate placement, but never a panic or invalid boundary.
fn search_snippet(line: &str, needle: &str) -> String {
    let lowered = line.to_lowercase();
    let approx_match_char = lowered
        .find(needle)
        .map(|pos| lowered[..pos].chars().count());
    let chars: Vec<char> = line.chars().collect();
    if chars.len() <= 160 {
        return line.to_string();
    }
    let needle_chars = needle.chars().count().max(1);
    let approx_char = approx_match_char
        .unwrap_or(0)
        .min(chars.len().saturating_sub(1));
    let half = 80usize;
    let start_char = approx_char.saturating_sub(half);
    let end_char = (approx_char + needle_chars + half).min(chars.len());
    let mut snippet: String = chars[start_char..end_char].iter().collect();
    if start_char > 0 {
        snippet.insert_str(0, "…");
    }
    if end_char < chars.len() {
        snippet.push('…');
    }
    snippet
}

#[tauri::command]
pub fn set_last_folder(app: AppHandle, path: Option<String>) {
    settings::update(&app, |app_settings| {
        app_settings.last_folder = path;
    });
}

/// Persist the open-tab session (named file paths + which was active) so
/// the next launch restores the workspace. Debounced by the frontend.
#[tauri::command]
pub fn set_session(app: AppHandle, open_tabs: Vec<String>, active_tab: usize) {
    settings::update(&app, |app_settings| {
        app_settings.open_tabs = open_tabs;
        app_settings.open_tabs.truncate(20);
        app_settings.active_tab = active_tab;
    });
}

#[tauri::command]
pub fn path_is_dir(path: String) -> bool {
    Path::new(&path).is_dir()
}

/// Resolve a `[[wiki link]]` target against `base_dir`, refusing anything
/// that escapes it. Targets without a markdown extension get `.md`
/// appended; the returned path is absolute and canonical.
#[tauri::command]
pub fn resolve_wiki_link(base_dir: String, target: String) -> Option<String> {
    let target = target.trim();
    if target.is_empty() {
        return None;
    }
    let base = PathBuf::from(&base_dir);
    let candidate = if has_markdown_ext(Path::new(target)) {
        base.join(target)
    } else {
        base.join(format!("{target}.md"))
    };
    // Canonicalize resolves `..`, symlinks and letter case; the result must
    // stay inside the base directory (blocks `[[../../anything]]`).
    let canonical_base = base.canonicalize().ok()?;
    let canonical = candidate.canonicalize().ok()?;
    if !canonical.starts_with(&canonical_base) || !canonical.is_file() {
        return None;
    }
    // Windows canonical paths carry a `\\?\` prefix no other command
    // produces; strip it (restoring the `\\` of UNC shares) so paths
    // round-trip through recents/highlight.
    let text = canonical.to_string_lossy();
    let clean = match text.strip_prefix(r"\\?\UNC\") {
        Some(rest) => format!(r"\\{rest}"),
        None => text.strip_prefix(r"\\?\").unwrap_or(&text).to_string(),
    };
    Some(clean)
}

#[cfg(test)]
mod tests {
    use super::{resolve_wiki_link, search_snippet};
    use std::fs;
    use std::path::PathBuf;

    #[test]
    fn snippet_survives_chars_whose_lowercase_expands() {
        // U+0130 lowercases to two chars; the old implementation sliced the
        // original line with byte offsets from the lowercased copy and
        // panicked on non-char boundaries.
        let line = "İé".to_string() + &"x".repeat(79) + "hedef";
        let snippet = search_snippet(&line, "hedef");
        assert!(snippet.contains("hedef"));
    }

    #[test]
    fn snippet_short_lines_pass_through() {
        assert_eq!(search_snippet("short match here", "match"), "short match here");
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "markread-test-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn wiki_link_resolves_sibling_without_extension() {
        let dir = temp_dir("wiki-sibling");
        fs::write(dir.join("note.md"), "x").unwrap();
        let resolved = resolve_wiki_link(dir.to_string_lossy().into_owned(), "note".into());
        assert!(resolved.is_some());
        // Windows canonical paths must not leak the `\\?\` prefix.
        assert!(!resolved.unwrap().starts_with(r"\\?\"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn wiki_link_traversal_outside_base_is_refused() {
        let base = temp_dir("wiki-base");
        let outside = temp_dir("wiki-outside");
        fs::write(outside.join("secret.md"), "x").unwrap();
        let dir_name = outside.file_name().unwrap().to_string_lossy().into_owned();
        let resolved = resolve_wiki_link(
            base.to_string_lossy().into_owned(),
            format!("../{dir_name}/secret"),
        );
        assert!(resolved.is_none());
        let _ = fs::remove_dir_all(&base);
        let _ = fs::remove_dir_all(&outside);
    }
}
