/**
 * Several steps picked on the canvas at once (Dev, 2026-11-27, "Make component": pick steps and wrap them into a new
 * component, as Figma's Create component does; artboard /lab-new-component-artboards, frames 01 and 05).
 *
 *   - Shift-click or ⌘/Ctrl-click a step adds it to the picks or takes it out; a plain click still picks one.
 *   - Shift-drag on empty canvas draws a box; every step it touches is added. A plain drag still pans.
 *   - Esc clears; Delete removes every one picked; dragging one picked moves them all; each is one undo.
 *
 * One pick is the canvas's ordinary selection (`lab.sel`); two or more are `lab.picks`, with `lab.sel` null so the step
 * panel closes (it edits one thing). Only where steps can be picked: the whole graph or a page, or an open group, never
 * a step's own view or the test chat's line.
 */
import { groupsOf } from "../data/graph";
import { isGroupFocus } from "./groups";
import { emit, G, lab } from "./state";

/** The ids picked now: the several, or the one selected step, or none. */
export function picked(): string[] {
  if (lab.picks.length >= 2) return [...lab.picks];
  return lab.sel?.t === "node" && !isLine(lab.sel.id) ? [lab.sel.id] : [];
}

const isLine = (id: string) => id === "lineIn" || id === "lineOut";

/** Can several steps be picked here? Not in a step's own view, and not on anything but the canvas. */
export function canPickSeveral(): boolean {
  if (lab.view !== "canvas") return false;
  return !lab.cfocus || isGroupFocus(G(), lab.cfocus, groupsOf(G()));
}

/** Set the picks: none, one (the ordinary selection, which opens the step panel) or several (the panel closes). */
export function setPicks(ids: string[]) {
  const list = [...new Set(ids.filter((id) => !isLine(id)))];
  lab.makeOpen = false;
  if (list.length >= 2) {
    lab.picks = list;
    lab.sel = null;
  } else {
    lab.picks = [];
    lab.sel = list.length ? { t: "node", id: list[0] } : null;
    if (list.length) lab.pin = true;
  }
  lab.addCtxOpen = false;
  emit();
}

/** Shift or ⌘/Ctrl click: the step joins the picks, or leaves them. */
export function togglePick(id: string) {
  const now = picked();
  setPicks(now.includes(id) ? now.filter((x) => x !== id) : [...now, id]);
}

/** Shift drag: the steps the box touched join the picks. */
export function addPicks(ids: string[]) {
  setPicks([...picked(), ...ids]);
}

/** Esc, ✕ or a click on empty canvas: nothing picked. */
export function clearPicks() {
  lab.picks = [];
  lab.makeOpen = false;
  lab.sel = null;
  emit();
}

/** A thing on the canvas: its id and the rectangle it covers. */
export type Rect = { id: string; x: number; y: number; w: number; h: number };

/** The things a selection box touches (any overlap counts, as in Figma), in the order given. */
export function inBox(items: Rect[], box: { x0: number; y0: number; x1: number; y1: number }): string[] {
  const x0 = Math.min(box.x0, box.x1),
    x1 = Math.max(box.x0, box.x1),
    y0 = Math.min(box.y0, box.y1),
    y1 = Math.max(box.y0, box.y1);
  return items.filter((r) => r.x < x1 && r.x + r.w > x0 && r.y < y1 && r.y + r.h > y0).map((r) => r.id);
}
