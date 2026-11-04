/**
 * Where a row dragged in the sidebar tree lands: above a row, below it, or
 * into a folder, and what that does.
 *
 * Folders have had an order of their own since 2026-10-18 (`nodes.order`,
 * `functions/folderOrder.ts`; `docs/decisions/app-and-console/folder-jobs.md`),
 * so a drop *between* two rows now means something, and the tree draws a line
 * there instead of only washing the folder a drop goes into. Three outcomes:
 *
 *  - **between two siblings**: a reorder of that level, sent whole to
 *    `folderOrder.set`, the way Move up and Move down already do. Since
 *    2026-11-04 a note is dragged the same way, and a drop between rows puts
 *    a level that was sorted by name or date in custom order, everything
 *    where it was drawn apart from the row dropped
 *    (`docs/decisions/app-and-console/folder-sort.md`, `levelOrder.ts`);
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

import type { ListingSort } from "@context/shared/src/listingSort.cjs";
import type { JobListings } from "./jobIcons/folderJobs";
import { drawnLevel, droppedLevel } from "./levelOrder";
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
 * row. Several rows at once only ever drop into a folder, as before. Below an
 * **open** folder is where its first child is drawn, so the bottom edge there
 * nests rather than drawing a line that would sit between the folder and its
 * own contents. A note has no inside: its top half drops above it, its bottom
 * half below.
 */
export function dropZoneAt(
  fraction: number | undefined,
  row: { kind: string; expanded: boolean },
  orderable: boolean,
): DropZone {
  if (!orderable || fraction === undefined || Number.isNaN(fraction)) return "into";
  if (row.kind !== "folder") return fraction < 0.5 ? "above" : "below";
  if (fraction < DROP_EDGE) return "above";
  if (fraction > 1 - DROP_EDGE) return row.kind === "folder" && row.expanded ? "into" : "below";
  return "into";
}

export type TreeDropPlan =
  /** Into the folder: the existing drop, judged by `dnd.ts`'s `canDrop`. */
  | { kind: "nest"; folder: string }
  /** Every row of `parent` in this order, sent to `folderOrder.set`. */
  | { kind: "reorder"; parent: string; folders: string[] }
  /** Move `from` into `parent`, then that level in this order (the moved row at its new path). */
  | { kind: "place"; from: string; parent: string; folders: string[] }
  | { kind: "refuse"; reason: string }
  /** Dropped where it already is: nothing to do, and nothing to say. */
  | { kind: "none" };

export interface TreeDropInput {
  paths: readonly string[];
  /** The row the pointer is over: a folder, or a note to drop beside. */
  target: string;
  zone: DropZone;
  listings: JobListings & Readonly<Record<string, FolderListing | undefined>>;
  /** The workspace's own Sort setting, for a level whose listing carries none (`listingOrder.ts`). */
  workspaceSort: ListingSort | null;
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
  const copying = input.copying === true;
  const single = paths.length === 1 && !copying ? paths[0]! : null;
  const onNote = !isFolder(listings, target);
  const zone = single === null ? "into" : input.zone;

  if (zone === "into") {
    // A note has no inside: dropped on one, nothing happens.
    if (onNote) return { kind: "none" };
    if (paths.some((path) => isFolder(listings, path) && within(target, path))) {
      return { kind: "refuse", reason: target === paths[0] && paths.length === 1 ? "That is the folder you are moving." : INSIDE_ITSELF };
    }
    return { kind: "nest", folder: target };
  }

  const from = single!;
  if (from === target) return { kind: "none" };
  if (isFolder(listings, from) && within(target, from)) return { kind: "refuse", reason: INSIDE_ITSELF };
  const parent = parentPath(target);
  const level = drawnLevel(listings, parent, input.workspaceSort);
  if (level === null || !level.paths.includes(target)) return { kind: "none" };
  const side = zone === "below" ? "below" : "above";

  if (parent === parentPath(from)) {
    const next = droppedLevel(level, from, target, side);
    return next === null ? { kind: "none" } : { kind: "reorder", parent, folders: next };
  }

  const problem = describeMoveProblem(from, parent, new Set(namesIn(listings, parent)));
  if (problem !== null) return { kind: "refuse", reason: problem };
  const moved = moveTargetFor(from, parent);
  const at = level.paths.indexOf(target) + (side === "below" ? 1 : 0);
  return { kind: "place", from, parent, folders: [...level.paths.slice(0, at), moved, ...level.paths.slice(at)] };
}
