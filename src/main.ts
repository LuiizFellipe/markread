import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, message, open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import "./app.css";
import "github-markdown-css/github-markdown-light.css";
import darkGithubCss from "github-markdown-css/github-markdown-dark.css?raw";
import { applyI18n, detectLanguage, setLanguage, t, type Lang } from "./i18n";
import { enhanceRendered, renderMarkdown } from "./renderer";
import { initSearch, resetSearch } from "./search";
import { initEditorSearch } from "./editorSearch";
import {
  collectHeadings,
  initScrollSpy,
  renderOutline,
  type Heading,
} from "./outline";
import { getThemePreference, initTheme, setThemePreference, type ThemePreference } from "./theme";
import { countWords, formatBytes, readingMinutes } from "./status";
import { renderMermaidBlocks } from "./mermaid";
import {
  captureScroll,
  restoreScroll,
  type ScrollSnapshot,
} from "./scroll";
import { attachDragResize } from "./resizer";
import { initTabbar, type FileInfo, type Tab } from "./tabs";

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
const isMac = /mac/i.test(navigator.platform);

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
const replaceRow = $<HTMLElement>("#replace-row");
const replaceInput = $<HTMLInputElement>("#replace-input");
const replaceOneBtn = $<HTMLButtonElement>("#replace-one");
const replaceAllBtn = $<HTMLButtonElement>("#replace-all");
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
const statusSave = $<HTMLElement>("#status-save");
const progressEl = $<HTMLElement>("#reading-progress");
const backToTop = $<HTMLButtonElement>("#back-to-top");
const editorArea = $<HTMLElement>("#editor-area");
const editorToolbar = $<HTMLElement>("#editor-toolbar");
const editorSplit = $<HTMLElement>("#editor-split");
const splitResizer = $<HTMLElement>("#editor-split-resizer");
const editorPreviewEl = $<HTMLElement>("#editor-preview");
const editorPreviewScroll = $<HTMLElement>("#editor-preview-scroll");
const groupOutline = $<HTMLElement>("#group-outline");
const groupFiles = $<HTMLElement>("#group-files");
const groupRecents = $<HTMLElement>("#group-recents");
const welcomeFolder = $<HTMLButtonElement>("#welcome-folder");
const welcomeNew = $<HTMLButtonElement>("#welcome-new");
const sideCollapse = $<HTMLButtonElement>("#side-collapse");
const sideFloatOpen = $<HTMLButtonElement>("#side-float-open");
const sidebarResizer = $<HTMLElement>("#sidebar-resizer");
const folderNameEl = $<HTMLElement>("#folder-name");
const folderSearchInput = $<HTMLInputElement>("#folder-search");
const fileListEl = $<HTMLElement>("#file-list");
const zoomLabel = $<HTMLElement>("#zoom-label");
const langSelect = $<HTMLSelectElement>("#lang-select");
const themeSegment = $<HTMLElement>("#theme-segment");
const updateBanner = $<HTMLElement>("#update-banner");
const updateBannerText = $<HTMLElement>("#update-banner-text");
const updateOpenBtn = $<HTMLButtonElement>("#update-open");
const updateCloseBtn = $<HTMLButtonElement>("#update-close");

const search = initSearch(bodyEl, findbar, findInput, findCount, () => !isEditing);
let editorFindTimer: ReturnType<typeof setTimeout> | null = null;
const editorSearch = initEditorSearch({
  editor: editorEl,
  findbar,
  findInput,
  countEl: findCount,
  replaceRow,
  replaceInput,
  replaceOneBtn,
  replaceAllBtn,
  isActive: () => isEditing,
  replaceRange: (start, end, text) => editorReplace(start, end, text),
});
const updateScrollSpy = initScrollSpy(scrollPane, outlineEl, () => headings, bodyEl);

/** Ctrl+F (and the sidebar/menu Find) route to whichever search makes sense
 *  for the active mode: rendered page in reading, buffer in editing. */
function openFind(withReplace = false): void {
  if (!currentFile) return;
  if (isEditing) editorSearch.open(withReplace);
  else search.open();
}

let headings: Heading[] = [];
let currentFile: FileInfo | null = null;
let isEditing = false;
let isDirty = false;
/** True while currentFile is the in-memory "new file" buffer (path: ""). */
let isUntitled = false;
/** Bumped on every buffer mutation; lets a finished save tell whether edits
 *  landed while the write was in flight (they must stay dirty). */
let editSeq = 0;
/** Content the app last read from / wrote to disk, for auto-save conflict
 *  detection (an external write in between must not be clobbered). */
let lastSavedContent: string | null = null;
let fileUsesCrlf = false;
let hasMermaid = false;
/** Bumped on every committed render; async render pipelines abort after
 *  each await when theirs is no longer the newest generation. */
let renderGeneration = 0;
/** The generation whose render is actually in the DOM — a scroll snapshot
 *  is only trustworthy when it matches the current generation. */
let renderedGeneration = -1;

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

/* ---------- tabs state ---------- */

const tabbarRow = $<HTMLElement>("#tabbar-row");
const tabbarEl = $<HTMLElement>("#tabbar");
const tabNewBtn = $<HTMLButtonElement>("#tab-new");

const tabbar = initTabbar(tabbarEl, tabNewBtn, {
  onActivate: (id) => void activateTab(id),
  onClose: (id) => void closeTab(id),
  onNew: () => void createNewFile(),
});

let tabs: Tab[] = [];
let activeTabId: number | null = null;
let nextTabId = 1;

function getActiveTab(): Tab | null {
  if (activeTabId === null) return null;
  return tabs.find((tab) => tab.id === activeTabId) ?? null;
}

/** Mirror the live document state into the active tab (after a save, a
 *  reload, or any change the tab's cached fields must reflect). */
function syncActiveTab(): void {
  const tab = getActiveTab();
  if (!tab) return;
  tab.file = currentFile ?? tab.file;
  tab.untitled = isUntitled;
  tab.dirty = isDirty;
  tab.lastSavedContent = lastSavedContent;
  tab.fileUsesCrlf = fileUsesCrlf;
  tab.editSeq = editSeq;
}

