/** Scroll-restore helpers: capture where the reader is and put them back
 *  after the document is re-rendered (position resume, auto-reload). */

export interface ScrollSnapshot {
  top: number;
  height: number;
  /** Heading at or above the top of the viewport, so restores survive
   *  edits that change the content height. */
  anchorId: string | null;
  /** Pixels scrolled into the anchor heading. */
  anchorOffset: number;
}

export function emptySnapshot(): ScrollSnapshot {
  return { top: 0, height: 0, anchorId: null, anchorOffset: 0 };
}

/** Headings must be in document order (they come from collectHeadings). */
export function captureScroll(
  scrollPane: HTMLElement,
  headingIds: string[],
): ScrollSnapshot {
  const top = scrollPane.scrollTop;
  const height = scrollPane.scrollHeight;
  let anchorId: string | null = null;
  let anchorOffset = 0;
  for (const id of headingIds) {
    const el = document.getElementById(id);
    if (el && el.offsetTop <= top) {
      anchorId = id;
      anchorOffset = top - el.offsetTop;
    }
  }
  return { top, height, anchorId, anchorOffset };
}

/** Restore by anchor when possible, then by exact pixels (same height),
 *  then proportionally. */
export function restoreScroll(
  scrollPane: HTMLElement,
  snapshot: ScrollSnapshot,
): void {
  const max = Math.max(0, scrollPane.scrollHeight - scrollPane.clientHeight);
  let target: number;
  const anchor = snapshot.anchorId
    ? document.getElementById(snapshot.anchorId)
    : null;
  if (anchor) {
    target = anchor.offsetTop + snapshot.anchorOffset;
  } else if (scrollPane.scrollHeight === snapshot.height) {
    target = snapshot.top;
  } else if (snapshot.height > 0) {
    target = (snapshot.top / snapshot.height) * scrollPane.scrollHeight;
  } else {
    target = 0;
  }
  scrollPane.scrollTop = Math.min(max, Math.max(0, target));
}
