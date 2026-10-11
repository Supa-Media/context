import type { Layout, NotePlace } from "./layout";

/**
 * Which notes are near a rectangle of the world, without looking at all of
 * them.
 *
 * The map draws every note a workspace has, which can be tens of thousands.
 * Zoomed in, a frame shows a few hundred of them, and a frame that still
 * walked the rest to find that out would cost as much as drawing everything.
 * So notes are bucketed once per layout into square cells, and a frame reads
 * only the cells its view touches.
 */

/** World units per cell: a few dozen notes at `SPACING`. */
const CELL = 80;

type Grid = Map<number, NotePlace[]>;

const grids = new WeakMap<Layout, Grid>();

const cellOf = (v: number) => Math.floor(v / CELL);
// Distinct for any cell index a layout reaches (well inside ±2^20).
const keyOf = (cx: number, cy: number) => cx * 2_097_152 + cy;

function gridOf(layout: Layout): Grid {
  const found = grids.get(layout);
  if (found) return found;
  const grid: Grid = new Map();
  for (const n of layout.notes.values()) {
    const key = keyOf(cellOf(n.x), cellOf(n.y));
    const list = grid.get(key);
    if (list) list.push(n);
    else grid.set(key, [n]);
  }
  grids.set(layout, grid);
  return grid;
}

/**
 * Every note placed inside `[x0, x1] × [y0, y1]` (world units), plus some
 * just outside it: callers still test what they draw against the screen.
 * When the rectangle covers more cells than there are notes, every note.
 */
export function notesNear(layout: Layout, x0: number, y0: number, x1: number, y1: number): Iterable<NotePlace> {
  const grid = gridOf(layout);
  const cx0 = cellOf(x0);
  const cx1 = cellOf(x1);
  const cy0 = cellOf(y0);
  const cy1 = cellOf(y1);
  if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) >= grid.size) return layout.notes.values();
  const out: NotePlace[] = [];
  for (let cx = cx0; cx <= cx1; cx += 1) {
    for (let cy = cy0; cy <= cy1; cy += 1) {
      const list = grid.get(keyOf(cx, cy));
      if (list) for (const n of list) out.push(n);
    }
  }
  return out;
}
