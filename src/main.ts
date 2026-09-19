import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, message, open as openFileDialog } from "@tauri-apps/plugin-dialog";
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
const progressEl = $<HTMLElement>("#reading-progress");

const search = initSearch(bodyEl, findbar, findInput, findCount);
const updateScrollSpy = initScrollSpy(scrollPane, outlineEl, () => headings);

let headings: Heading[] = [];
let currentFile: FileInfo | null = null;
let isEditing = false;
let isDirty = false;
let fileUsesCrlf = false;

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

/* ---------- document display ---------- */

function showDocument(): void {
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
  headings = collectHeadings(bodyEl);
  renderOutline(outlineEl, headings, t("outlineEmpty"));
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

function enterEditMode(): void {
  if (!currentFile) return;
  resetSearch(search);
  isEditing = true;
  editorEl.value = currentFile.content;
  welcome.hidden = true;
  bodyEl.hidden = true;
  editorEl.hidden = false;
  editorEl.focus();
  updateStatus();
}

function exitEditMode(): void {
  if (!isEditing || !currentFile) return;
  isEditing = false;
  editorEl.hidden = true;
  currentFile.content = applyFileLineEndings(editorEl.value);
  void renderDocument(currentFile.content, currentFile.dir).then(() => {
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
  await saveReadingPositionNow();
  try {
    const savedPosition: Promise<ReadingPosition | null> = inTauri
      ? invoke<ReadingPosition | null>("get_reading_position", { path }).catch(() => null)
      : Promise.resolve(null);
    const [file, saved] = await Promise.all([
      invoke<FileInfo>("read_markdown_file", { path }),
      savedPosition,
    ]);
    isEditing = false;
    isDirty = false;
    editorEl.hidden = true;
    editorEl.value = "";
    fileUsesCrlf = file.content.includes("\r\n");
    currentFile = file;
    await renderDocument(file.content, file.dir);
    showDocument();
    updateStatus();
    restoreScroll(scrollPane, {
      top: saved?.scrollTop ?? 0,
      height: saved?.scrollHeight ?? 0,
      anchorId: saved?.anchorId ?? null,
      anchorOffset: saved?.anchorOffset ?? 0,
    });
    updateReadingProgress();
    if (inTauri) {
      await getCurrentWindow().setTitle(`${file.name} — MarkRead`);
      await invoke("push_recent_file", { path });
      void refreshRecents();
    }
  } catch (err) {
    await showError(err);
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

function applySidebarPreference(): void {
  sidebar.hidden = localStorage.getItem(OUTLINE_KEY) !== "1";
}

function toggleSidebar(): void {
  sidebar.hidden = !sidebar.hidden;
  localStorage.setItem(OUTLINE_KEY, sidebar.hidden ? "0" : "1");
}

/* ---------- events from the Rust side ---------- */

async function setupListeners(): Promise<void> {
  await listen<string>("open-file", (event) => void openPath(event.payload));

  await listen<string>("menu-action", (event) => {
    switch (event.payload) {
      case "open":
        void runOpenDialog();
        break;
      case "edit":
        if (isEditing) exitEditMode();
        else enterEditMode();
        break;
      case "save":
        void saveFile();
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
    }
  });

  await listen<string>("theme-changed", (event) => {
    setThemePreference(event.payload as ThemePreference);
  });

  await listen<string>("language-changed", (event) => {
    setLanguage(event.payload as Lang);
    applyI18n();
    updateStatus();
    renderOutline(outlineEl, headings, t("outlineEmpty"));
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
    await webview.onDragDropEvent((event) => {
      const type = event.payload.type;
      if (type === "enter" || type === "over") {
        document.body.classList.add("dragging-file");
      } else if (type === "drop") {
        document.body.classList.remove("dragging-file");
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
  if (inTauri) {
    try {
      const settings = await invoke<{ language: string }>("get_settings");
      if (["en", "pt-BR", "es"].includes(settings.language)) {
        language = settings.language as Lang;
      }
    } catch {
      /* fall back to detected locale */
    }
  }
  setLanguage(language);
  applyI18n();
  updateStatus();
  await refreshRecents();

  welcomeOpen.addEventListener("click", () => void runOpenDialog());
  clearRecentBtn.addEventListener("click", () => {
    if (inTauri) void invoke("clear_recent_files").then(() => refreshRecents());
  });

  editorEl.addEventListener("input", markDirty);
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
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      exitEditMode();
    }
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
  }
}

void boot();
