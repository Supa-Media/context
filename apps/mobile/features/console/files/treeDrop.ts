/**
 * Where a folder dragged in the sidebar tree lands: above a row, below it, or
 * into it, and what that does.
 *
 * Folders have had an order of their own since 2026-10-18 (`nodes.order`,
 * `functions/folderOrder.ts`; `docs/decisions/app-and-console/folder-jobs.md`),
 * so a drop *between* two rows now means something, and the tree draws a line
 * there instead of only washing the folder a drop goes into. Three outcomes:
 *
 *  - **between two siblings**: a reorder of that level, sent whole to
 *    `folderOrder.set`, the way Move up and Move down already do;
 *  - **between rows of another level**: a move into that level, then the
 *    same order with the folder at the place it was dropped;
 *  - **onto the middle of a folder**: into it, the nest that was always there
 *    and still goes through `dnd.ts`'s `canDrop`.
 *
 * Pure, like `dnd.ts` beside it, so the rules are tested without a renderer
 * (`__tests__/treeDrop.test.ts`). The server checks everything again: a
 * built-in folder moved into another level outside a keyed workspace is
 * refused there (`assertNotProtectedFolder`), and the refusal reaches the
 * notice line through the move's own path. What is refused here is what the
 * console can already see is wrong.
 */

import { siblingFolders, type JobListings } from "./jobIcons/folderJobs";
import { describeMoveProblem, moveTargetFor, parentPath } from "./paths";
import { namesIn } from "./tree";
import type { FolderListing } from "./types";

export type DropZone = "above" | "below" | "into";

/** The share of a row's height, from each edge, that drops beside it rather than into it. */
export const DROP_EDGE = 0.25;

/**
 * Which zone of a row the pointer is in, from how far down the row it is
 * (`0` the top edge, `1` the bottom).
 *
 * `orderable` is whether the drag can be put in order at all: exactly one
 * folder. Notes and several rows at once only ever drop into a folder, as
 * before. Below an **open** folder is where its first child is drawn, so the
 * bottom edge there nests rather than drawing a line that would sit between
 * the folder and its own contents.
 */
export function dropZoneAt(
  fraction: number | undefined,
  row: { kind: string; expanded: boolean },
  orderable: boolean,
): DropZone {
  if (!orderable || fraction === undefined || Number.isNaN(fraction)) return "into";
  if (fraction < DROP_EDGE) return "above";
  if (fraction > 1 - DROP_EDGE) return row.kind === "folder" && row.expanded ? "into" : "below";
  return "into";
}

export type TreeDropPlan =
  /** Into the folder: the existing drop, judged by `dnd.ts`'s `canDrop`. */
  | { kind: "nest"; folder: string }
  /** The folders of `parent` in this order, sent to `folderOrder.set`. */
  | { kind: "reorder"; parent: string; folders: string[] }
  /** Move `from` into `parent`, then that level in this order (the moved folder at its new path). */
  | { kind: "place"; from: string; parent: string; folders: string[] }
  | { kind: "refuse"; reason: string }
  /** Dropped where it already is: nothing to do, and nothing to say. */
  | { kind: "none" };

export interface TreeDropInput {
  paths: readonly string[];
  /** The folder row the pointer is over. */
  target: string;
  zone: DropZone;
  listings: JobListings & Readonly<Record<string, FolderListing | undefined>>;
  /** Z to A: the tree draws each level's folders backwards (`orderedEntries`). */
  descending: boolean;
  /** ⌥ held: a copy, which only ever goes into a folder and leaves the original in its place. */
  copying?: boolean;
}

const INSIDE_ITSELF = "A folder cannot be moved inside itself.";

function isFolder(listings: TreeDropInput["listings"], path: string): boolean {
  return listings[parentPath(path)]?.entries.some((entry) => entry.path === path && entry.kind === "folder") ?? false;
}

/** At or below `folder`. */
function within(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}

export function planTreeDrop(input: TreeDropInput): TreeDropPlan {
  const { paths, target, listings } = input;
  const single = paths.length === 1 && isFolder(listings, paths[0]!) ? paths[0]! : null;
  const copying = input.copying === true;
  const zone = single === null || copying ? "into" : input.zone;

  if (zone === "into") {
    if (paths.some((path) => isFolder(listings, path) && within(target, path))) {
      return { kind: "refuse", reason: target === paths[0] && paths.length === 1 ? "That is the folder you are moving." : INSIDE_ITSELF };
    }
    return { kind: "nest", folder: target };
  }

  const from = single!;
  if (from === target) return { kind: "none" };
  if (within(target, from)) return { kind: "refuse", reason: INSIDE_ITSELF };
  const siblings = siblingFolders(listings, target);
  if (siblings === null) return { kind: "none" };
  const parent = parentPath(target);
  const drawn = input.descending ? [...siblings].reverse() : siblings;
  const serverOrder = (order: string[]) => (input.descending ? order.reverse() : order);

  if (parent === parentPath(from)) {
    const without = drawn.filter((path) => path !== from);
    const at = without.indexOf(target) + (zone === "below" ? 1 : 0);
    const next = [...without.slice(0, at), from, ...without.slice(at)];
    if (next.every((path, index) => path === drawn[index])) return { kind: "none" };
    return { kind: "reorder", parent, folders: serverOrder(next) };
  }

  const problem = describeMoveProblem(from, parent, new Set(namesIn(listings, parent)));
  if (problem !== null) return { kind: "refuse", reason: problem };
  const moved = moveTargetFor(from, parent);
  const at = drawn.indexOf(target) + (zone === "below" ? 1 : 0);
  const next = [...drawn.slice(0, at), moved, ...drawn.slice(at)];
  return { kind: "place", from, parent, folders: serverOrder(next) };
}
