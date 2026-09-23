/** Multi-document tabs: the Tab state shape and the tab strip UI. Document
 *  lifecycle (open/activate/close guards, session persistence) lives in
 *  main.ts — this module only owns the type and the DOM strip. */

import { t } from "./i18n";
import type { ScrollSnapshot } from "./scroll";

export interface FileInfo {
  path: string;
  name: string;
  dir: string;
  content: string;
  size: number;
}

/** Per-document state that must survive switching tabs. `file` carries the
 *  document content when the tab is in reading mode; while editing, the
 *  authoritative text is `buffer` (the shared textarea's stash). */
export interface Tab {
  id: number;
  file: FileInfo;
  untitled: boolean;
  dirty: boolean;
  editing: boolean;
  buffer: string | null;
  lastSavedContent: string | null;
  fileUsesCrlf: boolean;
  editSeq: number;
  /** Reading scroll position captured when the tab was switched away;
   *  null means "fall back to the persisted reading position". */
  scroll: ScrollSnapshot | null;
  editorScrollTop: number;
}

export interface TabView {
  id: number;
  name: string;
  path: string;
  dirty: boolean;
}

export interface TabViewCallbacks {
  onActivate: (id: number) => void;
  onClose: (id: number) => void;
  onNew: () => void;
}

export function initTabbar(
  bar: HTMLElement,
  newBtn: HTMLButtonElement,
  callbacks: TabViewCallbacks,
): { render(tabs: TabView[], activeId: number | null): void } {
  newBtn.title = t("actNewFile");
  newBtn.setAttribute("aria-label", t("actNewFile"));
  newBtn.addEventListener("click", () => callbacks.onNew());

  function render(tabs: TabView[], activeId: number | null): void {
    bar.replaceChildren();
    for (const tab of tabs) {
      const el = document.createElement("div");
      el.className = tab.id === activeId ? "tab active" : "tab";
      el.setAttribute("role", "tab");
      el.setAttribute("aria-selected", tab.id === activeId ? "true" : "false");
      el.title = tab.path || tab.name;

      const name = document.createElement("span");
      name.className = "tab-name";
      name.textContent = tab.name;

      const dirty = document.createElement("span");
      dirty.className = "tab-dirty";
      dirty.hidden = !tab.dirty;

      const close = document.createElement("button");
      close.type = "button";
      close.className = "tab-close";
      close.textContent = "×";
      close.title = t("closeTab");
      close.setAttribute("aria-label", `${t("closeTab")}: ${tab.name}`);

      el.append(name, dirty, close);
      el.addEventListener("click", (ev) => {
        if ((ev.target as HTMLElement).closest(".tab-close")) return;
        callbacks.onActivate(tab.id);
      });
      el.addEventListener("auxclick", (ev) => {
        if (ev.button === 1) callbacks.onClose(tab.id);
      });
      close.addEventListener("click", (ev) => {
        ev.stopPropagation();
        callbacks.onClose(tab.id);
      });
      bar.appendChild(el);
    }
  }

  return { render };
}
