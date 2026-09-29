/**
 * Where a ```` ```join ```` fence is drawn right now, for whoever fills it.
 *
 * The editor draws the fence as an empty box (`JoinWidget`) and lists it here;
 * the homepage (`HomeShell`) watches this list and portals its own join card
 * into the first box. Keeping the card out of the editor keeps the editor free
 * of the homepage's sign-in state, and a surface nobody fills — the console,
 * where an owner is writing the page — shows the box's own label instead.
 *
 * Plain DOM and listeners, no React, because this file is also compiled into
 * the phone's editor bundle.
 */

/** One drawn fence: the box to fill, and the label to hide while it is filled. */
export interface JoinSlot {
  readonly box: HTMLElement;
  readonly label: HTMLElement;
}

let slots: readonly JoinSlot[] = [];
const listeners = new Set<() => void>();

function changed() {
  for (const listener of listeners) listener();
}

export function addJoinSlot(slot: JoinSlot): void {
  slots = [...slots, slot];
  changed();
}

export function removeJoinSlot(box: HTMLElement): void {
  const next = slots.filter((slot) => slot.box !== box);
  if (next.length === slots.length) return;
  slots = next;
  changed();
}

/** The first drawn fence, or `null` when the open note has none. */
export function currentJoinSlot(): JoinSlot | null {
  return slots[0] ?? null;
}

export function subscribeJoinSlots(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
