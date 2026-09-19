/** Lazy Mermaid support: the heavy library is only imported when the
 *  rendered document actually contains ```mermaid blocks. */

let mermaidModule: Promise<typeof import("mermaid")> | null = null;
let initializedTheme: string | null = null;

function currentTheme(): "dark" | "default" {
  return document.documentElement.getAttribute("data-theme") === "dark"
    ? "dark"
    : "default";
}

async function ensureMermaid() {
  mermaidModule ??= import("mermaid");
  const mermaid = (await mermaidModule).default;
  const theme = currentTheme();
  if (theme !== initializedTheme) {
    // securityLevel "strict" is deliberate: diagrams come from arbitrary
    // markdown files and must not run HTML/JS labels.
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme });
    initializedTheme = theme;
  }
  return mermaid;
}

/** Replace ```mermaid code blocks with rendered diagrams.
 *  Returns whether any diagram was found (so callers can re-render on
 *  theme changes). */
export async function renderMermaidBlocks(
  container: HTMLElement,
): Promise<boolean> {
  const blocks = Array.from(
    container.querySelectorAll<HTMLElement>("code.language-mermaid"),
  );
  if (blocks.length === 0) return false;

  const mermaid = await ensureMermaid();
  for (const code of blocks) {
    const pre = code.parentElement;
    if (!pre || pre.tagName !== "PRE") continue;
    const holder = document.createElement("div");
    holder.className = "mermaid";
    holder.textContent = code.textContent ?? "";
    pre.replaceWith(holder);
    try {
      await mermaid.run({ nodes: [holder] });
    } catch {
      /* mermaid renders its own error message into the node */
    }
  }
  return true;
}
