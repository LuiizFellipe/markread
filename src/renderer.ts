import MarkdownIt from "markdown-it";
import anchor from "markdown-it-anchor";
import taskLists from "markdown-it-task-lists";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { convertFileSrc } from "@tauri-apps/api/core";
import { openUrl, openPath } from "@tauri-apps/plugin-opener";
import { t } from "./i18n";
import "./hljs.css";
import "katex/dist/katex.min.css";

const MARKDOWN_EXTENSIONS = [".md", ".markdown", ".mdown", ".mkd"];

/** Cheap gate for lazy-loading the KaTeX chunk: anything that looks like it
 *  might contain math. The plugin's own rules decide what actually renders. */
const MATH_HINT = /\$\$|\$[^\s$](?:[^$\n]*[^\s$])?\$|\\\(|\\\[/;

function createMarkdownIt(): MarkdownIt {
  const instance: MarkdownIt = new MarkdownIt({
    html: true,
    linkify: true,
    typographer: true,
    highlight(code: string, lang: string): string {
      const cls = lang ? ` language-${instance.utils.escapeHtml(lang)}` : "";
      if (lang && hljs.getLanguage(lang)) {
        try {
          return `<pre><code class="hljs${cls}">${
            hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
          }</code></pre>`;
        } catch {
          /* fall through to auto-detection */
        }
      }
      const auto = lang ? "" : hljs.highlightAuto(code).value;
      const value = lang ? instance.utils.escapeHtml(code) : auto;
      return `<pre><code class="hljs${cls}">${value}</code></pre>`;
    },
  });

  instance.use(anchor, {
    slugify: (s: string) =>
      s
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]/gu, "")
        .replace(/\s+/g, "-"),
  });
  // Checkboxes render enabled so reading mode can toggle them in the source
  // file; the live editor preview disables them again via enhanceRendered.
  instance.use(taskLists, { enabled: true, label: true });
  instance.use(wikiLinks);
  return instance;
}

/* ---------- wiki links ([[Page]] / [[Page|Label]]) ---------- */

/** Inline rule turning `[[Target]]` and `[[Target|Label]]` into an anchor
 *  with the target in a data attribute. Resolution to a real file happens
 *  at click time in main.ts, so links survive files moving around. */
function wikiLinks(md: MarkdownIt): void {
  md.inline.ruler.before("link", "wikilink", (state, silent) => {
    const src = state.src;
    const pos = state.pos;
    if (src.charCodeAt(pos) !== 0x5b /* [ */ || src.charCodeAt(pos + 1) !== 0x5b) {
      return false;
    }
    const end = src.indexOf("]]", pos + 2);
    if (end === -1) return false;
    const inner = src.slice(pos + 2, end);
    // Reject anything bracket-ish or spanning lines: `[[a]b]]` is text.
    if (!inner || /[\n[\]]/.test(inner)) return false;
    const pipe = inner.indexOf("|");
    const target = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
    const label = (pipe === -1 ? inner : inner.slice(pipe + 1)).trim() || target;
    if (!target) return false;
    if (!silent) {
      const open = state.push("wikilink_open", "a", 1);
      open.attrSet("class", "wiki-link");
      open.attrSet("data-wiki", target);
      open.attrSet("href", "#");
      const text = state.push("text", "", 0);
      text.content = label;
      state.push("wikilink_close", "a", -1);
    }
    state.pos = end + 2;
    return true;
  });
}

/* ---------- YAML front matter ---------- */

/** Only matches at the very start of the file, where `---` would otherwise
 *  render as a stray thematic break. */
const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

function extractFrontMatter(source: string): { body: string; meta: [string, string][] } {
  const match = FRONT_MATTER_RE.exec(source);
  if (!match) return { body: source, meta: [] };
  const meta: [string, string][] = [];
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key && value) meta.push([key, value]);
  }
  // An empty block is more likely a decorative `---` than metadata; leave
  // the source untouched so it renders as written.
  if (meta.length === 0) return { body: source, meta: [] };
  return { body: source.slice(match[0].length), meta };
}

function frontMatterHtml(meta: [string, string][]): string {
  const rows = meta
    .map(
      ([key, value]) =>
        `<tr><th>${md.utils.escapeHtml(key)}</th><td>${md.utils.escapeHtml(value)}</td></tr>`,
    )
    .join("");
  return (
    `<details class="front-matter"><summary>${t("frontMatterLabel")}</summary>` +
    `<table><tbody>${rows}</tbody></table></details>`
  );
}

const md: MarkdownIt = createMarkdownIt();

// The KaTeX plugin (and its ~1.5 MB of rendered-math machinery) is only
// imported when the document actually looks like it contains math.
let mathRendererPromise: Promise<MarkdownIt> | null = null;

function ensureMathRenderer(): Promise<MarkdownIt> {
  mathRendererPromise ??= import("@mdit/plugin-katex").then(({ katex }) => {
    const mdMath = createMarkdownIt();
    // Default (dollars) delimiters: $inline$ and $$block$$. The \( \) bracket
    // syntax is not supported by plugin-tex 0.24.x (escape rule wins first).
    mdMath.use(katex);
    return mdMath;
  });
  return mathRendererPromise;
}

