/** Shared pointer-drag plumbing for layout resizers (sidebar, editor split).
 *  Pointer capture keeps the drag alive when the cursor leaves the handle,
 *  and `body.resizing` gives the whole page the resize cursor while dragging. */

export interface DragResizeCallbacks {
  /** Called on every pointer move while dragging; apply the new size here. */
  onMove: (ev: PointerEvent) => void;
  /** Called once when the drag settles (pointer up or cancel). */
  onEnd: () => void;
}

export function attachDragResize(
  handle: HTMLElement,
  callbacks: DragResizeCallbacks,
): void {
  let dragging = false;
  handle.addEventListener("pointerdown", (ev) => {
    dragging = true;
    handle.classList.add("dragging");
    handle.setPointerCapture(ev.pointerId);
    document.body.classList.add("resizing");
  });
  handle.addEventListener("pointermove", (ev) => {
    if (!dragging) return;
    callbacks.onMove(ev);
  });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove("dragging");
    document.body.classList.remove("resizing");
    callbacks.onEnd();
  };
  handle.addEventListener("pointerup", endDrag);
  handle.addEventListener("pointercancel", endDrag);
}
