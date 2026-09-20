import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, message, open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import "./app.css";
import "github-markdown-css/github-markdown-light.css";
import darkGithubCss from "github-markdown-css/github-markdown-dark.css?raw";
import { applyI18n, detectLanguage, setLanguage, t, type Lang } from "./i18n";
import { enhanceRendered, renderMarkdown } from "./renderer";
import { initSearch, resetSearch } from "./search";
import {
  collectHeadings,
  initScrollSpy,
  renderOutline,
  type Heading,
} from "./outline";
import { initTheme, setThemePreference, type ThemePreference } from "./theme";
import { countWords, formatBytes, readingMinutes } from "./status";
import { renderMermaidBlocks } from "./mermaid";
import {
  captureScroll,
  restoreScroll,
  type ScrollSnapshot,
} from "./scroll";

/* Scope the dark GitHub stylesheet under html[data-theme="dark"] so the manual
   theme toggle (not prefers-color-scheme) decides which palette applies. */
{
  const darkStyle = document.createElement("style");
  darkStyle.textContent = darkGithubCss.replaceAll(
    ".markdown-body",
    'html[data-theme="dark"] .markdown-body',
  );
  document.head.appendChild(darkStyle);
}

const inTauri = "__TAURI_INTERNALS__" in window;

interface FileInfo {
  path: string;
  name: string;
  dir: string;
  content: string;
  size: number;
}

const $ = <T extends HTMLElement>(selector: string): T => {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`missing element: ${selector}`);
  return el;
};

const sidebar = $<HTMLElement>("#sidebar");
const outlineEl = $<HTMLElement>("#outline");
const findbar = $<HTMLElement>("#findbar");
const findInput = $<HTMLInputElement>("#find-input");
const findCount = $<HTMLElement>("#find-count");
const scrollPane = $<HTMLElement>("#scroll-pane");
const bodyEl = $<HTMLElement>("#markdown-body");
const editorEl = $<HTMLTextAreaElement>("#editor");
const welcome = $<HTMLElement>("#welcome");
const welcomeOpen = $<HTMLButtonElement>("#welcome-open");
const recentList = $<HTMLUListElement>("#recent-list");
const recentEmpty = $<HTMLElement>("#recent-empty");
const clearRecentBtn = $<HTMLButtonElement>("#clear-recent");
const statusFile = $<HTMLElement>("#status-file");
const statusMeta = $<HTMLElement>("#status-meta");
const statusCursor = $<HTMLElement>("#status-cursor");
const progressEl = $<HTMLElement>("#reading-progress");
const backToTop = $<HTMLButtonElement>("#back-to-top");
const editorArea = $<HTMLElement>("#editor-area");
const editorToolbar = $<HTMLElement>("#editor-toolbar");
const editorPreviewEl = $<HTMLElement>("#editor-preview");
const editorPreviewScroll = $<HTMLElement>("#editor-preview-scroll");
const tabOutline = $<HTMLButtonElement>("#tab-outline");
const tabFiles = $<HTMLButtonElement>("#tab-files");
const filesPane = $<HTMLElement>("#files-pane");
const openFolderBtn = $<HTMLButtonElement>("#open-folder-btn");
const folderNameEl = $<HTMLElement>("#folder-name");
const folderSearchInput = $<HTMLInputElement>("#folder-search");
const fileListEl = $<HTMLElement>("#file-list");
const welcomeFolder = $<HTMLButtonElement>("#welcome-folder");
const updateBanner = $<HTMLElement>("#update-banner");
const updateBannerText = $<HTMLElement>("#update-banner-text");
const updateOpenBtn = $<HTMLButtonElement>("#update-open");
const updateCloseBtn = $<HTMLButtonElement>("#update-close");

const search = initSearch(bodyEl, findbar, findInput, findCount);
const updateScrollSpy = initScrollSpy(scrollPane, outlineEl, () => headings, bodyEl);

let headings: Heading[] = [];
let currentFile: FileInfo | null = null;
let isEditing = false;
let isDirty = false;
let fileUsesCrlf = false;
let hasMermaid = false;
/** Bumped on every committed render; async render pipelines abort after
 *  each await when theirs is no longer the newest generation. */
let renderGeneration = 0;

interface FileEntry {
  path: string;
  name: string;
  relPath: string;
  size: number;
}

interface FolderListing {
  dir: string;
  files: FileEntry[];
  truncated: boolean;
}

interface SearchHit {
  path: string;
  name: string;
  line: number;
  text: string;
}

interface FolderSearchResults {
  hits: SearchHit[];
  truncated: boolean;
}

let workspaceDir: string | null = null;
let folderListing: FolderListing | null = null;
let folderSearchTimer: ReturnType<typeof setTimeout> | null = null;
let folderSearchSeq = 0;

/* ---------- zoom ---------- */

const ZOOM_KEY = "markread.zoom";
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
let zoom = clampZoom(Number(localStorage.getItem(ZOOM_KEY) ?? "1"));

function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(value * 10) / 10));
}

async function applyZoom(): Promise<void> {
  localStorage.setItem(ZOOM_KEY, String(zoom));
  if (!inTauri) return;
  try {
    await getCurrentWebview().setZoom(zoom);
  } catch {
    /* zoom permission unavailable — ignore */
  }
}

