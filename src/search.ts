/** Find-in-page over the rendered markdown. Wraps matches in <mark data-search>
 *  so styling and navigation stay trivial; matches within a single text node
 *  (the overwhelmingly common case) are supported. */

export interface SearchController {
  open(): void;
  close(): void;
  isOpen(): boolean;
  /** Move to the next (1) or previous (-1) match. */
  step(delta: number): void;
}

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "MARK", "TEXTAREA", "INPUT"]);

export function initSearch(
  container: HTMLElement,
  findbar: HTMLElement,
  input: HTMLInputElement,
  countEl: HTMLElement,
  /** Guards against the shared findbar being driven in the other mode
   *  (the editor search owns it while editing). */
  isActive: () => boolean = () => true,
): SearchController {
  let matches: HTMLElement[] = [];
  let current = -1;
  let debounce = 0;

  function isOpen(): boolean {
    return !findbar.hidden;
  }

  function clearMarks(): void {
    matches = [];
    current = -1;
    container.querySelectorAll("mark[data-search]").forEach((mark) => {
      const parent = mark.parentNode;
      if (!parent) return;
      parent.replaceChild(document.createTextNode(mark.textContent ?? ""), mark);
      parent.normalize();
    });
  }

  function findMatches(query: string): void {
    clearMarks();
    if (!query) {
      countEl.textContent = "";
      return;
    }
    const needle = query.toLowerCase();
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = (node as Text).parentElement;
        if (!parent || SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
        if (!(node as Text).textContent) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const nodes: Text[] = [];
    let node = walker.nextNode();
    while (node) {
      nodes.push(node as Text);
      node = walker.nextNode();
    }

    for (const textNode of nodes) {
      const text = textNode.textContent ?? "";
      const lower = text.toLowerCase();
      if (!lower.includes(needle)) continue;

      const fragment = document.createDocumentFragment();
      let cursor = 0;
      let at = lower.indexOf(needle, cursor);
      while (at !== -1) {
        if (at > cursor) fragment.appendChild(document.createTextNode(text.slice(cursor, at)));
        const mark = document.createElement("mark");
        mark.dataset.search = "";
        mark.textContent = text.slice(at, at + needle.length);
        fragment.appendChild(mark);
        matches.push(mark);
        cursor = at + needle.length;
        at = lower.indexOf(needle, cursor);
      }
      if (cursor < text.length) fragment.appendChild(document.createTextNode(text.slice(cursor)));
      textNode.parentNode?.replaceChild(fragment, textNode);
    }

    if (matches.length > 0) setCurrent(0);
    else countEl.textContent = "0";
  }

  function setCurrent(index: number): void {
    matches[current]?.classList.remove("current");
    current = index;
    const el = matches[current];
    if (!el) return;
    el.classList.add("current");
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    countEl.textContent = `${current + 1}/${matches.length}`;
  }

  function step(delta: number): void {
    if (matches.length === 0) return;
    setCurrent((current + delta + matches.length) % matches.length);
  }

  function open(): void {
    findbar.hidden = false;
    input.focus();
    input.select();
    if (input.value) findMatches(input.value);
  }

  function close(): void {
    findbar.hidden = true;
    clearMarks();
    countEl.textContent = "";
  }

  input.addEventListener("input", () => {
    if (!isActive()) return;
    window.clearTimeout(debounce);
    debounce = window.setTimeout(() => findMatches(input.value.trim()), 150);
  });
  input.addEventListener("keydown", (ev) => {
    if (!isActive()) return;
    if (ev.key === "Enter") {
      ev.preventDefault();
      step(ev.shiftKey ? -1 : 1);
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      close();
    }
  });

  return { open, close, isOpen, step };
}

/** Search summary for a document — used to clear state when switching files. */
export function resetSearch(controller: SearchController): void {
  if (controller.isOpen()) controller.close();
}
