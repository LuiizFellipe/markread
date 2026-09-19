/** Scroll-restore helpers: capture where the reader is and put them back
 *  after the document is re-rendered (position resume, auto-reload).
 *  Heading lookups are scoped to the article container so a raw-HTML
 *  markdown heading with id="sidebar" etc. cannot hijack the restore. */

export interface ScrollSnapshot {
  top: number;
  height: number;
  /** Heading at or above the top of the viewport, so restores survive
   *  edits that change the content height. */
  anchorId: string | null;
  /** Pixels scrolled into the anchor heading. */
  anchorOffset: number;
}

/** Headings must be in document order (they come from collectHeadings). */
export function captureScroll(
  scrollPane: HTMLElement,
  root: HTMLElement,
  headingIds: string[],
): ScrollSnapshot {
  const top = scrollPane.scrollTop;
  const height = scrollPane.scrollHeight;
  let anchorId: string | null = null;
  let anchorOffset = 0;
  for (const id of headingIds) {
    const el = headingById(root, id);
    if (el && el.offsetTop <= top) {
      anchorId = id;
      anchorOffset = top - el.offsetTop;
    }
  }
  return { top, height, anchorId, anchorOffset };
}

/** Restore by anchor when possible, then by exact pixels (same height),
 *  else by the scrollable-range fraction. */
export function restoreScroll(
  scrollPane: HTMLElement,
  root: HTMLElement,
  snapshot: ScrollSnapshot,
): void {
  const max = Math.max(0, scrollPane.scrollHeight - scrollPane.clientHeight);
  let target: number;
  const anchor = snapshot.anchorId ? headingById(root, snapshot.anchorId) : null;
  if (anchor) {
    target = anchor.offsetTop + snapshot.anchorOffset;
  } else if (scrollPane.scrollHeight === snapshot.height) {
    target = snapshot.top;
  } else {
    const oldMax = Math.max(1, snapshot.height - scrollPane.clientHeight);
    target = (snapshot.top / oldMax) * max;
  }
  scrollPane.scrollTop = Math.min(max, Math.max(0, target));
}

function headingById(root: HTMLElement, id: string): HTMLElement | null {
  return root.querySelector(`#${CSS.escape(id)}`);
}