function changeZoom(delta: number): void {
  zoom = clampZoom(zoom + delta);
  void applyZoom();
}

/* ---------- status ---------- */

function updateStatus(): void {
  if (!currentFile) {
    statusFile.textContent = t("statusNoFile");
    statusFile.removeAttribute("title");
    statusMeta.textContent = "";
    return;
  }
  statusFile.textContent = currentFile.name;
  statusFile.title = currentFile.path;
  const words = countWords(isEditing ? editorEl.value : currentFile.content);
  const meta = [
    t("statusWords", { n: words.toLocaleString() }),
    t("statusReadingTime", { m: readingMinutes(words) }),
    formatBytes(currentFile.size),
  ];
  if (isDirty) meta.unshift(t("statusUnsaved"));
  statusMeta.textContent = meta.join(" · ");
}

/** Word-style "Ln l, Col c" indicator for the status bar (edit mode only).
 *  Runs on every caret move, so it counts newlines without allocating. */
function updateStatusCursor(): void {
  if (!isEditing) {
    statusCursor.hidden = true;
    return;
  }
  const value = editorEl.value;
  const pos = editorEl.selectionStart;
  let line = 1;
  let idx = value.indexOf("\n");
  while (idx !== -1 && idx < pos) {
    line++;
    idx = value.indexOf("\n", idx + 1);
  }
  const col = pos - (value.lastIndexOf("\n", pos - 1) + 1) + 1;
  statusCursor.textContent = t("statusCursor", { l: String(line), c: String(col) });
  statusCursor.hidden = false;
}

/* ---------- document display ---------- */

function showDocument(): void {
  editorArea.hidden = true;
  scrollPane.hidden = false;
  welcome.hidden = true;
  bodyEl.hidden = false;
}

/** Single render pipeline shared by file open, edit exit, auto-reload and
 *  theme-driven re-renders. */
async function renderDocument(content: string, dir: string): Promise<void> {
  bodyEl.innerHTML = await renderMarkdown(content);
  enhanceRendered(bodyEl, dir, {
    onOpenMarkdownFile: (p) => void openPath(p),
  });
  hasMermaid = await renderMermaidBlocks(bodyEl);
  headings = collectHeadings(bodyEl);
  renderOutline(outlineEl, headings, t("outlineEmpty"), bodyEl);
  updateScrollSpy();
}

async function showError(err: unknown): Promise<void> {
  if (!inTauri) {
    console.error(err);
    return;
  }
  await message(String(err), { title: t("errorOpenTitle"), kind: "error" });
}

/* ---------- editing ---------- */

function updateWindowTitle(): void {
  if (!inTauri || !currentFile) return;
  const dirtyMark = isDirty ? "• " : "";
  void getCurrentWindow()
    .setTitle(`${dirtyMark}${currentFile.name} — MarkRead`)
    .catch(() => {});
}

function markDirty(): void {
  if (!isDirty) {
    isDirty = true;
    updateWindowTitle();
  }
  updateStatus();
}

/** Whether pending edits may be discarded (false = cancel the action). */
async function confirmDiscardChanges(): Promise<boolean> {
  if (!isDirty || !inTauri) return true;
  return ask(t("unsavedMessage"), {
    title: t("unsavedTitle"),
    kind: "warning",
  });
}

/** Textareas normalize CRLF to LF; map edited text back to the endings the
 *  file had on disk so saving stays byte-faithful for Windows files. */
function applyFileLineEndings(value: string): string {
  return value.replaceAll(/\r?\n/g, fileUsesCrlf ? "\r\n" : "\n");
}

/* ---------- editor: split preview + formatting toolbar ---------- */

const PREVIEW_DEBOUNCE = 200;
let previewTimer: ReturnType<typeof setTimeout> | null = null;
let previewGeneration = 0;

function showEditorArea(): void {
  editorArea.hidden = false;
  scrollPane.hidden = true;
}

function hideEditorArea(): void {
  editorArea.hidden = true;
  scrollPane.hidden = false;
}

function schedulePreviewUpdate(): void {
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(() => void updateEditorPreview(), PREVIEW_DEBOUNCE);
}

async function updateEditorPreview(): Promise<void> {
  if (!isEditing) return;
  const gen = ++previewGeneration;
  const dir = currentFile?.dir ?? "";
  let html: string;
  try {
    html = await renderMarkdown(editorEl.value);
  } catch {
    return;
  }
  if (!isEditing || gen !== previewGeneration) return;
  // Mermaid is skipped live on purpose: it is heavy and incomplete diagrams
  // would flash parse errors — the full render happens when editing ends.
  editorPreviewEl.innerHTML = html;
  enhanceRendered(editorPreviewEl, dir, {
    onOpenMarkdownFile: (p) => void openPath(p),
  });
}

/** Replace a range in the editor preserving the native undo stack via
 *  execCommand, with a setRangeText fallback (which needs the explicit
 *  input dispatch that execCommand triggers on its own). */
