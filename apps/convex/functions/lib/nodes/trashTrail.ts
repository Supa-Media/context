/**
 * Where a note went when it was moved to the trash, read from the audit trail
 * the console's trash and restore write (`lib/filesFns/entries.ts`): a trash
 * is `file.archive` with `trash: true`, paths `[note or folder, trash key]`;
 * a restore is `file.move` with `restoredFromTrash`, paths
 * `[trash key, where it went back to]`.
 *
 * A note trashed on its own answers its own trash key. A note inside a folder
 * that was trashed answers the key it sits at inside the folder's trash
 * (`<folder's key><the rest of its path>`), which is what Restore of just
 * that note takes back from. A restore made since, of the note or of a folder
 * holding it, answers `null`: the note is back.
 *
 * Nothing here asks whether the caller may see the note. Both readers
 * (`functions/trashedNotes.ts`) ask that first, and the trash key is plumbing
 * no listing ever draws.
 */

import type { Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import { TRASH_ROOT } from "../fileOps/store";

/** Trail rows read looking for the trash: a few minutes of a busy workspace, which is when this is asked. */
export const TRAIL_SCAN = 300;

export interface TrashEntry {
  /** The trash key Restore takes back from. */
  trash: string;
  at: number;
  /** Who moved it there, when the trail says. */
  actorUserId: Id<"users"> | undefined;
}

/** `path` itself, or a note inside the folder `at`. */
function within(path: string, at: unknown): at is string {
  return typeof at === "string" && at !== "" && (path === at || path.startsWith(`${at}/`));
}

export async function trashEntryOf(db: QueryCtx["db"], workspaceId: Id<"workspaces">, path: string): Promise<TrashEntry | null> {
  const events = await db
    .query("auditEvents")
    .withIndex("by_workspace_at", (q) => q.eq("workspaceId", workspaceId))
    .order("desc")
    .take(TRAIL_SCAN);
  for (const event of events) {
    // The note came back, alone or with the folder it is in.
    if (event.action === "file.move" && event.details?.restoredFromTrash === true && within(path, event.paths[1])) return null;
    if (event.action !== "file.archive" || event.details?.trash !== true) continue;
    const went = event.paths[0];
    if (!within(path, went)) continue;
    const key = event.paths[1];
    if (typeof key !== "string" || !key.startsWith(`${TRASH_ROOT}/`)) return null;
    return {
      trash: `${key}${path.slice(went.length)}`,
      at: event.at,
      actorUserId: event.actorUserId as Id<"users"> | undefined,
    };
  }
  return null;
}
