/**
 * Where a ```` ```join ```` fence is drawn right now, for whoever fills it.
 *
 * The editor draws the fence as an empty box (`JoinWidget`) and lists it here;
 * the homepage (`HomeShell`) portals its join card into `host`, one element
 * that lives for the page and is moved into the first box. Keeping the card
 * out of the editor keeps the editor free of the homepage's sign-in state, and
 * a surface nobody fills — the console, where an owner is writing the page —
 * shows the box's own label instead.
 *
 * ## Why one host that moves, and focus put back
 *
 * CodeMirror redraws a block widget when the text around it changes, and the
 * homepage's demo types lines right above this one. A portal into each new box
 * would remount the card and drop the caret out of a half-typed address every
 * time the demo wrote a word (Dev2, 2026-09-29). So the card stays mounted in
 * `host`; a redraw moves `host` into the new box, and when the move took the
 * focus out of the field, the field gets it back with its selection.
 *
 * Plain DOM and listeners, no React, because this file is also compiled into
 * the phone's editor bundle.
 */

/** One drawn fence: its box, and the label shown while nothing fills it. */
export interface JoinBox {
  readonly box: HTMLElement;
  readonly label: HTMLElement;
}

/** What the homepage portals into: the host element, and the first box's label. */
export interface JoinSlot {
  readonly box: HTMLElement;
  readonly label: HTMLElement;
}

let boxes: readonly JoinBox[] = [];
let slot: JoinSlot | null = null;
let host: HTMLElement | null = null;
const listeners = new Set<() => void>();

/** The field that had the focus, kept across a move that detached it. */
let focused: { element: HTMLElement; start: number | null; end: number | null } | null = null;

function remember(element: EventTarget | null) {
  if (!(element instanceof HTMLElement)) return;
  const field = element as HTMLInputElement;
  focused = {
    element,
    start: typeof field.selectionStart === "number" ? field.selectionStart : null,
    end: typeof field.selectionEnd === "number" ? field.selectionEnd : null,
  };
}

function theHost(): HTMLElement {
  if (host !== null) return host;
  const made = document.createElement("div");
  made.className = "cm-lp-join-host";
  made.addEventListener("focusin", (event) => remember(event.target));
  for (const kind of ["input", "keyup", "select", "pointerup"]) {
    made.addEventListener(kind, (event) => {
      if (focused !== null && focused.element === event.target) remember(event.target);
    });
  }
  made.addEventListener("focusout", (event) => {
    // Focus went to something else on purpose: forget it. Focus that went
    // nowhere may be a redraw detaching the field; `place` decides.
    if (event.relatedTarget !== null) focused = null;
    else
      setTimeout(() => {
        if (focused !== null && document.activeElement !== focused.element) focused = null;
      }, 0);
  });
  host = made;
  return made;
}

/** Put the host in the first connected box, and the focus back if a redraw took it. */
function place() {
  const first = boxes.find((entry) => entry.box.isConnected) ?? boxes[0];
  const next = first === undefined ? null : { box: theHost(), label: first.label };
  if (first !== undefined && host !== null && host.parentElement !== first.box) {
    first.box.appendChild(host);
  }
  const lost = document.activeElement;
  if (
    focused !== null &&
    host !== null &&
    host.contains(focused.element) &&
    host.isConnected &&
    (lost === null || lost === document.body)
  ) {
    const { element, start, end } = focused;
    element.focus({ preventScroll: true });
    if (start !== null && end !== null) (element as HTMLInputElement).setSelectionRange?.(start, end);
  }
  if (next?.label !== slot?.label) {
    slot = next;
    for (const listener of listeners) listener();
  }
}

export function addJoinSlot(entry: JoinBox): void {
  boxes = [...boxes, entry];
  place();
  // CodeMirror connects a new box after drawing it; place again once it has.
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(place);
}

export function removeJoinSlot(box: HTMLElement): void {
  const next = boxes.filter((entry) => entry.box !== box);
  if (next.length === boxes.length) return;
  boxes = next;
  place();
}

/** The host and the first box's label, or `null` when the open note has no fence. */
export function currentJoinSlot(): JoinSlot | null {
  return slot;
}

export function subscribeJoinSlots(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
