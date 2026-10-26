/**
 * A share follows its note by the note's stable id.
 *
 * A share row records the path the owner pointed at (`entryPath`) and, since
 * notes are stored by id, the row's `noteId` (`entryNoteId`). The id is what the
 * share means: a rename or a move changes the path and never the id, so
 * resolving by id reaches the note wherever it is now, with no forwarding ledger
 * to consult and no ledger cap to outlive. And it is the security half too: a
 * different note later created at the old path has a different id, so it is
 * never served through a link minted on the first one.
 *
 * Only the locator changes. Whether the reader may see the note is decided after
 * this, as before, by the live access rows at `team` scope
 * (`readThroughShare`), so following a note into a private folder makes the
 * link absent, not wider.
 *
 * A row with no `entryNoteId` predates the field, and an id no single live row
 * holds cannot answer: both resolve through the ledger as before
 * (`readPath.ts`). `stampEntryNoteIds` fills the first kind.
 */

import { v } from "convex/values";
import type { Doc, Id } from "../../../_generated/dataModel";
import type { DatabaseReader, MutationCtx } from "../../../_generated/server";
import { ledgerOf, ledgerRows } from "../smallData/forwarding";
import { forwardPath } from "../../../../mcp/src/forwarding.js";
import { located, nodeAt } from "../nodes/paths";

/** Rows one stamping pass reads. */
export const STAMP_PAGE = 200;
/** Rows read for one id: the live one, and the tombstones queued moves leave holding it. */
const ID_ROWS_READ = 16;

/**
 * The stable id of the live row at `path`, note or folder, or `undefined` when
 * there is none (or it has no id yet). What a mint stamps on the share.
 */
export async function entryNoteIdAt(db: DatabaseReader, workspaceId: Id<"workspaces">, path: string): Promise<string | undefined> {
  const row = await nodeAt(db, workspaceId, path);
  if (row === null || row.goneAt !== undefined) return undefined;
  return row.noteId;
}

/**
 * Where a share's note is now.
 *
 * `byId` says the answer came from the note's id, so the caller must not
 * forward it again through the ledger: the ledger records paths, and forwarding
 * a live path could hand the link to whatever moved away from it.
 *
 * The id answers when exactly one live row of the share's kind holds it. A
 * queued move leaves its tombstone holding the id beside the live target
 * (`carryIdentity`), so gone rows are not counted. Otherwise, for a row with
 * no stamp, an id no live row holds, or one two live rows hold (a duplicate the
 * repair tool has not fixed yet), the answer is the minted path for the ledger
 * to forward, exactly as before ids existed. That is not a widening: a move in
 * a workspace whose rows are not keyed yet gives the moved note a new id, and
 * the ledger is what still follows it there; and whatever path is reached, the
 * read that follows decides visibility from the live rows at `team` scope.
 *
 * The id answers only in a keyed workspace, the one kind where an id is the
 * note's for good. Before the flip a move re-ids the moved note and a later
 * note written at the old path can take up the id its tombstone kept, so an id
 * there could hand the link to a different note (`shareSurvivesMove.test.ts`,
 * "a different note later created at the old path is not served").
 */
export async function liveEntryOf(
  db: DatabaseReader,
  share: Pick<Doc<"noteShares">, "workspaceId" | "entryPath" | "entryNoteId" | "entryKind">,
): Promise<{ path: string; byId: boolean }> {
  const minted = { path: share.entryPath, byId: false };
  if (share.entryNoteId === undefined) return minted;
  const rows = await db
    .query("nodes")
    .withIndex("by_workspace_noteId", (q) => q.eq("workspaceId", share.workspaceId).eq("noteId", share.entryNoteId as string))
    .take(ID_ROWS_READ);
  const kind = share.entryKind === "folder" ? "folder" : "file";
  const live = rows.filter((row) => row.goneAt === undefined && row.kind === kind);
  if (live.length !== 1) return minted;
  // Where the note is now, from its parents: the name the share follows it to.
  const at = await located(db, live[0]);
  return at === null ? minted : { path: at.path, byId: true };
}

export const stampEntryNoteIdsArgs = { cursor: v.optional(v.union(v.string(), v.null())) };
export const stampEntryNoteIdsReturns = v.object({ stamped: v.number(), next: v.union(v.string(), v.null()) });

/**
 * Fill `entryNoteId` on shares that predate it, a page at a time, rescheduling
 * itself until the walk ends. Started daily by the cron, so it also catches any
 * row a mint left unstamped (a note not yet in the tree when it was minted).
 *
 * Each row is resolved through the forwarding ledger first, exactly as a read
 * of it would be, so the id stamped is the note the link reaches today. A row
 * whose note is not in the tree is left as it is: it reads as before, and the
 * next pass tries again. Revoked rows are skipped; they never resolve.
 */
export async function stampEntryNoteIdsPage(
  ctx: MutationCtx,
  args: { cursor?: string | null },
): Promise<{ stamped: number; next: string | null }> {
  const page = await ctx.db
    .query("noteShares")
    .withIndex("by_entryNoteId", (q) => q.eq("entryNoteId", undefined))
    .paginate({ numItems: STAMP_PAGE, cursor: args.cursor ?? null });
  let stamped = 0;
  for (const share of page.page) {
    if (share.status !== "active") continue;
    const path = forwardPath(ledgerOf(await ledgerRows(ctx.db, share.workspaceId)), share.entryPath) ?? share.entryPath;
    const row = await nodeAt(ctx.db, share.workspaceId, path);
    if (row === null || row.goneAt !== undefined || row.noteId === undefined) continue;
    if (row.kind !== (share.entryKind === "folder" ? "folder" : "file")) continue;
    await ctx.db.patch(share._id, { entryNoteId: row.noteId });
    stamped += 1;
  }
  return { stamped, next: page.isDone ? null : page.continueCursor };
}