function createTabForFile(file: FileInfo): Tab {
  return {
    id: nextTabId++,
    file,
    untitled: false,
    dirty: false,
    editing: false,
    buffer: null,
    lastSavedContent: file.content,
    fileUsesCrlf: file.content.includes("\r\n"),
    editSeq: 0,
    scroll: null,
    editorScrollTop: 0,
  };
}

function renderTabbar(): void {
  tabbarRow.hidden = tabs.length === 0;
  tabbar.render(
    tabs.map((tab) => ({
      id: tab.id,
      name: tab.untitled ? t("statusUntitled") : tab.file.name,
      path: tab.file.path,
      dirty: tab.dirty,
    })),
    activeTabId,
  );
}

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
  updateZoomLabel();
}

/* ---------- sidebar footer controls (theme + language) ---------- */

function syncThemeSegment(): void {
  const current = getThemePreference();
  themeSegment.querySelectorAll<HTMLButtonElement>("button[data-theme-pref]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.themePref === current);
  });
}

/* ---------- status ---------- */

function updateStatus(): void {
  if (!currentFile) {
    statusFile.textContent = t("statusNoFile");
    statusFile.removeAttribute("title");
    statusMeta.textContent = "";
    return;
  }
  statusFile.textContent = isUntitled ? t("statusUntitled") : currentFile.name;
  if (currentFile.path) statusFile.title = currentFile.path;
  else statusFile.removeAttribute("title");
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
  enhanceRendered(bodyEl, dir, documentLinkHandlers);
  hasMermaid = await renderMermaidBlocks(bodyEl);
  headings = collectHeadings(bodyEl);
  renderOutline(outlineEl, headings, t("outlineEmpty"), bodyEl);
  updateScrollSpy();
  renderedGeneration = renderGeneration;
}

/** Link behavior shared by the reading view and the editor preview. */
const documentLinkHandlers = {
  onOpenMarkdownFile: (path: string) => void openPath(path),
  onOpenWikiLink: (target: string) => void resolveWikiLink(target),
};

/* ---------- clickable task checkboxes + wiki links (reading mode) ---------- */

/** All toggleable task markers, in document order — the same order the
 *  renderer used when assigning data-task-index to the checkboxes.
 *  Blockquote prefixes are part of the marker (they render checkboxes);
 *  fenced code is masked out before counting because the renderer never
 *  checkboxes those lines. */
const TASK_MARKER_RE = /^([ \t]*(?:>[ \t]*)*(?:[-*+]|\d+[.)])[ \t]+\[)([ xX])(\])/gm;

/** Replace fenced (``` / ~~~) lines with same-length space runs, so match
 *  offsets in the masked copy are also valid offsets in the real source. */
