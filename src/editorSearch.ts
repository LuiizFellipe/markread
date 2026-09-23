/** Find & replace over the raw editor buffer (edit mode). Shares the
 *  #findbar UI with the rendered-page search in search.ts; main.ts picks
 *  the controller based on the active mode. A textarea cannot carry
 *  highlights, so navigation moves the caret and scrolls it into view
 *  instead of wrapping marks. */

export interface EditorSearchController {
  open(withReplace?: boolean): void;
  close(): void;
  isOpen(): boolean;
  step(delta: number): void;
  /** Recompute matches after the buffer changed underneath (live typing). */
  refresh(): void;
}

export interface EditorSearchDeps {
  editor: HTMLTextAreaElement;
  findbar: HTMLElement;
  findInput: HTMLInputElement;
  countEl: HTMLElement;
  replaceRow: HTMLElement;
  replaceInput: HTMLInputElement;
  replaceOneBtn: HTMLButtonElement;
  replaceAllBtn: HTMLButtonElement;
  /** Guards against the shared findbar being driven in the other mode. */
  isActive: () => boolean;
  /** Buffer edits go through the shared undo-preserving replace path. */
  replaceRange: (start: number, end: number, text: string) => void;
}

export function initEditorSearch(deps: EditorSearchDeps): EditorSearchController {
  const { editor, findbar, findInput, countEl, replaceRow, replaceInput, replaceOneBtn, replaceAllBtn } = deps;
  let matches: Array<[number, number]> = [];
  let current = -1;
  let debounce = 0;
  let openFlag = false;

  /** Case-insensitive, non-overlapping matches — the same semantics as the
   *  rendered-page search, but as buffer offsets. A regex is used instead
   *  of toLowerCase() because regex folding is length-preserving: offsets
   *  found in the haystack always align with the original buffer (full
   *  lowercase mapping can change UTF-16 lengths, e.g. U+0130). */
  function computeMatches(): Array<[number, number]> {
    const query = findInput.value;
    if (!query) return [];
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(escaped, "gi");
    const value = editor.value;
    const result: Array<[number, number]> = [];
    for (let m = re.exec(value); m !== null; m = re.exec(value)) {
      result.push([m.index, m.index + m[0].length]);
    }
    return result;
  }

  function updateCount(): void {
    if (matches.length === 0) {
      countEl.textContent = findInput.value ? "0" : "";
    } else {
      countEl.textContent = `${current + 1}/${matches.length}`;
    }
  }

  /** Center the match's line vertically; the caret auto-scroll on selection
   *  only hugs the edge, which loses context. */
  function reveal([start, end]: [number, number]): void {
    editor.focus();
    const line = editor.value.slice(0, start).split("\n").length - 1;
    const style = getComputedStyle(editor);
    const lineHeight = parseFloat(style.lineHeight) || 22;
    const paddingTop = parseFloat(style.paddingTop) || 0;
    editor.scrollTop = Math.max(
      0,
      paddingTop + line * lineHeight - editor.clientHeight / 2,
    );
    editor.setSelectionRange(start, end);
  }

  function setCurrent(index: number): void {
    current = index;
    updateCount();
    const match = matches[current];
    if (match) reveal(match);
  }

  function step(delta: number): void {
    if (matches.length === 0) {
      refresh();
      if (matches.length === 0) return;
    }
    setCurrent((current + delta + matches.length) % matches.length);
  }

  function refresh(): void {
    matches = computeMatches();
    if (current >= matches.length) current = matches.length - 1;
    updateCount();
  }

  function open(withReplace = false): void {
    openFlag = true;
    findbar.hidden = false;
    replaceRow.hidden = !withReplace;
    findInput.focus();
    findInput.select();
    matches = computeMatches();
    // Point the counter at the nearest match from the caret without jumping.
    if (matches.length > 0) {
      const caret = editor.selectionStart;
      const at = matches.findIndex(([start]) => start >= caret);
      current = at === -1 ? matches.length - 1 : at;
    } else {
      current = -1;
    }
    updateCount();
  }

  function close(): void {
    openFlag = false;
    findbar.hidden = true;
    replaceRow.hidden = true;
    countEl.textContent = "";
    matches = [];
    current = -1;
  }

  function isOpen(): boolean {
    return openFlag;
  }

  /** Replace the current match and move to the next one. A match that no
   *  longer lines up with the buffer (typing while the bar is open) is
   *  recomputed instead of blindly cutting offsets. */
  function replaceOne(): void {
    if (matches.length === 0) return;
    if (current < 0 || current >= matches.length) {
      step(1);
      return;
    }
    const [start, end] = matches[current];
    if (editor.value.slice(start, end).toLowerCase() !== findInput.value.toLowerCase()) {
      refresh();
      if (current >= 0 && matches[current]) reveal(matches[current]);
      return;
    }
    const replacement = replaceInput.value;
    const after = end + (replacement.length - (end - start));
    deps.replaceRange(start, end, replacement);
    matches = computeMatches();
    current = matches.findIndex(([s]) => s >= after);
    if (current === -1) current = matches.length > 0 ? 0 : -1;
    updateCount();
    if (matches[current]) reveal(matches[current]);
  }

  /** One undo step for the whole document: the rebuilt text goes through
   *  the same replace path as single edits. */
  function replaceAll(): void {
    matches = computeMatches();
    if (matches.length === 0) {
      updateCount();
      return;
    }
    const value = editor.value;
    const replacement = replaceInput.value;
    let out = "";
    let cursor = 0;
    for (const [start, end] of matches) {
      out += value.slice(cursor, start) + replacement;
      cursor = end;
    }
    out += value.slice(cursor);
    deps.replaceRange(0, value.length, out);
    matches = computeMatches();
    current = matches.length > 0 ? 0 : -1;
    updateCount();
  }

  findInput.addEventListener("input", () => {
    if (!deps.isActive()) return;
    window.clearTimeout(debounce);
    debounce = window.setTimeout(refresh, 150);
  });
  findInput.addEventListener("keydown", (ev) => {
    if (!deps.isActive()) return;
    if (ev.key === "Enter") {
      ev.preventDefault();
      step(ev.shiftKey ? -1 : 1);
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      close();
    }
  });
  replaceInput.addEventListener("keydown", (ev) => {
    if (!deps.isActive()) return;
    if (ev.key === "Enter") {
      ev.preventDefault();
      replaceOne();
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      close();
    }
  });
  replaceOneBtn.addEventListener("click", replaceOne);
  replaceAllBtn.addEventListener("click", replaceAll);

  return { open, close, isOpen, step, refresh };
}
