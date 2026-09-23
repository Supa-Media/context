/**
 * Picking several rows in the file tree: ⌘/ctrl-click and shift-click.
 *
 * A pure module, like every rule in this folder (see `jest.config.js`): what a
 * modified click does to the set is the part worth pinning, and none of it
 * needs a renderer. `rowInteractions.web.ts` turns the click into a gesture,
 * `Explorer` holds the state, and this decides what the state becomes.
 *
 * ## What is selected is what is drawn selected
 *
 * The tree has always drawn one row selected: the open note. A pick is a
 * second, separate answer to "which rows", and the rule that keeps the two
 * from confusing anybody is that exactly one of them is on screen at a time.
 * With nothing picked, the open note is drawn selected and is what a keystroke
 * acts on; with a pick, the picked rows are drawn selected and *they* are. So
 * ⌘-clicking a second row adds it to the one already highlighted — the open
 * note — rather than starting from nothing, which is what Finder and VS Code
 * both do and what the highlight on screen promised.
 *
 * ## Only rows on screen can be picked, and only rows on screen stay picked
 *
 * A range is the rows *between* two others as the tree draws them, so it is
 * computed over the visible order and nothing else. And collapsing a folder
 * drops whatever was picked inside it (`visiblePick`): a bulk "Move 5 items to
 * trash" that took three rows nobody could see is the surprise this feature
 * must not introduce.
 */

import { parentPath } from "./paths";

/** Which modified click it was. */
export type PickGesture =
  /** ⌘-click on a Mac, ctrl-click elsewhere: add or remove one row. */
  | "toggle"
  /** Shift-click: every row between the anchor and this one. */
  | "range";

export interface TreePick {
  /** The picked rows, in no particular order. Empty means "no pick". */
  paths: ReadonlySet<string>;
  /**
   * Where the next shift-click measures from — the row last clicked. `null`
   * falls back to the open note.
   */
  anchor: string | null;
}

export const NO_PICK: TreePick = { paths: new Set(), anchor: null };

/**
 * What a modified click on `path` makes the pick.
 *
 * `order` is the tree's visible rows, top to bottom; `open` is the note the
 * tree draws selected when nothing is picked.
 */
export function pick(
  current: TreePick,
  gesture: PickGesture,
  path: string,
  order: readonly string[],
  open: string | null,
): TreePick {
  const onScreen = open !== null && order.includes(open) ? open : null;

  if (gesture === "toggle") {
    // Start from what is highlighted — see the header.
    const base =
      current.paths.size > 0 ? current.paths : new Set(onScreen === null ? [] : [onScreen]);
    const next = new Set(base);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    return { paths: next, anchor: path };
  }

  const anchor = [current.anchor, onScreen].find(
    (candidate): candidate is string => candidate !== null && order.includes(candidate),
  );
  const to = order.indexOf(path);
  // No anchor on screen, or a row that is not: a shift-click is then a click
  // on one row, which is what it would be in any file manager.
  if (anchor === undefined || to < 0) return { paths: new Set([path]), anchor: path };
  const from = order.indexOf(anchor);
  const [start, end] = from <= to ? [from, to] : [to, from];
  // The anchor stays where it was, so a second shift-click re-measures from
  // the same row rather than from the end of the last range.
  return { paths: new Set(order.slice(start, end + 1)), anchor };
}

/** The pick, less anything that has scrolled out of the tree. */
export function visiblePick(current: TreePick, order: readonly string[]): TreePick {
  if (current.paths.size === 0) return current;
  const visible = new Set(order);
  const kept = [...current.paths].filter((path) => visible.has(path));
  if (kept.length === current.paths.size) return current;
  return { paths: new Set(kept), anchor: current.anchor };
}

/**
 * The picked paths in tree order, with anything inside a picked folder left
 * out.
 *
 * Moving `1-projects` and `1-projects/plan.md` together is one move: the note
 * travels with its folder. Sending both would move the folder and then fail to
 * find the note at the path it no longer has — a bulk operation that reports
 * a failure for something that worked.
 */
export function topmost(paths: Iterable<string>, order: readonly string[]): string[] {
  const all = new Set(paths);
  const within = (path: string) => {
    for (let up = parentPath(path); up !== ""; up = parentPath(up)) {
      if (all.has(up)) return true;
    }
    return false;
  };
  const rank = (path: string) => {
    const at = order.indexOf(path);
    return at < 0 ? Number.MAX_SAFE_INTEGER : at;
  };
  return [...all].filter((path) => !within(path)).sort((a, b) => rank(a) - rank(b));
}