function editorReplace(
  start: number,
  end: number,
  text: string,
  selStart?: number,
  selEnd?: number,
): void {
  editorEl.focus();
  editorEl.setSelectionRange(start, end);
  let applied = false;
  try {
    applied = document.execCommand("insertText", false, text);
  } catch {
    applied = false;
  }
  if (!applied) {
    editorEl.setRangeText(text, start, end, "end");
    markDirty();
    schedulePreviewUpdate();
    updateStatusCursor();
  }
  if (selStart !== undefined) {
    editorEl.setSelectionRange(selStart, selEnd ?? selStart);
  }
}

function wrapSelection(prefix: string, suffix = prefix): void {
  const start = editorEl.selectionStart;
  const end = editorEl.selectionEnd;
  const selected = editorEl.value.slice(start, end);
  if (
    selected.length >= prefix.length + suffix.length &&
    selected.startsWith(prefix) &&
    selected.endsWith(suffix)
  ) {
    const inner = selected.slice(prefix.length, selected.length - suffix.length);
    editorReplace(start, end, inner, start, start + inner.length);
    return;
  }
  editorReplace(
    start,
    end,
    prefix + selected + suffix,
    start + prefix.length,
    start + prefix.length + selected.length,
  );
}

/** Any line-start marker the formatting buttons manage. */
const LINE_MARKER = /^(?:#{1,6}\s+|>\s?|-\s\[[ xX]\]\s|-\s|\d+\.\s)/;

function selectionLineRange(): [number, number] {
  const value = editorEl.value;
  // lastIndexOf with fromIndex -1 clamps to 0, which would match a leading
  // newline and invert the range — anchor 0 must map to line 0 explicitly.
  const anchor = editorEl.selectionStart;
  const lineStart = anchor === 0 ? 0 : value.lastIndexOf("\n", anchor - 1) + 1;
  let lineEnd = value.indexOf("\n", editorEl.selectionEnd);
  if (lineEnd === -1) lineEnd = value.length;
  return [lineStart, lineEnd];
}

function toggleLinePrefix(
  prefixFor: (index: number) => string,
  detect: RegExp,
): void {
  const [lineStart, lineEnd] = selectionLineRange();
  const lines = editorEl.value.slice(lineStart, lineEnd).split("\n");
  const allPrefixed = lines.every((line) => detect.test(line));
  const updated = lines.map((line, i) =>
    allPrefixed ? line.replace(detect, "") : prefixFor(i) + line.replace(LINE_MARKER, ""),
  );
  const text = updated.join("\n");
  editorReplace(lineStart, lineEnd, text, lineStart, lineStart + text.length);
}

function cycleHeadingLevel(): void {
  const [lineStart, lineEnd] = selectionLineRange();
  const lines = editorEl.value.slice(lineStart, lineEnd).split("\n");
  // The regex match includes the trailing space — count only the # chars.
  const first = /^#{1,3}\s/.exec(lines[0]);
  const level = first ? first[0].trim().length : 0;
  const next = level === 0 ? 1 : level >= 3 ? 0 : level + 1;
  const updated = lines.map((line) => {
    const stripped = line.replace(/^#{1,6}\s+/, "");
    return next === 0 ? stripped : `${"#".repeat(next)} ${stripped}`;
  });
  const text = updated.join("\n");
  editorReplace(lineStart, lineEnd, text, lineStart, lineStart + text.length);
}

/** Insert a block (table) at the cursor, separated from surrounding text
 *  by blank lines as markdown requires. */
function insertBlock(text: string): void {
  const value = editorEl.value;
  const start = editorEl.selectionStart;
  const end = editorEl.selectionEnd;
  const lineStart = start === 0 ? 0 : value.lastIndexOf("\n", start - 1) + 1;
  const atLineStart = value.slice(lineStart, start).trim() === "";
  const prevLineStart = lineStart > 0 ? value.lastIndexOf("\n", lineStart - 2) + 1 : 0;
  const prevBlank =
    lineStart === 0 || value.slice(prevLineStart, lineStart).trim() === "";
  const lead = atLineStart ? (prevBlank ? "" : "\n") : "\n\n";
  const insert = lead + text + "\n";
  const insertPos = atLineStart ? lineStart : start;
  editorReplace(insertPos, Math.max(insertPos, end), insert, insertPos + insert.length);
}

function wrapCode(): void {
  const start = editorEl.selectionStart;
  const end = editorEl.selectionEnd;
  const selected = editorEl.value.slice(start, end);
  if (selected.includes("\n")) {
    const fenced = "```\n" + (selected.endsWith("\n") ? selected : selected + "\n") + "```";
    editorReplace(start, end, fenced, start + 4);
  } else {
    wrapSelection("`");
  }
}

function insertLink(): void {
  const start = editorEl.selectionStart;
  const label = editorEl.value.slice(start, editorEl.selectionEnd) || "text";
  editorReplace(
    start,
    editorEl.selectionEnd,
    `[${label}](url)`,
    start + label.length + 3,
    start + label.length + 6,
  );
}

function insertImage(): void {
  const start = editorEl.selectionStart;
  const alt = editorEl.value.slice(start, editorEl.selectionEnd) || "alt text";
  editorReplace(
    start,
    editorEl.selectionEnd,
    `![${alt}](image-path.png)`,
    start + alt.length + 4,
    start + alt.length + 18,
  );
}

const TABLE_TEMPLATE =
  "| Column 1 | Column 2 | Column 3 |\n|---|---|---|\n| Cell 1 | Cell 2 | Cell 3 |";

function runEditorCommand(cmd: string): void {
  // Focus first: execCommand (undo/redo included) only acts on the focused
  // editable, and clicking a toolbar button moves focus to the button.
  editorEl.focus();
  switch (cmd) {
    case "undo":
      document.execCommand("undo");
      break;
    case "redo":
      document.execCommand("redo");
      break;
    case "bold":
      wrapSelection("**");
      break;
    case "italic":
      wrapSelection("*");
      break;
    case "strikethrough":
      wrapSelection("~~");
      break;
    case "heading":
      cycleHeadingLevel();
      break;
    case "bullet-list":
      toggleLinePrefix(() => "- ", /^-\s/);
      break;
    case "numbered-list":
      toggleLinePrefix((i) => `${i + 1}. `, /^\d+\.\s/);
      break;
    case "task-list":
      toggleLinePrefix(() => "- [ ] ", /^- \[[ xX]\]\s/);
      break;
    case "blockquote":
      toggleLinePrefix(() => "> ", /^>\s?/);
      break;
    case "code":
      wrapCode();
      break;
    case "table":
      insertBlock(TABLE_TEMPLATE);
      break;
    case "link":
      insertLink();
      break;
    case "image":
      insertImage();
      break;
  }
}

/* ---------- reading position ---------- */

interface ReadingPosition {
  scrollTop: number;
  scrollHeight: number;
  anchorId: string | null;
  anchorOffset: number;
}

const POSITION_SAVE_DEBOUNCE = 800;
let positionSaveTimer: ReturnType<typeof setTimeout> | null = null;

function currentScrollSnapshot(): ScrollSnapshot {
  return captureScroll(
    scrollPane,
    bodyEl,
    headings.map((h) => h.id),
  );
}

async function saveReadingPositionNow(): Promise<void> {
  if (positionSaveTimer) {
    clearTimeout(positionSaveTimer);
    positionSaveTimer = null;
  }
  if (!inTauri || !currentFile || bodyEl.hidden) return;
  const snap = currentScrollSnapshot();
  try {
    await invoke("set_reading_position", {
      path: currentFile.path,
      scrollTop: snap.top,
      scrollHeight: snap.height,
      anchorId: snap.anchorId,
      anchorOffset: snap.anchorOffset,
    });
  } catch {
    /* non-fatal */
  }
}

function scheduleSaveReadingPosition(): void {
  if (!inTauri || !currentFile) return;
  if (positionSaveTimer) clearTimeout(positionSaveTimer);
  positionSaveTimer = setTimeout(() => void saveReadingPositionNow(), POSITION_SAVE_DEBOUNCE);
}

function updateReadingProgress(): void {
  if (!currentFile || bodyEl.hidden) {
    progressEl.hidden = true;
    return;
  }
  const max = scrollPane.scrollHeight - scrollPane.clientHeight;
  const pct = max > 0 ? (scrollPane.scrollTop / max) * 100 : 0;
  progressEl.hidden = false;
  progressEl.style.width = `${Math.min(100, Math.max(0, pct))}%`;
}

/* ---------- auto-reload ---------- */

const RELOAD_DEBOUNCE = 250;
let reloadTimer: ReturnType<typeof setTimeout> | null = null;

/** Transient status-bar hint; the next updateStatus() call replaces it. */
function statusHint(text: string): void {
  statusMeta.textContent = text;
}

async function reloadCurrentFile(): Promise<void> {
  if (!currentFile) return;
  const gen = ++renderGeneration;
  const path = currentFile.path;
  let file: FileInfo;
  try {
    file = await invoke<FileInfo>("read_markdown_file", { path });
  } catch {
    if (gen === renderGeneration) statusHint(t("fileUnavailable"));
    return;
  }
  if (gen !== renderGeneration || !currentFile || currentFile.path !== path) return;
  // Same content on disk: our own save round-tripping through the watcher.
  if (file.content === currentFile.content) return;
  if (isEditing) {
    // Never clobber the editor buffer; surface the divergence instead.
    statusHint(t("fileChangedOnDisk"));
    return;
  }
  const snapshot = currentScrollSnapshot();
  fileUsesCrlf = file.content.includes("\r\n");
  currentFile = file;
  await renderDocument(file.content, file.dir);
  if (gen !== renderGeneration) return;
  restoreScroll(scrollPane, bodyEl, snapshot);
  resetSearch(search);
  updateStatus();
}

function handleFileChanged(path: string): void {
  if (!currentFile || path !== currentFile.path) return;
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => void reloadCurrentFile(), RELOAD_DEBOUNCE);
}

function enterEditMode(): void {
  if (!currentFile) return;
  renderGeneration++; // cancel any in-flight document render
  resetSearch(search);
  isEditing = true;
  editorEl.value = currentFile.content;
  welcome.hidden = true;
  bodyEl.hidden = true;
  showEditorArea();
  backToTop.classList.remove("visible");
  editorEl.focus();
  void updateEditorPreview();
  updateStatus();
  updateStatusCursor();
}

function exitEditMode(): void {
  if (!isEditing || !currentFile) return;
  isEditing = false;
  previewGeneration++; // drop in-flight preview renders
  if (previewTimer) {
    clearTimeout(previewTimer);
    previewTimer = null;
  }
  hideEditorArea();
  statusCursor.hidden = true;
  currentFile.content = applyFileLineEndings(editorEl.value);
  const gen = ++renderGeneration;
  void renderDocument(currentFile.content, currentFile.dir).then(() => {
    if (gen !== renderGeneration || isEditing) return;
    showDocument();
    updateStatus();
    updateReadingProgress();
  });
}

async function saveFile(): Promise<void> {
  if (!currentFile) return;
  const content = isEditing
    ? applyFileLineEndings(editorEl.value)
    : currentFile.content;
  currentFile.content = content;
  if (!inTauri) return;
  try {
    const file = await invoke<FileInfo>("write_markdown_file", {
      path: currentFile.path,
      content,
    });
    currentFile = file;
    isDirty = false;
    updateWindowTitle();
    updateStatus();
  } catch (err) {
    await message(String(err), { title: t("saveErrorTitle"), kind: "error" });
  }
}

async function openPath(path: string): Promise<void> {
  if (!(await confirmDiscardChanges())) return;
  const gen = ++renderGeneration;
  await saveReadingPositionNow();
  if (gen !== renderGeneration) return;
  try {
    const savedPosition: Promise<ReadingPosition | null> = inTauri
      ? invoke<ReadingPosition | null>("get_reading_position", { path }).catch(() => null)
      : Promise.resolve(null);
    const [file, saved] = await Promise.all([
      invoke<FileInfo>("read_markdown_file", { path }),
      savedPosition,
    ]);
    if (gen !== renderGeneration) return;
    isEditing = false;
    isDirty = false;
    hideEditorArea();
    statusCursor.hidden = true;
    editorEl.value = "";
    fileUsesCrlf = file.content.includes("\r\n");
    currentFile = file;
    await renderDocument(file.content, file.dir);
    if (gen !== renderGeneration) return;
    showDocument();
    updateStatus();
    restoreScroll(scrollPane, bodyEl, {
      top: saved?.scrollTop ?? 0,
      height: saved?.scrollHeight ?? 0,
      anchorId: saved?.anchorId ?? null,
      anchorOffset: saved?.anchorOffset ?? 0,
    });
    updateReadingProgress();
    if (inTauri) {
      await getCurrentWindow().setTitle(`${file.name} — MarkRead`);
      if (gen !== renderGeneration) return;
      await invoke("push_recent_file", { path });
      void refreshRecents();
      highlightActiveFile();
      try {
        await invoke("watch_file", { path });
      } catch {
        /* auto-reload unavailable for this path — reading still works */
      }
    }
  } catch (err) {
    if (gen === renderGeneration) await showError(err);
  }
}

/* ---------- recent files ---------- */

function splitPath(path: string): { name: string; parent: string } {
  const normalized = path.replaceAll("\\", "/");
  const idx = normalized.lastIndexOf("/");
  return {
    name: idx === -1 ? normalized : normalized.slice(idx + 1),
    parent: idx === -1 ? "" : normalized.slice(0, idx),
  };
}

async function refreshRecents(): Promise<void> {
  if (!inTauri) return;
  let paths: string[] = [];
  try {
    paths = await invoke<string[]>("get_recent_files");
  } catch {
    return;
  }
  recentList.innerHTML = "";
  recentEmpty.hidden = paths.length > 0;
  clearRecentBtn.hidden = paths.length === 0;
  for (const path of paths) {
    const { name, parent } = splitPath(path);
    const li = document.createElement("li");
    const btn = document.createElement("button");
    const nameSpan = document.createElement("span");
    nameSpan.className = "recent-name";
    nameSpan.textContent = name;
    const pathSpan = document.createElement("span");
    pathSpan.className = "recent-path";
    pathSpan.textContent = parent;
    pathSpan.title = path;
    btn.append(nameSpan, pathSpan);
    btn.addEventListener("click", () => void openPath(path));
    li.appendChild(btn);
    recentList.appendChild(li);
  }
}

async function runOpenDialog(): Promise<void> {
  const path = inTauri
    ? await openFileDialog({
        multiple: false,
        filters: [
          { name: "Markdown", extensions: ["md", "markdown", "mdown", "mkd"] },
        ],
      })
    : null;
  if (typeof path === "string") await openPath(path);
}

/* ---------- sidebar ---------- */

const OUTLINE_KEY = "markread.outline";
const SIDEBAR_TAB_KEY = "markread.sidebar-tab";

function applySidebarPreference(): void {
  sidebar.hidden = localStorage.getItem(OUTLINE_KEY) !== "1";
}

function toggleSidebar(): void {
  sidebar.hidden = !sidebar.hidden;
  localStorage.setItem(OUTLINE_KEY, sidebar.hidden ? "0" : "1");
}

/* ---------- folder mode (light workspace) ---------- */

function setSidebarTab(tab: "outline" | "files"): void {
  const outlineActive = tab === "outline";
  tabOutline.classList.toggle("active", outlineActive);
  tabFiles.classList.toggle("active", !outlineActive);
  outlineEl.classList.toggle("tab-hidden", !outlineActive);
  filesPane.hidden = outlineActive;
  localStorage.setItem(SIDEBAR_TAB_KEY, tab);
}

async function openFolderDialog(): Promise<void> {
  const dir = inTauri
    ? await openFileDialog({ directory: true, multiple: false })
    : null;
  if (typeof dir === "string") await openFolder(dir, { reveal: true });
}

async function openFolder(
  dir: string,
  { reveal = false, quiet = false }: { reveal?: boolean; quiet?: boolean } = {},
): Promise<void> {
  try {
    const listing = await invoke<FolderListing>("list_markdown_files", { dir });
    workspaceDir = listing.dir;
    folderListing = listing;
    folderNameEl.textContent = splitPath(listing.dir).name;
    folderNameEl.title = listing.dir;
    folderNameEl.hidden = false;
    folderSearchInput.hidden = false;
    folderSearchInput.value = "";
    renderFileList(listing);
    if (inTauri) void invoke("set_last_folder", { path: listing.dir }).catch(() => {});
    setSidebarTab("files");
    if (reveal) {
      sidebar.hidden = false;
      localStorage.setItem(OUTLINE_KEY, "1");
    }
  } catch (err) {
    // A folder restored from settings that no longer exists must not
    // nag on every launch — forget it silently instead.
    if (quiet) {
      void invoke("set_last_folder", { path: null }).catch(() => {});
      return;
    }
    await showError(err);
  }
}

function renderFileList(listing: FolderListing): void {
  fileListEl.innerHTML = "";

  const rootName = splitPath(listing.dir).name;
  let currentFolder: string | null = null;
  for (const file of listing.files) {
    const lastSlash = file.relPath.lastIndexOf("/");
    const folder = lastSlash === -1 ? "" : file.relPath.slice(0, lastSlash);
    if (folder !== currentFolder) {
      currentFolder = folder;
      const header = document.createElement("div");
      header.className = "file-folder-header";
      header.textContent = folder === "" ? rootName : `${rootName}/${folder}`;
      fileListEl.appendChild(header);
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.path = file.path;
    btn.textContent = file.name;
    btn.title = file.relPath;
    btn.addEventListener("click", () => void openPath(file.path));
    fileListEl.appendChild(btn);
  }

  if (listing.truncated) {
    const note = document.createElement("div");
    note.className = "file-list-note";
    note.textContent = t("folderTruncated");
    fileListEl.appendChild(note);
  }
  highlightActiveFile();
}

function renderSearchResults(results: FolderSearchResults): void {
  fileListEl.innerHTML = "";
  for (const hit of results.hits) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "file-hit";
    btn.dataset.path = hit.path;
    const snippet = document.createElement("span");
    snippet.className = "hit-snippet";
    snippet.textContent = hit.text;
    btn.replaceChildren(`${hit.name} · L${hit.line}`, snippet);
    btn.title = hit.text;
    btn.addEventListener("click", () => void openPath(hit.path));
    fileListEl.appendChild(btn);
  }

  const note = document.createElement("div");
  note.className = "file-list-note";
  note.textContent =
    results.hits.length === 0
      ? t("searchNoResults")
      : t("searchResultsCount", { n: String(results.hits.length) }) +
        (results.truncated ? "+" : "");
  fileListEl.appendChild(note);
  highlightActiveFile();
}

function highlightActiveFile(): void {
  if (!currentFile) return;
  const active = currentFile.path.toLowerCase();
  fileListEl.querySelectorAll("button[data-path]").forEach((el) => {
    const btn = el as HTMLButtonElement;
    btn.classList.toggle("active", btn.dataset.path?.toLowerCase() === active);
  });
}

function runFolderSearch(): void {
  if (!workspaceDir || !folderListing) return;
  const query = folderSearchInput.value.trim();
  if (!query) {
    renderFileList(folderListing);
    return;
  }
  const seq = ++folderSearchSeq;
  void invoke<FolderSearchResults>("search_markdown_files", {
    dir: workspaceDir,
    query,
  })
    .then((results) => {
      // Drop late responses from superseded queries (folder scans can take
      // a while; the debounce alone does not serialize them).
      if (seq === folderSearchSeq) renderSearchResults(results);
    })
    .catch(() => {});
}

/* ---------- print / export PDF ---------- */

let printCleanupTimer: ReturnType<typeof setTimeout> | null = null;

function printDocument(): void {
  if (bodyEl.hidden || !currentFile) return;
  // Print always on the light palette: temporarily drop the dark theme
  // (the dark github-markdown stylesheet is scoped to html[data-theme]).
  const root = document.documentElement;
  const wasDark = root.getAttribute("data-theme") === "dark";
  const restore = () => {
    if (printCleanupTimer) {
      clearTimeout(printCleanupTimer);
      printCleanupTimer = null;
    }
    window.removeEventListener("afterprint", restore);
    if (wasDark) root.setAttribute("data-theme", "dark");
  };
  window.addEventListener("afterprint", restore);
  // Fallback for webviews that never fire afterprint.
  printCleanupTimer = setTimeout(restore, 60_000);
  if (wasDark) root.removeAttribute("data-theme");
  window.print();
}

/* ---------- update check ---------- */

interface UpdateInfo {
  available: boolean;
  currentVersion: string;
  latestVersion: string;
  releaseUrl: string | null;
}

const UPDATE_DISMISS_KEY = "markread.update-dismissed";
let shownUpdate: UpdateInfo | null = null;

function showUpdateBanner(info: UpdateInfo): void {
  shownUpdate = info;
  updateBannerText.textContent = t("updateAvailable", { v: info.latestVersion });
  updateCloseBtn.title = t("updateDismiss");
  updateOpenBtn.hidden = !info.releaseUrl;
  updateBanner.hidden = false;
}

let updateCheckInFlight = false;

async function runUpdateCheck(manual: boolean): Promise<void> {
  if (!inTauri || updateCheckInFlight) return;
  updateCheckInFlight = true;
  try {
    const info = await invoke<UpdateInfo>("check_for_updates");
    if (info.available) {
      // A dismissed version stays dismissed for automatic checks; a manual
      // check always shows the banner again.
      if (!manual && localStorage.getItem(UPDATE_DISMISS_KEY) === info.latestVersion) {
        return;
      }
      showUpdateBanner(info);
    } else if (manual) {
      statusHint(t("updateUpToDate", { v: info.currentVersion }));
    }
  } catch {
    if (manual) statusHint(t("updateCheckFailed"));
  } finally {
    updateCheckInFlight = false;
  }
}

/* ---------- events from the Rust side ---------- */

async function setupListeners(): Promise<void> {
  await listen<string>("open-file", (event) => void openPath(event.payload));
  await listen<string>("file-changed", (event) => handleFileChanged(event.payload));

  await listen<string>("menu-action", (event) => {
    switch (event.payload) {
      case "open":
        void runOpenDialog();
        break;
      case "open-folder":
        void openFolderDialog();
        break;
      case "edit":
        if (isEditing) exitEditMode();
        else enterEditMode();
        break;
      case "save":
        void saveFile();
        break;
      case "print":
        printDocument();
        break;
      case "find":
        if (!bodyEl.hidden) search.open();
        break;
      case "zoom-in":
        changeZoom(0.1);
        break;
      case "zoom-out":
        changeZoom(-0.1);
        break;
      case "zoom-reset":
        zoom = 1;
        void applyZoom();
        break;
      case "toggle-outline":
        toggleSidebar();
        break;
      case "check-updates":
        void runUpdateCheck(true);
        break;
    }
  });

  await listen<string>("theme-changed", async (event) => {
    setThemePreference(event.payload as ThemePreference);
    // Mermaid diagrams bake the palette in at render time.
    if (hasMermaid && currentFile && !isEditing) {
      const gen = ++renderGeneration;
      const snapshot = currentScrollSnapshot();
      await renderDocument(currentFile.content, currentFile.dir);
      if (gen !== renderGeneration) return;
      restoreScroll(scrollPane, bodyEl, snapshot);
    }
  });

  await listen<string>("language-changed", (event) => {
    setLanguage(event.payload as Lang);
    applyI18n();
    updateStatus();
    updateStatusCursor();
    renderOutline(outlineEl, headings, t("outlineEmpty"), bodyEl);
    backToTop.title = t("backToTop");
    backToTop.setAttribute("aria-label", t("backToTop"));
    if (shownUpdate && !updateBanner.hidden) {
      updateBannerText.textContent = t("updateAvailable", { v: shownUpdate.latestVersion });
      updateCloseBtn.title = t("updateDismiss");
    }
  });

  if (inTauri) {
    await getCurrentWindow().onCloseRequested(async (event) => {
      // Always intercept: persist the reading position before the window
      // goes away, then destroy explicitly.
      event.preventDefault();
      await saveReadingPositionNow();
      if (isDirty && !(await confirmDiscardChanges())) return;
      isDirty = false;
      await getCurrentWindow().destroy();
    });

    const webview = getCurrentWebview();
    await webview.onDragDropEvent(async (event) => {
      const type = event.payload.type;
      if (type === "enter" || type === "over") {
        document.body.classList.add("dragging-file");
      } else if (type === "drop") {
        document.body.classList.remove("dragging-file");
        const firstPath = event.payload.paths[0];
        if (firstPath && (await invoke<boolean>("path_is_dir", { path: firstPath }).catch(() => false))) {
          void openFolder(firstPath, { reveal: true });
          return;
        }
        const mdFile = event.payload.paths.find((p) =>
          /\.(md|markdown|mdown|mkd)$/i.test(p),
        );
        if (mdFile) void openPath(mdFile);
      } else {
        document.body.classList.remove("dragging-file");
      }
    });
  }
}

/* ---------- in-browser dev fallback (no native menu available) ---------- */

function setupBrowserShortcuts(): void {
  window.addEventListener("keydown", (ev) => {
    const ctrl = ev.ctrlKey || ev.metaKey;
    if (!ctrl) return;
    if (ev.key === "o") {
      ev.preventDefault();
      void runOpenDialog();
    } else if (ev.key === "f" && !bodyEl.hidden) {
      ev.preventDefault();
      search.open();
    } else if (ev.key === "e" && currentFile) {
      ev.preventDefault();
      if (isEditing) exitEditMode();
      else enterEditMode();
    } else if (ev.key === "s" && currentFile) {
      ev.preventDefault();
      void saveFile();
    } else if (ev.key === "p") {
      ev.preventDefault();
      printDocument();
    } else if (ev.key === "=" || ev.key === "+") {
      ev.preventDefault();
      changeZoom(0.1);
    } else if (ev.key === "-") {
      ev.preventDefault();
      changeZoom(-0.1);
    } else if (ev.key === "0") {
      ev.preventDefault();
      zoom = 1;
      void applyZoom();
    }
  });
}

/* ---------- boot ---------- */

async function boot(): Promise<void> {
  initTheme();
  applySidebarPreference();

  let language = detectLanguage();
  let lastFolder: string | null = null;
  let checkUpdatesOnStartup = false;
  if (inTauri) {
    try {
      const settings = await invoke<{
        language: string;
        lastFolder: string | null;
        checkUpdatesOnStartup: boolean;
      }>("get_settings");
      if (["en", "pt-BR", "es"].includes(settings.language)) {
        language = settings.language as Lang;
      }
      lastFolder = settings.lastFolder;
      checkUpdatesOnStartup = settings.checkUpdatesOnStartup;
    } catch {
      /* fall back to detected locale */
    }
  }
  setLanguage(language);
  applyI18n();
  updateStatus();
  await refreshRecents();

  welcomeOpen.addEventListener("click", () => void runOpenDialog());
  welcomeFolder.addEventListener("click", () => void openFolderDialog());
  openFolderBtn.addEventListener("click", () => void openFolderDialog());
  tabOutline.addEventListener("click", () => setSidebarTab("outline"));
  tabFiles.addEventListener("click", () => setSidebarTab("files"));
  folderSearchInput.addEventListener("input", () => {
    if (folderSearchTimer) clearTimeout(folderSearchTimer);
    folderSearchTimer = setTimeout(runFolderSearch, 300);
  });
  backToTop.addEventListener("click", () => {
    scrollPane.scrollTo({ top: 0, behavior: "smooth" });
  });
  backToTop.title = t("backToTop");
  backToTop.setAttribute("aria-label", t("backToTop"));
  editorToolbar.setAttribute("aria-label", t("editorToolbarLabel"));
  editorEl.setAttribute("aria-label", t("editorSourceLabel"));
  updateCloseBtn.setAttribute("aria-label", t("updateDismiss"));
  setSidebarTab(localStorage.getItem(SIDEBAR_TAB_KEY) === "files" ? "files" : "outline");
  clearRecentBtn.addEventListener("click", () => {
    if (inTauri) void invoke("clear_recent_files").then(() => refreshRecents());
  });
  updateOpenBtn.addEventListener("click", () => {
    if (shownUpdate?.releaseUrl) void openUrl(shownUpdate.releaseUrl);
  });
  updateCloseBtn.addEventListener("click", () => {
    updateBanner.hidden = true;
    if (shownUpdate) localStorage.setItem(UPDATE_DISMISS_KEY, shownUpdate.latestVersion);
  });

  editorEl.addEventListener("input", () => {
    markDirty();
    schedulePreviewUpdate();
    updateStatusCursor();
  });
  editorEl.addEventListener("keydown", (ev) => {
    if (ev.key === "Tab") {
      ev.preventDefault();
      editorEl.setRangeText(
        "\t",
        editorEl.selectionStart,
        editorEl.selectionEnd,
        "end",
      );
      markDirty();
      schedulePreviewUpdate();
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      exitEditMode();
    } else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "b") {
      ev.preventDefault();
      runEditorCommand("bold");
    } else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "i") {
      ev.preventDefault();
      runEditorCommand("italic");
    }
  });
  editorEl.addEventListener("scroll", () => {
    // Proportional source → preview scroll sync (editor is the master).
    const editorMax = editorEl.scrollHeight - editorEl.clientHeight;
    if (editorMax <= 0) return;
    const ratio = editorEl.scrollTop / editorMax;
    const preview = editorPreviewScroll;
    preview.scrollTop = ratio * (preview.scrollHeight - preview.clientHeight);
  }, { passive: true });
  document.addEventListener("selectionchange", () => {
    if (isEditing) updateStatusCursor();
  });
  editorToolbar.addEventListener("click", (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>("[data-cmd]");
    if (btn?.dataset.cmd) runEditorCommand(btn.dataset.cmd);
  });

  let progressTicking = false;
  scrollPane.addEventListener(
    "scroll",
    () => {
      if (progressTicking) return;
      progressTicking = true;
      requestAnimationFrame(() => {
        progressTicking = false;
        updateReadingProgress();
        scheduleSaveReadingPosition();
        backToTop.classList.toggle(
          "visible",
          !!currentFile && !bodyEl.hidden && scrollPane.scrollTop > 480,
        );
      });
    },
    { passive: true },
  );

  if (!inTauri) setupBrowserShortcuts();

  try {
    await setupListeners();
  } catch (err) {
    console.error("listener setup failed", err);
  }
  await applyZoom();

  if (inTauri) {
    try {
      const pending = await invoke<string | null>("take_pending_file");
      if (pending) await openPath(pending);
    } catch (err) {
      console.error(err);
    }
    if (lastFolder) await openFolder(lastFolder, { quiet: true });
    if (checkUpdatesOnStartup) void runUpdateCheck(false);
  }
}

void boot();