/** Markdown source → sanitized HTML string. A YAML front matter block is
 *  lifted out and shown as a collapsible properties table on top. */
export async function renderMarkdown(source: string): Promise<string> {
  const renderer = MATH_HINT.test(source) ? await ensureMathRenderer() : md;
  const { body, meta } = extractFrontMatter(source);
  const raw = (meta.length > 0 ? frontMatterHtml(meta) : "") + renderer.render(body);
  return DOMPurify.sanitize(raw, {
    FORBID_TAGS: ["style"],
    ADD_ATTR: ["target", "checked", "disabled", "align"],
  });
}

/** Resolve a possibly-relative URL from a markdown file against its folder. */
function resolveAgainstBase(href: string, baseDir: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#")) return null;
  if (href.startsWith("//")) return null;
  try {
    const baseDirNormalized = baseDir.replaceAll("\\", "/");
    const base =
      "file://" + (baseDirNormalized.endsWith("/") ? baseDirNormalized : baseDirNormalized + "/");
    const url = new URL(encodeURI(href), base);
    return decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
}

export interface LinkHandlers {
  /** Called when the user clicks a link that points at another .md file. */
  onOpenMarkdownFile: (path: string) => void;
  /** Called when the user clicks a `[[wiki link]]`; resolution to a real
   *  path is the caller's job (workspace listing + base directory). */
  onOpenWikiLink: (target: string) => void;
}

export interface EnhanceOptions {
  /** Editor preview only: task checkboxes stay inert while the source
   *  buffer is authoritative. */
  disableTasks?: boolean;
}

/** execCommand fallback for webviews where the async Clipboard API is not
 *  exposed as a secure context. */
function legacyCopy(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

/** Wrap each code block in a positioned container with a copy button.
 *  Mermaid blocks are skipped: they are replaced by diagrams afterwards. */
function addCopyButtons(container: HTMLElement): void {
  container.querySelectorAll("pre").forEach((pre) => {
    if (pre.querySelector("code.language-mermaid")) return;
    if (pre.parentElement?.classList.contains("code-block")) return;
    const wrapper = document.createElement("div");
    wrapper.className = "code-block";
    pre.replaceWith(wrapper);
    wrapper.appendChild(pre);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "code-copy-btn";
    btn.dataset.i18n = "copyCode";
    btn.textContent = t("copyCode");
    btn.addEventListener("click", () => {
      const text = pre.querySelector("code")?.textContent ?? "";
      const done = () => {
        btn.classList.add("done");
        btn.textContent = t("copiedCode");
        setTimeout(() => {
          btn.classList.remove("done");
          btn.textContent = t("copyCode");
        }, 1500);
      };
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(() => {
          if (legacyCopy(text)) done();
        });
      } else if (legacyCopy(text)) {
        done();
      }
    });
    wrapper.appendChild(btn);
  });
}

/** Post-process the rendered DOM: local images via the asset protocol,
 *  external links via the OS browser, .md links navigated in-app, task
 *  checkboxes indexed for source toggling, wiki links wired up. */
export function enhanceRendered(
  container: HTMLElement,
  baseDir: string,
  handlers: LinkHandlers,
  options: EnhanceOptions = {},
): void {
  addCopyButtons(container);

  // Document order == order of task markers in the source, which is what
  // makes the index-based toggle in main.ts map back to the right line.
  // Only plugin-produced checkboxes count — raw <input> HTML in the source
  // must not shift the mapping.
  container
    .querySelectorAll('input[type="checkbox"].task-list-item-checkbox')
    .forEach((checkbox, index) => {
      const input = checkbox as HTMLInputElement;
      input.dataset.taskIndex = String(index);
      if (options.disableTasks) input.disabled = true;
    });

  container.querySelectorAll("img").forEach((img) => {
    const src = img.getAttribute("src") ?? "";
    const local = resolveAgainstBase(src, baseDir);
    if (local) {
      img.src = convertFileSrc(local);
      img.loading = "lazy";
      img.addEventListener("error", () => img.classList.add("broken-image"), {
        once: true,
      });
    }
  });

  container.querySelectorAll("a.wiki-link[data-wiki]").forEach((a) => {
    a.addEventListener("click", (ev) => {
      ev.preventDefault();
      handlers.onOpenWikiLink((a as HTMLElement).dataset.wiki ?? "");
    });
  });

  container.querySelectorAll("a[href]").forEach((a) => {
    const href = a.getAttribute("href") ?? "";
    if (!href || href.startsWith("#")) return;

    if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) {
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer");
      a.addEventListener("click", (ev) => {
        ev.preventDefault();
        void openUrl(href);
      });
      return;
    }

    const local = resolveAgainstBase(href, baseDir);
    if (!local) return;
    const lower = local.toLowerCase();
    if (MARKDOWN_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
      a.addEventListener("click", (ev) => {
        ev.preventDefault();
        handlers.onOpenMarkdownFile(local);
      });
    } else {
      a.addEventListener("click", (ev) => {
        ev.preventDefault();
        void openPath(local);
      });
    }
  });
}
