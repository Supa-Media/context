import type { BulkActions } from "./selectActions";
import type { FileEntry } from "./types";

/**
 * Board 16's four buttons over the rows picked on a phone's folder page.
 *
 * Move and Archive are the tree's own selection items, run through the same
 * dispatcher, so they appear only when `menu.ts` offers them for these rows
 * (an archived row offers Restore instead, under More). Pin puts every
 * picked row on Home, or takes them all off when every one is there already,
 * and says so with an Undo that flips back exactly the rows it changed.
 */
export function bulkActions({
  entries,
  offered,
  run,
  tags,
  setPin,
  isPinned,
  say,
  more,
}: {
  entries: readonly FileEntry[];
  /** The item ids `menu.ts` offers these rows. */
  offered: ReadonlySet<string>;
  run: (id: "moveTo" | "archive") => void;
  /** Open the Tags sheet over them; absent where tags cannot be written. */
  tags?: () => void;
  setPin?: (path: string, kind: "note" | "folder", on: boolean) => void;
  isPinned: (path: string) => boolean;
  say: (message: string, undo?: () => void) => void;
  more: (anchor: { x: number; y: number }) => void;
}): BulkActions {
  const actions: BulkActions = { more };
  if (offered.has("moveTo")) actions.move = () => run("moveTo");
  if (offered.has("archive")) actions.archive = () => run("archive");
  if (tags !== undefined && entries.some((entry) => entry.kind === "folder" || entry.path.endsWith(".md"))) {
    actions.tags = tags;
  }
  if (setPin !== undefined && entries.length > 0) {
    const pinned = entries.every((entry) => isPinned(entry.path));
    actions.pin = {
      pinned,
      run: () => {
        // Unpin all when all are pinned; otherwise pin only the ones that are not yet.
        const changing = entries.filter((entry) => isPinned(entry.path) === pinned);
        const put = (on: boolean) => {
          for (const entry of changing) setPin(entry.path, entry.kind === "folder" ? "folder" : "note", on);
        };
        put(!pinned);
        const count = changing.length === 1 ? "1 item" : `${changing.length} items`;
        say(pinned ? `Unpinned ${count} from Home.` : `Pinned ${count} to Home.`, () => put(pinned));
      },
    };
  }
  return actions;
}
