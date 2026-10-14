/**
 * The workspace's own emoji as Convex holds them (`customEmoji`): a name and
 * the image-store leaf its picture is under. The picture stays in the
 * bucket (`lib/fileOps/emoji.ts`); these rows are what every list, every
 * "does this emoji exist" and every read by name asks, so no listing of the
 * image store is made on a request path.
 */

import type { Doc, Id } from "../../../_generated/dataModel";
import type { DatabaseReader } from "../../../_generated/server";

/** Emoji one read takes: far past any workspace's. */
const EMOJI_READ_BOUND = 4_000;

/** Every emoji, by name. */
export async function emojiRows(db: DatabaseReader, workspaceId: Id<"workspaces">): Promise<Doc<"customEmoji">[]> {
  const rows = await db
    .query("customEmoji")
    .withIndex("by_workspace_name", (q) => q.eq("workspaceId", workspaceId))
    .take(EMOJI_READ_BOUND);
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}
