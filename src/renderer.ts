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
  instance.use(taskLists, { enabled: false, label: true });
  return instance;
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

/** Markdown source → sanitized HTML string. */
export async function renderMarkdown(source: string): Promise<string> {
  const renderer = MATH_HINT.test(source) ? await ensureMathRenderer() : md;
  const raw = renderer.render(source);
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

/** Wrap each code block in a positioned container with a copy button. */
function addCopyButtons(container: HTMLElement): void {
  container.querySelectorAll("pre").forEach((pre) => {
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
 *  external links via the OS browser, .md links navigated in-app. */
export function enhanceRendered(
  container: HTMLElement,
  baseDir: string,
  handlers: LinkHandlers,
): void {
  addCopyButtons(container);

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