function maskFencedLines(content: string): string {
  let fenceChar = "";
  let fenceLen = 0;
  return content
    .split("\n")
    .map((line) => {
      const open = /^\s*(`{3,}|~{3,})/.exec(line);
      if (fenceChar) {
        if (open && open[1][0] === fenceChar && open[1].length >= fenceLen) {
          fenceChar = "";
        }
        return " ".repeat(line.length);
      }
      if (open) {
        fenceChar = open[1][0];
        fenceLen = open[1].length;
      }
      return line;
    })
    .join("\n");
}

function toggleTaskMarker(content: string, index: number): string | null {
  const masked = maskFencedLines(content);
  const marks: Array<{ start: number; end: number; char: string }> = [];
  TASK_MARKER_RE.lastIndex = 0;
  for (
    let match = TASK_MARKER_RE.exec(masked);
    match !== null;
    match = TASK_MARKER_RE.exec(masked)
  ) {
    const markStart = match.index + match[1].length;
    marks.push({ start: markStart, end: markStart + 1, char: match[2] });
  }
  const target = marks[index];
  if (!target) return null;
  const flipped = target.char === " " ? "x" : " ";
  return content.slice(0, target.start) + flipped + content.slice(target.end);
}

async function toggleTaskInDocument(index: number): Promise<void> {
  if (!currentFile || isUntitled || isEditing) return;
  const updated = toggleTaskMarker(currentFile.content, index);
  if (updated === null || updated === currentFile.content) return;
  currentFile.content = updated;
  // Persist through the regular auto-save path (conflict detection intact),
  // then re-render so the checkbox reflects the file on disk rather than
  // the pre-render DOM click.
  await saveFile({ auto: true });
  if (!currentFile || isEditing) return;
  const gen = ++renderGeneration;
  const snapshot = currentScrollSnapshot();
  await renderDocument(currentFile.content, currentFile.dir);
  if (gen !== renderGeneration || isEditing) return;
  restoreScroll(scrollPane, bodyEl, snapshot);
  resetSearch(search);
  updateStatus();
}

/** `[[Target]]`: try a sibling of the current file first, then the open
 *  workspace listing. Whatever escapes both is reported, never opened. */
async function resolveWikiLink(target: string): Promise<void> {
  const trimmed = target.trim();
  if (!trimmed) return;
  if (currentFile?.dir && inTauri) {
    const resolved = await invoke<string | null>("resolve_wiki_link", {
      baseDir: currentFile.dir,
      target: trimmed,
    }).catch(() => null);
    if (resolved) {
      void openPath(resolved);
      return;
    }
  }
  const inWorkspace = matchWorkspaceFile(trimmed);
  if (inWorkspace) {
    void openPath(inWorkspace);
    return;
  }
  statusHint(t("wikiNotFound", { name: trimmed }));
}

/** RelPath or basename match (case-insensitive, .md optional) against the
 *  open folder's listing, preferring files next to the current one. */
function matchWorkspaceFile(target: string): string | null {
  if (!folderListing) return null;
  const stripExt = (s: string) => s.replace(/\.(md|markdown|mdown|mkd)$/i, "");
  const normalized = stripExt(target.replaceAll("\\", "/").toLowerCase());
  const needleRel = normalized;
  const needleName = stripExt(splitPath(normalized).name);
  const currentDir = currentFile ? currentFile.dir.toLowerCase() : "";
  let first: string | null = null;
  for (const file of folderListing.files) {
    const rel = file.relPath.toLowerCase();
    if (stripExt(rel) !== needleRel && stripExt(splitPath(rel).name) !== needleName) {
      continue;
    }
    first ??= file.path;
    // The separator check keeps /ws/notes2 from matching a /ws/notes file.
    const path = file.path.toLowerCase();
    if (
      currentDir &&
      path.startsWith(currentDir) &&
      path.length > currentDir.length &&
      /[/\\]/.test(path[currentDir.length])
    ) {
      return file.path;
    }
  }
  return first;
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
  const name = isUntitled ? t("statusUntitled") : currentFile.name;
  const dirtyMark = isDirty ? "• " : "";
  void getCurrentWindow()
    .setTitle(`${dirtyMark}${name} — MarkRead`)
    .catch(() => {});
}

function markDirty(): void {
  editSeq++;
  if (!isDirty) {
    isDirty = true;
    syncActiveTab(); // the tab strip renders from the tab, not the globals
    renderTabbar();
    updateWindowTitle();
  }
  scheduleAutosave();
  updateStatus();
}

/** Whether the untitled buffer carries no content worth prompting for. */
function untitledBufferEmpty(): boolean {
  if (!currentFile) return true;
  return (isEditing ? editorEl.value : currentFile.content).trim() === "";
}

/** Whether pending edits may be discarded (false = cancel the action).
 *  An untitled buffer is offered a save dialog; cancelling that keeps the
 *  buffer instead of silently discarding it. */
async function confirmDiscardChanges(): Promise<boolean> {
  if (!isDirty || !inTauri) return true;
  if (isUntitled) {
    if (untitledBufferEmpty()) return true;
    const save = await ask(t("unsavedUntitledMessage"), {
      title: t("unsavedTitle"),
      kind: "warning",
    });
    if (!save) return false;
    return saveFileAs();
  }
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
  enhanceRendered(editorPreviewEl, dir, documentLinkHandlers, { disableTasks: true });
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

/** List markers that continue on Enter: indent + bullet or ordered number,
 *  plus an optional checkbox. Headings/blockquotes (LINE_MARKER) and plain
 *  "-" without a space intentionally do not continue. */
const LIST_MARKER = /^([ \t]*)(?:([-*+])|(\d+)([.)]))[ \t]+(\[[ xX]][ \t]+)?/;

/** Enter inside a list item continues the list: same indent, same bullet,
 *  checkbox reset to unchecked, ordered number incremented. Enter on an
 *  empty item drops the marker and leaves the list. True = key handled. */
function continueListOnEnter(): boolean {
  const value = editorEl.value;
  const anchor = editorEl.selectionStart;
  const lineStart = anchor === 0 ? 0 : value.lastIndexOf("\n", anchor - 1) + 1;
  let lineEnd = value.indexOf("\n", anchor);
  if (lineEnd === -1) lineEnd = value.length;
  const match = LIST_MARKER.exec(value.slice(lineStart, lineEnd));
  if (!match) return false;
  const [, indent, bullet, num, delim, checkbox] = match;
  if (value.slice(lineStart + match[0].length, lineEnd).trim() === "") {
    // Empty item: pressing Enter again exits the list instead of spawning
    // another empty marker. Swallow the newline too, so no blank line is
    // left behind inside (or after) the list.
    const removeEnd = lineEnd < value.length ? lineEnd + 1 : lineEnd;
    editorReplace(lineStart, removeEnd, "", lineStart, lineStart);
    return true;
  }
  const next = bullet
    ? `${indent}${bullet} ${checkbox ? "[ ] " : ""}`
    : `${indent}${Number(num) + 1}${delim} ${checkbox ? "[ ] " : ""}`;
  const start = editorEl.selectionStart;
  const text = `\n${next}`;
  editorReplace(start, editorEl.selectionEnd, text, start + text.length);
  return true;
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
  if (!inTauri || !currentFile || isUntitled || bodyEl.hidden) return;
  try {
    const snap = currentScrollSnapshot();
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
  if (!inTauri || !currentFile || isUntitled) return;
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
  const path = currentFile.path;
  let file: FileInfo;
  try {
    file = await invoke<FileInfo>("read_markdown_file", { path });
  } catch {
    if (currentFile && currentFile.path === path) statusHint(t("fileUnavailable"));
    return;
  }
  // The document may have switched while reading; only the live one reloads.
  if (!currentFile || currentFile.path !== path) return;
  // Same content on disk: our own save round-tripping through the watcher.
  if (file.content === currentFile.content) return;
  if (isEditing) {
    // Never clobber the editor buffer; surface the divergence instead.
    statusHint(t("fileChangedOnDisk"));
    return;
  }
  // Confirmed external change: only now claim the render pipeline. Bumping
  // earlier would abort unrelated in-flight renders (e.g. the one that
  // follows exitEditMode while our own save echoes through the watcher).
  const gen = ++renderGeneration;
  lastSavedContent = file.content;
  const snapshot = currentScrollSnapshot();
  fileUsesCrlf = file.content.includes("\r\n");
  currentFile = file;
  syncActiveTab();
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

/* ---------- paste images from the clipboard ---------- */

const MAX_PASTE_IMAGE_BYTES = 20 * 1024 * 1024;

interface SavedImage {
  path: string;
  name: string;
}

/** Path of the saved image relative to the document folder, so the markdown
 *  link keeps working when the folder moves. */
function relativeImagePath(dir: string, filePath: string): string {
  const base = dir.replaceAll("\\", "/").replace(/\/+$/, "") + "/";
  const full = filePath.replaceAll("\\", "/");
  return full.startsWith(base) ? full.slice(base.length) : full;
}

function insertAtCursor(text: string): void {
  const start = editorEl.selectionStart;
  const end = editorEl.selectionEnd;
  editorReplace(start, end, text, start + text.length);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let at = 0; at < bytes.length; at += chunk) {
    binary += String.fromCharCode(...bytes.subarray(at, at + chunk));
  }
  return btoa(binary);
}

/** Save every clipboard image next to the document and insert the markdown
 *  link at the caret. The untitled buffer has no folder yet, so it asks to
 *  be saved first instead of guessing a location. */
async function pasteImages(files: File[]): Promise<void> {
  if (!currentFile) return;
  if (isUntitled) {
    statusHint(t("pasteImageNeedsSave"));
    return;
  }
  const dir = currentFile.dir;
  for (const file of files) {
    const ext = (file.type.split("/")[1] ?? "png").toLowerCase();
    if (file.size > MAX_PASTE_IMAGE_BYTES) {
      statusHint(t("pasteImageTooLarge"));
      continue;
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const saved = await invoke<SavedImage>("save_clipboard_image", {
        dir,
        data: bytesToBase64(bytes),
        ext,
      });
      const rel = relativeImagePath(dir, saved.path);
      const alt = saved.name.replace(/\.[^.]+$/, "");
      const target = /[\s()]/.test(rel) ? `<${rel}>` : rel;
      insertAtCursor(`![${alt}](${target})\n`);
    } catch {
      statusHint(t("pasteImageFailed"));
    }
  }
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
  editorSearch.close();
  previewGeneration++; // drop in-flight preview renders
  if (previewTimer) {
    clearTimeout(previewTimer);
    previewTimer = null;
  }
  hideEditorArea();
  statusCursor.hidden = true;
  currentFile.content = applyFileLineEndings(editorEl.value);
  // Back to reading: persist right away instead of waiting for the debounce.
  cancelAutosave();
  if (isDirty && !isUntitled) void saveFile({ auto: true });
  const gen = ++renderGeneration;
  void renderDocument(currentFile.content, currentFile.dir).then(() => {
    if (gen !== renderGeneration || isEditing) return;
    showDocument();
    updateStatus();
    updateReadingProgress();
  });
}

/* ---------- auto-save + save indicator ---------- */

const AUTOSAVE_DEBOUNCE = 1000;
let autosaveTimer: ReturnType<typeof setTimeout> | null = null;

/** Only documents that already live on disk auto-save; the untitled buffer
 *  stays manual until the user picks a path (Ctrl+S → save dialog). */
function scheduleAutosave(): void {
  if (!inTauri || !currentFile || isUntitled) return;
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => void saveFile({ auto: true }), AUTOSAVE_DEBOUNCE);
}

function cancelAutosave(): void {
  if (autosaveTimer) {
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
  }
}

let saveIndicatorTimer: ReturnType<typeof setTimeout> | null = null;

function setSaveIndicator(state: "saving" | "saved" | "error" | "idle"): void {
  if (saveIndicatorTimer) {
    clearTimeout(saveIndicatorTimer);
    saveIndicatorTimer = null;
  }
  if (state === "idle") {
    statusSave.hidden = true;
    return;
  }
  statusSave.textContent = t(
    state === "saving" ? "statusSaving" : state === "error" ? "statusSaveFailed" : "statusSaved",
  );
  statusSave.dataset.state = state;
  statusSave.hidden = false;
  if (state === "saved") {
    saveIndicatorTimer = setTimeout(() => {
      saveIndicatorTimer = null;
      statusSave.hidden = true;
    }, 2000);
  }
}

async function saveFile(opts: { auto?: boolean } = {}): Promise<void> {
  if (!currentFile) return;
  if (isUntitled) {
    await saveFileAs();
    return;
  }
  cancelAutosave();
  const target = currentFile;
  const seq = editSeq;
  const content = isEditing
    ? applyFileLineEndings(editorEl.value)
    : target.content;
  target.content = content;
  if (!inTauri) return;
  setSaveIndicator("saving");
  try {
    // An auto-save must never clobber edits made outside the app since our
    // last write; a manual save is explicit user intent and writes anyway.
    if (opts.auto && lastSavedContent !== null) {
      const disk = await invoke<FileInfo>("read_markdown_file", { path: target.path });
      if (currentFile !== target) return;
      if (disk.content !== lastSavedContent) {
        setSaveIndicator("error");
        statusHint(t("fileChangedOnDisk"));
        return;
      }
    }
    const file = await invoke<FileInfo>("write_markdown_file", {
      path: target.path,
      content,
    });
    // The document may have switched while the write was in flight; only
    // the document that started the save adopts its result.
    if (currentFile !== target) return;
    currentFile = file;
    isDirty = seq !== editSeq;
    lastSavedContent = file.content;
    setSaveIndicator("saved");
    syncActiveTab();
    renderTabbar();
    updateWindowTitle();
    updateStatus();
  } catch (err) {
    if (currentFile !== target) return;
    setSaveIndicator("error");
    // A background auto-save must not interrupt with a modal; the dirty
    // flag stays set so nothing is lost.
    if (opts.auto) return;
    await message(String(err), { title: t("saveErrorTitle"), kind: "error" });
  }
}

/** Save the untitled buffer through a dialog; returns whether it landed. */
async function saveFileAs(): Promise<boolean> {
  if (!currentFile || !inTauri) return false;
  const defaultDir = workspaceDir ?? (currentFile.dir || null);
  const defaultPath = defaultDir
    ? joinPath(defaultDir, t("newFileUntitled"))
    : t("newFileUntitled");
  const path = await saveFileDialog({
    defaultPath,
    title: t("actSave"),
    filters: [{ name: "Markdown", extensions: ["md", "markdown", "mdown", "mkd"] }],
  });
  if (typeof path !== "string") return false;
  // Overwriting an existing file keeps its line endings; a new file is LF.
  try {
    const existing = await invoke<FileInfo>("read_markdown_file", { path });
    fileUsesCrlf = existing.content.includes("\r\n");
  } catch {
    fileUsesCrlf = false;
  }
  const seq = editSeq;
  const content = isEditing
    ? applyFileLineEndings(editorEl.value)
    : currentFile.content;
  currentFile.content = content;
  setSaveIndicator("saving");
  try {
    const file = await invoke<FileInfo>("write_markdown_file", { path, content });
    currentFile = file;
    isUntitled = false;
    isDirty = seq !== editSeq;
    lastSavedContent = file.content;
    setSaveIndicator("saved");
    syncActiveTab();
    renderTabbar();
    persistSession();
    updateWindowTitle();
    updateStatus();
    updateGroupVisibility();
    try {
      await invoke("watch_file", { path });
    } catch {
      /* auto-reload unavailable for this path — editing still works */
    }
    await invoke("push_recent_file", { path });
    void refreshRecents();
    highlightActiveFile();
    // Edits typed while the dialog/write were open need a new auto-save.
    if (isDirty) scheduleAutosave();
    return true;
  } catch (err) {
    setSaveIndicator("error");
    await message(String(err), { title: t("saveErrorTitle"), kind: "error" });
    return false;
  }
}

async function openPath(path: string): Promise<FileInfo | null> {
  // An already-open document comes to front instead of duplicating.
  const key = path.toLowerCase();
  const existing = tabs.find(
    (tab) => !tab.untitled && tab.file.path.toLowerCase() === key,
  );
  if (existing) {
    await activateTab(existing.id);
    return existing.file;
  }
  let file: FileInfo;
  try {
    file = await invoke<FileInfo>("read_markdown_file", { path });
  } catch (err) {
    await showError(err);
    return null;
  }
  const tab = createTabForFile(file);
  tabs.push(tab);
  renderTabbar();
  await activateTab(tab.id);
  if (inTauri) {
    try {
      await invoke("push_recent_file", { path });
    } catch {
      /* recents are best-effort */
    }
    void refreshRecents();
  }
  persistSession();
  return file;
}

/* ---------- tabs (activate / close / session) ---------- */

/** Copy the active document's live state into its tab so another tab can
 *  take over the shared UI. Must run before the active pointer moves. */
function stashActiveTab(): void {
  const tab = getActiveTab();
  if (!tab) return;
  syncActiveTab();
  tab.editing = isEditing;
  tab.buffer = isEditing ? editorEl.value : null;
  if (isEditing) {
    tab.editorScrollTop = editorEl.scrollTop;
    tab.scroll = null;
  } else if (!bodyEl.hidden && renderedGeneration === renderGeneration) {
    // Only capture scroll when the DOM actually belongs to this tab's
    // document — mid-activation switches would snapshot the other doc.
    tab.scroll = currentScrollSnapshot();
  }
}

async function activateTab(id: number): Promise<void> {
  if (id === activeTabId) return;
  const target = tabs.find((tab) => tab.id === id);
  if (!target) return;
  // Outgoing tab: flush its save + persist the reading position first —
  // both run against the shared globals while they still hold this tab.
  cancelAutosave();
  if (isDirty && currentFile && !isUntitled) await saveFile({ auto: true });
  if (currentFile && !isUntitled && !isEditing && !bodyEl.hidden) {
    await saveReadingPositionNow();
  }
  stashActiveTab();
  activeTabId = id;
  renderTabbar();
  persistSession();
  // Find state is per document: marks/counts from the previous document
  // would be stale in the new one.
  editorSearch.close();
  search.close();

  const gen = ++renderGeneration;
  currentFile = target.file;
  isUntitled = target.untitled;
  isDirty = target.dirty;
  isEditing = target.editing;
  lastSavedContent = target.lastSavedContent;
  fileUsesCrlf = target.fileUsesCrlf;
  editSeq = target.editSeq;
  editorEl.value = target.buffer ?? "";
  statusCursor.hidden = true;
  updateGroupVisibility();
  if (target.editing) {
    welcome.hidden = true;
    bodyEl.hidden = true;
    showEditorArea();
    backToTop.classList.remove("visible");
    // The file watcher is a single resource pointed at the active document:
    // re-arm it, or external changes to this buffer would go unnoticed.
    if (inTauri && !isUntitled && currentFile.path) {
      void invoke("watch_file", { path: currentFile.path }).catch(() => {});
    }
    void updateEditorPreview();
    editorEl.scrollTop = target.editorScrollTop;
    editorEl.focus();
    updateStatus();
    updateStatusCursor();
    // Surface external changes that landed while this tab was in the
    // background; while editing this only ever hints, never clobbers.
    if (inTauri && !isUntitled) void reloadCurrentFile();
  } else {
    let saved: ReadingPosition | null = null;
    if (!target.scroll && !isUntitled && inTauri) {
      saved = await invoke<ReadingPosition | null>("get_reading_position", {
        path: currentFile.path,
      }).catch(() => null);
    }
    if (gen !== renderGeneration || activeTabId !== id) return;
    hideEditorArea();
    await renderDocument(currentFile.content, currentFile.dir);
    if (gen !== renderGeneration || activeTabId !== id) return;
    showDocument();
    if (target.scroll) {
      restoreScroll(scrollPane, bodyEl, target.scroll);
    } else {
      restoreScroll(scrollPane, bodyEl, {
        top: saved?.scrollTop ?? 0,
        height: saved?.scrollHeight ?? 0,
        anchorId: saved?.anchorId ?? null,
        anchorOffset: saved?.anchorOffset ?? 0,
      });
    }
    updateReadingProgress();
    if (inTauri && !isUntitled && currentFile.path) {
      void invoke("watch_file", { path: currentFile.path }).catch(() => {});
    }
    updateStatus();
    // A clean reading tab silently catches up with disk changes that
    // happened while it was in the background (reloadCurrentFile no-ops
    // when the content already matches).
    if (!isDirty && !isUntitled && inTauri) void reloadCurrentFile();
  }
  updateWindowTitle();
  highlightActiveFile();
}

async function closeTab(id: number): Promise<void> {
  const index = tabs.findIndex((tab) => tab.id === id);
  if (index === -1) return;
  // The discard prompt works on the active document, so a dirty background
  // tab is activated first.
  if (id !== activeTabId && tabs[index].dirty) await activateTab(id);
  if (id === activeTabId && isDirty) {
    if (!(await confirmDiscardChanges())) return;
    // Discarded: clear the flag or the outgoing flush on the next
    // activation would silently re-save the rejected content.
    isDirty = false;
  }
  const currentIndex = tabs.findIndex((tab) => tab.id === id);
  tabs.splice(currentIndex, 1);
  if (id === activeTabId) {
    const next = tabs[currentIndex] ?? tabs[currentIndex - 1] ?? null;
    if (next) {
      await activateTab(next.id);
    } else {
      closeLastTab();
    }
  }
  renderTabbar();
  persistSession();
}

/** All tabs gone: back to the welcome screen. */
function closeLastTab(): void {
  activeTabId = null;
  currentFile = null;
  isEditing = false;
  isDirty = false;
  isUntitled = false;
  renderGeneration++;
  editorSearch.close();
  search.close();
  hideEditorArea();
  statusCursor.hidden = true;
  welcome.hidden = false;
  bodyEl.hidden = true;
  progressEl.hidden = true;
  backToTop.classList.remove("visible");
  updateStatus();
  updateGroupVisibility();
  if (inTauri) void getCurrentWindow().setTitle("MarkRead").catch(() => {});
}

function cycleTab(delta: number): void {
  if (tabs.length < 2 || activeTabId === null) return;
  const index = tabs.findIndex((tab) => tab.id === activeTabId);
  const next = tabs[(index + delta + tabs.length) % tabs.length];
  void activateTab(next.id);
}

let sessionTimer: ReturnType<typeof setTimeout> | null = null;

/** Persist the open (named) tabs + active index for the next launch. */
function persistSession(): void {
  if (!inTauri) return;
  if (sessionTimer) clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => {
    const named = tabs.filter((tab) => !tab.untitled);
    const paths = named.map((tab) => tab.file.path);
    // The index is over the restored (named) set, not the full tab strip —
    // untitled tabs never come back from a session.
    const active = named.findIndex((tab) => tab.id === activeTabId);
    void invoke("set_session", {
      openTabs: paths,
      activeTab: active === -1 ? 0 : active,
    }).catch(() => {});
  }, 300);
}

async function restoreSession(paths: string[], activeIndex: number): Promise<void> {
  for (const path of paths.slice(0, 20)) {
    try {
      const file = await invoke<FileInfo>("read_markdown_file", { path });
      tabs.push(createTabForFile(file));
    } catch {
      /* gone since last session — skip */
    }
  }
  if (tabs.length === 0) return;
  renderTabbar();
  const index = Math.min(Math.max(activeIndex, 0), tabs.length - 1);
  await activateTab(tabs[index].id);
}

/** Window close: flush every document's auto-save, then prompt only for
 *  what is still unsaved (untitled buffers get the save dialog). */
async function confirmCloseAllTabs(): Promise<boolean> {
  if (isDirty && currentFile && !isUntitled) await saveFile({ auto: true });
  for (const tab of [...tabs]) {
    if (!tab.dirty) continue;
    if (tab.id !== activeTabId) await activateTab(tab.id);
    if (isDirty && !isUntitled) await saveFile({ auto: true });
    if (!isDirty) continue;
    if (!(await confirmDiscardChanges())) return false;
  }
  return true;
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

/* ---------- sidebar (ZCode-style actions + groups) ---------- */

const OUTLINE_KEY = "markread.outline";

function applySidebarPreference(): void {
  // The sidebar is the main navigation now: visible unless explicitly hidden.
  sidebar.hidden = localStorage.getItem(OUTLINE_KEY) === "0";
  sideFloatOpen.hidden = !sidebar.hidden;
}

function toggleSidebar(): void {
  sidebar.hidden = !sidebar.hidden;
  localStorage.setItem(OUTLINE_KEY, sidebar.hidden ? "0" : "1");
  sideFloatOpen.hidden = !sidebar.hidden;
}

function revealSidebar(): void {
  sidebar.hidden = false;
  localStorage.setItem(OUTLINE_KEY, "1");
  sideFloatOpen.hidden = true;
}

function updateGroupVisibility(): void {
  groupOutline.hidden = !currentFile;
  groupFiles.hidden = !workspaceDir;
  groupRecents.hidden = false;
}

/* ---------- sidebar resize ---------- */

const SIDEBAR_WIDTH_KEY = "markread.sidebar-width";
const SIDEBAR_WIDTH_DEFAULT = 276;
const SIDEBAR_MIN = 220;
const SIDEBAR_MAX = 480;

function applySidebarWidth(px: number, persist = true): void {
  const width = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(px)));
  document.documentElement.style.setProperty("--sidebar-width", `${width}px`);
  if (persist) localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
}

function setupSidebarResize(): void {
  const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY);
  const saved = raw === null ? NaN : Number(raw);
  applySidebarWidth(Number.isFinite(saved) ? saved : SIDEBAR_WIDTH_DEFAULT, false);

  attachDragResize(sidebarResizer, {
    onMove: (ev) => {
      // Live update is visual only; persisting on every move would hammer
      // localStorage ~60×/s.
      applySidebarWidth(ev.clientX, false);
    },
    onEnd: () => {
      const width = parseInt(
        document.documentElement.style.getPropertyValue("--sidebar-width"),
        10,
      );
      if (Number.isFinite(width)) localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
    },
  });
  sidebarResizer.addEventListener("dblclick", () => {
    applySidebarWidth(SIDEBAR_WIDTH_DEFAULT);
  });
}

/* ---------- editor: split source/preview resize ---------- */

const SPLIT_KEY = "markread.editor-split";
const SPLIT_DEFAULT = 50;
const SPLIT_MIN = 20;
const SPLIT_MAX = 80;

function applySplitRatio(ratio: number, persist = true): void {
  const clamped = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, Math.round(ratio * 10) / 10));
  document.documentElement.style.setProperty("--split-editor", `${clamped}%`);
  if (persist) localStorage.setItem(SPLIT_KEY, String(clamped));
}

function currentSplitRatio(): number {
  const raw = parseInt(
    document.documentElement.style.getPropertyValue("--split-editor"),
    10,
  );
  return Number.isFinite(raw) ? raw : SPLIT_DEFAULT;
}

function setupEditorSplitResize(): void {
  const raw = Number(localStorage.getItem(SPLIT_KEY));
  applySplitRatio(Number.isFinite(raw) ? raw : SPLIT_DEFAULT, false);

  attachDragResize(splitResizer, {
    onMove: (ev) => {
      const rect = editorSplit.getBoundingClientRect();
      if (rect.width <= 0) return;
      applySplitRatio(((ev.clientX - rect.left) / rect.width) * 100, false);
    },
    onEnd: () => {
      localStorage.setItem(SPLIT_KEY, String(currentSplitRatio()));
    },
  });
  splitResizer.addEventListener("dblclick", () => {
    applySplitRatio(SPLIT_DEFAULT);
  });
}

/* ---------- new file ---------- */

function joinPath(dir: string, name: string): string {
  const sep = dir.includes("\\") ? "\\" : "/";
  const trimmed = dir.endsWith("\\") || dir.endsWith("/") ? dir.slice(0, -1) : dir;
  return `${trimmed}${sep}${name}`;
}

/** New file: an in-memory untitled tab the user can type into right away.
 *  Nothing touches the disk until the buffer is saved explicitly (Ctrl+S →
 *  save dialog), so "New file" never opens a dialog first. */
async function createNewFile(): Promise<void> {
  const tab: Tab = {
    id: nextTabId++,
    file: {
      path: "",
      name: t("statusUntitled"),
      dir: workspaceDir ?? currentFile?.dir ?? "",
      content: "",
      size: 0,
    },
    untitled: true,
    dirty: false,
    editing: true,
    buffer: "",
    lastSavedContent: null,
    fileUsesCrlf: false,
    editSeq: 0,
    scroll: null,
    editorScrollTop: 0,
  };
  tabs.push(tab);
  renderTabbar();
  await activateTab(tab.id);
  updateWindowTitle();
}

/* ---------- folder mode (light workspace) ---------- */

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
    // Live listing only for watchable trees; truncated ones (huge) skip the
    // recursive watcher instead of ballooning OS handles.
    if (inTauri && !listing.truncated) {
      void invoke("watch_folder", { dir: listing.dir }).catch(() => {});
    }
    if (inTauri) void invoke("set_last_folder", { path: listing.dir }).catch(() => {});
    updateGroupVisibility();
    if (reveal) revealSidebar();
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

/* ---------- live folder listing ---------- */

const FOLDER_REFRESH_DEBOUNCE = 400;
let folderReloadTimer: ReturnType<typeof setTimeout> | null = null;

function handleFolderChanged(): void {
  if (!workspaceDir) return;
  if (folderReloadTimer) clearTimeout(folderReloadTimer);
  folderReloadTimer = setTimeout(() => void refreshFolderListing(), FOLDER_REFRESH_DEBOUNCE);
}

/** Re-scan the workspace and refresh whatever the sidebar shows, keeping
 *  the active-file highlight. A vanished folder keeps the stale listing;
 *  the next explicit open reports the error. */
async function refreshFolderListing(): Promise<void> {
  if (!workspaceDir) return;
  let listing: FolderListing;
  try {
    listing = await invoke<FolderListing>("list_markdown_files", { dir: workspaceDir });
  } catch {
    return;
  }
  folderListing = listing;
  if (folderSearchInput.value.trim()) runFolderSearch();
  else renderFileList(listing);
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
  await listen<null>("folder-changed", () => handleFolderChanged());

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
        openFind();
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
        updateZoomLabel();
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
    syncThemeSegment();
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
    langSelect.value = event.payload as Lang;
    applyI18n();
    setSaveIndicator("idle"); // transient label would be in the old language
    updateStatus();
    updateWindowTitle();
    updateStatusCursor();
    renderTabbar();
    renderOutline(outlineEl, headings, t("outlineEmpty"), bodyEl);
    backToTop.title = t("backToTop");
    backToTop.setAttribute("aria-label", t("backToTop"));
    sideCollapse.title = t("hideSidebar");
    sideCollapse.setAttribute("aria-label", t("hideSidebar"));
    sideFloatOpen.title = t("showSidebar");
    sideFloatOpen.setAttribute("aria-label", t("showSidebar"));
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
      try {
        await saveReadingPositionNow();
        if (!(await confirmCloseAllTabs())) return;
        isDirty = false;
      } catch {
        // A failed save or dialog must never leave the window uncloseable.
      }
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

/* ---------- keyboard shortcuts (webview) ---------- */

function setupKeyboardShortcuts(): void {
  window.addEventListener("keydown", (ev) => {
    const ctrl = ev.ctrlKey || ev.metaKey;
    if (!ctrl) return;
    if (ev.key === "o" && ev.altKey) {
      ev.preventDefault();
      void openFolderDialog();
    } else if (ev.key === "o") {
      ev.preventDefault();
      void runOpenDialog();
    } else if (ev.key === "n") {
      ev.preventDefault();
      void createNewFile();
    } else if (ev.key === "f") {
      ev.preventDefault();
      openFind();
    } else if (ev.key === "h" && isEditing) {
      ev.preventDefault();
      openFind(true);
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
    } else if (ev.key === "q" && inTauri) {
      // No native menu on Windows/Linux: quit via the close-requested flow
      // (persists the reading position, honors the dirty guard).
      ev.preventDefault();
      void getCurrentWindow().close().catch(() => {});
    } else if (ev.key === "w" && inTauri && activeTabId !== null) {
      ev.preventDefault();
      void closeTab(activeTabId);
    } else if (ev.key === "Tab" && inTauri) {
      ev.preventDefault();
      cycleTab(ev.shiftKey ? -1 : 1);
    } else if (ev.key === "PageDown" && inTauri) {
      ev.preventDefault();
      cycleTab(1);
    } else if (ev.key === "PageUp" && inTauri) {
      ev.preventDefault();
      cycleTab(-1);
    } else if (ev.key === "O" && ev.shiftKey) {
      ev.preventDefault();
      toggleSidebar();
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
      updateZoomLabel();
    }
  });
}

/* ---------- boot ---------- */

function updateZoomLabel(): void {
  zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
}

async function boot(): Promise<void> {
  initTheme();
  applySidebarPreference();
  updateZoomLabel();

  let language = detectLanguage();
  let lastFolder: string | null = null;
  let checkUpdatesOnStartup = false;
  let sessionTabs: string[] = [];
  let sessionActive = 0;
  if (inTauri) {
    try {
      const settings = await invoke<{
        language: string;
        lastFolder: string | null;
        checkUpdatesOnStartup: boolean;
        openTabs?: string[];
        activeTab?: number;
      }>("get_settings");
      if (["en", "pt-BR", "es"].includes(settings.language)) {
        language = settings.language as Lang;
      }
      lastFolder = settings.lastFolder;
      checkUpdatesOnStartup = settings.checkUpdatesOnStartup;
      sessionTabs = settings.openTabs ?? [];
      sessionActive = settings.activeTab ?? 0;
    } catch {
      /* fall back to detected locale */
    }
  }
  setLanguage(language);
  applyI18n();
  langSelect.value = language;
  // macOS menu accelerators use ⌘ — mirror that in the sidebar hints.
  if (isMac) {
    sidebar.querySelectorAll(".side-row kbd").forEach((kbd) => {
      kbd.textContent = kbd.textContent?.replace("Ctrl+", "⌘") ?? kbd.textContent;
    });
  }
  updateStatus();
  updateGroupVisibility();
  await refreshRecents();

  welcomeOpen.addEventListener("click", () => void runOpenDialog());
  welcomeFolder.addEventListener("click", () => void openFolderDialog());
  welcomeNew.addEventListener("click", () => void createNewFile());
  $<HTMLButtonElement>("#act-new-file").addEventListener("click", () => void createNewFile());
  $<HTMLButtonElement>("#act-open").addEventListener("click", () => void runOpenDialog());
  $<HTMLButtonElement>("#act-open-folder").addEventListener("click", () => void openFolderDialog());
  $<HTMLButtonElement>("#act-find").addEventListener("click", () => openFind());
  $<HTMLButtonElement>("#act-edit").addEventListener("click", () => {
    if (isEditing) exitEditMode();
    else enterEditMode();
  });
  $<HTMLButtonElement>("#act-save").addEventListener("click", () => void saveFile());
  $<HTMLButtonElement>("#act-print").addEventListener("click", () => printDocument());
  sideCollapse.addEventListener("click", () => toggleSidebar());
  sideFloatOpen.addEventListener("click", () => toggleSidebar());
  const syncSidebarButtonTitles = () => {
    sideCollapse.title = t("hideSidebar");
    sideCollapse.setAttribute("aria-label", t("hideSidebar"));
    sideFloatOpen.title = t("showSidebar");
    sideFloatOpen.setAttribute("aria-label", t("showSidebar"));
  };
  syncSidebarButtonTitles();
  setupSidebarResize();
  setupEditorSplitResize();
  $<HTMLButtonElement>("#zoom-in-btn").addEventListener("click", () => changeZoom(0.1));
  $<HTMLButtonElement>("#zoom-out-btn").addEventListener("click", () => changeZoom(-0.1));
  $<HTMLButtonElement>("#zoom-reset-btn").addEventListener("click", () => {
    zoom = 1;
    void applyZoom();
    updateZoomLabel();
  });

  themeSegment.querySelectorAll<HTMLButtonElement>("button[data-theme-pref]").forEach((btn) => {
    btn.addEventListener("click", () => {
      setThemePreference(btn.dataset.themePref as ThemePreference);
      syncThemeSegment();
    });
  });
  syncThemeSegment();
  langSelect.addEventListener("change", () => {
    const lang = langSelect.value as Lang;
    if (inTauri) {
      void invoke("set_language", { language: lang }).catch(() => {});
    } else {
      setLanguage(lang);
      applyI18n();
      updateStatus();
      renderOutline(outlineEl, headings, t("outlineEmpty"), bodyEl);
    }
  });

  // Collapsible groups: clicking a header toggles its body.
  sidebar.addEventListener("click", (ev) => {
    const header = (ev.target as HTMLElement).closest<HTMLButtonElement>(".group-header");
    if (!header) return;
    const group = header.parentElement;
    if (!group) return;
    group.classList.toggle("collapsed");
    header.setAttribute("aria-expanded", group.classList.contains("collapsed") ? "false" : "true");
  });

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
  // Task checkboxes toggle their marker in the source file (reading mode).
  bodyEl.addEventListener("change", (ev) => {
    const input = ev.target as HTMLInputElement;
    if (input.type !== "checkbox" || input.disabled) return;
    const index = Number(input.dataset.taskIndex);
    if (Number.isInteger(index)) void toggleTaskInDocument(index);
  });
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

  // Findbar buttons had no handlers before — navigation used to work only
  // through Enter/Shift+Enter. They follow the active search controller.
  $<HTMLButtonElement>("#find-prev").addEventListener("click", () =>
    (isEditing ? editorSearch : search).step(-1),
  );
  $<HTMLButtonElement>("#find-next").addEventListener("click", () =>
    (isEditing ? editorSearch : search).step(1),
  );
  $<HTMLButtonElement>("#find-close").addEventListener("click", () => {
    editorSearch.close();
    search.close();
  });

  editorEl.addEventListener("input", () => {
    markDirty();
    schedulePreviewUpdate();
    updateStatusCursor();
    if (editorSearch.isOpen()) {
      if (editorFindTimer) clearTimeout(editorFindTimer);
      editorFindTimer = window.setTimeout(() => editorSearch.refresh(), 150);
    }
  });
  editorEl.addEventListener("paste", (ev) => {
    const files = Array.from(ev.clipboardData?.files ?? []).filter((f) =>
      f.type.startsWith("image/"),
    );
    if (files.length === 0) return; // regular text paste keeps default behavior
    ev.preventDefault();
    void pasteImages(files);
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
    } else if (
      ev.key === "Enter" &&
      !ev.isComposing &&
      !ev.shiftKey &&
      !ev.ctrlKey &&
      !ev.metaKey &&
      !ev.altKey &&
      continueListOnEnter()
    ) {
      ev.preventDefault();
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

  // Windows/Linux have no native menu anymore — the webview owns the
  // shortcuts. macOS keeps its native menu (which consumes the equivalents),
  // so registering here too would double-fire.
  if (!inTauri || !isMac) setupKeyboardShortcuts();

  try {
    await setupListeners();
  } catch (err) {
    console.error("listener setup failed", err);
  }
  await applyZoom();

  if (inTauri) {
    if (lastFolder) await openFolder(lastFolder, { quiet: true });
    await restoreSession(sessionTabs, sessionActive);
    try {
      const pending = await invoke<string | null>("take_pending_file");
      if (pending) await openPath(pending);
    } catch (err) {
      console.error(err);
    }
    if (checkUpdatesOnStartup) void runUpdateCheck(false);
  }
}

void boot();
