/**
 * The trash: what a person moved there, when it is erased for good, and the
 * erasing (decided by the owner, 2026-10-17: "30 days, Trash page first";
 * `docs/decisions/storage-and-credentials/notes-by-id.md`, "Emptying the
 * trash").
 *
 * `listTrash` answers the Trash page: each thing in the trash this caller may
 * see, judged by its own name as it stood when it was trashed
 * (`lib/trash/bin.ts`, `rulesAsTrashed`), with when it is erased. Restore is
 * the ordinary `restoreTrash` operation, with the trash key answered here.
 *
 * Erasing is never silent: every trashed note shows its date before it comes,
 * on this page and on the note itself (`trashedNotes.ts`). It runs once a day
 * (`crons.ts`) and only in a keyed workspace, where the trash is rows and the
 * notes' bytes are at their id keys. A trash made the old way, as bytes moved
 * into `.context/trash/` in the bucket, is never erased by this.
 *
 * Each erasure re-asks, in the one transaction that makes it, everything that
 * could have changed since it was scheduled: the workspace is still keyed, the
 * trash is still there, and it is still past its date. It removes the rows
 * first (so nothing can restore a note whose bytes are going) and records what
 * the bucket must still remove in `trashErasures`, which the bucket half
 * (`trashEmptying.ts`) works off and clears.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, query, type MutationCtx } from "../_generated/server";
import { recordAudit } from "./lib/audit";
import { clearanceOf } from "./lib/clearance";
import { callerId, personalNameFor, resolveFileAccess } from "./lib/filesFns/access";
import { rulesForReaders } from "./lib/nodes/readerRules";
import { keyedWorkspace } from "./lib/noteIds/keyedState";
import { canSee } from "./lib/privacy";
import {
  GROUP_SCAN,
  TRASH_KEEP_DAYS,
  rowsUnder,
  rulesAsTrashed,
  stampFolders,
  trashedItemOf,
  type StampFolder,
} from "./lib/trash/bin";
import { nodeAt, removalPage } from "./lib/nodes/paths";

/** Things one Trash page lists: soonest erased first, and `more` past it. */
export const LIST_MAX = 200;
/** Workspaces one page of the daily pass looks at: each may read up to `STAMP_SCAN` rows, inside one mutation. */
const WORKSPACE_PAGE = 20;

const itemValidator = v.object({
  /** The trash key Restore takes back from. */
  trash: v.string(),
  /** Where it was, and where Restore puts it. */
  path: v.string(),
  kind: v.union(v.literal("file"), v.literal("folder")),
  /** When it was moved to the trash. */
  at: v.number(),
  /** When it is erased for good. */
  eraseAt: v.number(),
  byYou: v.boolean(),
  /** "@ana", or `null` when the mover has no personal workspace or the trail does not say. */
  byName: v.union(v.string(), v.null()),
  /** Notes inside a trashed folder this caller may see; 1 for a note. */
  notes: v.number(),
});

type Item = typeof itemValidator.type;

/** The Trash page: what this caller may see in the workspace's trash, soonest erased first. */
export const listTrash = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({ items: v.array(itemValidator), more: v.boolean(), keepDays: v.number() }),
  handler: async (ctx, { workspaceId }) => {
    const actorUserId = await callerId(ctx);
    const { scope, grantedNames } = await resolveFileAccess(ctx, { actorUserId, workspaceId, minimum: "member" });
    const clearance = clearanceOf(scope, grantedNames);
    const live = scope === "private" ? null : await rulesForReaders(ctx, workspaceId);
    const items: Item[] = [];
    let more = false;
    for (const stamp of await stampFolders(ctx.db, workspaceId)) {
      if (items.length >= LIST_MAX) {
        more = true;
        break;
      }
      const rows = await rowsUnder(ctx.db, workspaceId, stamp.folder);
      const item = await trashedItemOf(ctx.db, workspaceId, stamp, rows);
      if (item === null) continue;
      const rules = live === null ? null : rulesAsTrashed(live, stamp.folder);
      const sees = (path: string) => rules === null || canSee(path, clearance.scope, rules.rules, rules.overrides, clearance.names);
      if (!sees(item.path)) continue;
      const notes =
        item.kind === "file"
          ? 1
          : rows.filter(
              (row) =>
                row.kind === "file" &&
                row.goneAt === undefined &&
                row.path.startsWith(`${item.trash}/`) &&
                sees(row.path.slice(stamp.folder.length + 1)),
            ).length;
      const by = item.actorUserId;
      items.push({
        trash: item.trash,
        path: item.path,
        kind: item.kind,
        at: stamp.at,
        eraseAt: stamp.eraseAt,
        byYou: by === actorUserId,
        byName: by === undefined ? null : await personalNameFor(ctx, by),
        notes,
      });
    }
    return { items, more, keepDays: TRASH_KEEP_DAYS };
  },
});

/* -------------------------------------------------------------------------- */
/*                                   erasing                                  */
/* -------------------------------------------------------------------------- */

/** Whether a workspace has anything to erase at `now`: a trash past its date, or a bucket half left to finish. */
async function owesErasing(ctx: MutationCtx, workspaceId: Id<"workspaces">, now: number): Promise<boolean> {
  const pending = await ctx.db.query("trashErasures").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).first();
  if (pending !== null) return true;
  return (await stampFolders(ctx.db, workspaceId)).some((stamp) => stamp.eraseAt <= now);
}

/**
 * The daily pass (`crons.ts`): one page of keyed workspaces, each one owed an
 * erasure handed to the bucket half, and the next page scheduled. Holds no
 * decision: `claimErasure` asks everything again when it acts.
 */
export const emptyDue = internalMutation({
  args: { cursor: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { cursor }) => {
    const layout = await ctx.db.query("noteIdLayout").first();
    if (layout?.mode !== "keys") return null;
    const now = Date.now();
    const page = await ctx.db.query("noteIdCopies").paginate({ cursor: cursor ?? null, numItems: WORKSPACE_PAGE });
    for (const copies of page.page) {
      if (copies.keyedAt === undefined) continue;
      if (!(await owesErasing(ctx, copies.workspaceId, now))) continue;
      await ctx.scheduler.runAfter(0, internal.functions.trashEmptying.eraseWorkspace, { workspaceId: copies.workspaceId });
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.functions.trash.emptyDue, { cursor: page.continueCursor });
    return null;
  },
});

/** Remove one row and what hangs off it in the control plane: its grants. */
export async function removeRow(ctx: MutationCtx, row: Doc<"nodes">): Promise<void> {
  for (const grant of await ctx.db.query("nodeAccess").withIndex("by_node", (q) => q.eq("nodeId", row._id)).collect()) {
    await ctx.db.delete(grant._id);
  }
  await ctx.db.delete(row._id);
}

/** Links a trashed note left at its own name (a trash leaves them there, for Restore), when nothing lives there now. */
export async function dropLinks(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  path: string,
): Promise<void> {
  const holder = await nodeAt(ctx.db, workspaceId, path);
  if (holder !== null && holder.goneAt === undefined) return;
  for (const link of await ctx.db
    .query("nodeLinks")
    .withIndex("by_workspace_source", (q) => q.eq("workspaceId", workspaceId).eq("source", path))
    .collect()) {
    await ctx.db.delete(link._id);
  }
}

/**
 * Erase the oldest trash past its date, in the control plane, and record what
 * the bucket must still remove. Answers the erasure's id, or `null` when there
 * is nothing to erase now (the workspace is not keyed, or no trash is due).
 *
 * The rows go in this transaction: from here the note is gone, and Restore
 * finds nothing. A folder too big for one transaction (`GROUP_SCAN` rows) is
 * erased over several, its stamp folder last.
 */
export const claimErasure = internalMutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.union(v.id("trashErasures"), v.null()),
  handler: async (ctx, { workspaceId }) => {
    if (!(await keyedWorkspace(ctx.db, workspaceId))) return null;
    const now = Date.now();
    const due: StampFolder | undefined = (await stampFolders(ctx.db, workspaceId)).find((stamp) => stamp.eraseAt <= now);
    if (due === undefined) return null;
    // Files first, and the folders once nothing is left beneath them (`removalPage`).
    const page = await removalPage(ctx.db, workspaceId, due.folder, GROUP_SCAN);
    const item = await trashedItemOf(ctx.db, workspaceId, due, [
      ...page.folders,
      ...page.files,
    ]);
    const rows = page.whole
      ? [...page.files, ...page.folders.reverse()]
      : page.files;
    const files = rows.filter(
      (row) => row.kind === "file" && row.goneAt === undefined,
    );
    const keys = files.flatMap((row) =>
      row.storageKey === undefined ? [] : [row.storageKey],
    );
    const histories = files
      .filter((row) => row.path.endsWith(".md"))
      .map((row) => row.path);
    for (const row of rows) await removeRow(ctx, row);
    for (const row of files)
      await dropLinks(ctx, workspaceId, row.path.slice(due.folder.length + 1));
    if (page.whole) await removeRow(ctx, due.row);

    const path = item?.path ?? due.folder;
    const erasure = await ctx.db.insert("trashErasures", {
      workspaceId,
      folder: due.folder,
      path,
      keys,
      histories,
      claimedAt: now,
      attempts: 0,
    });
    await recordAudit(ctx, {
      workspaceId,
      action: "file.delete",
      paths: [path],
      details: { files: files.length, erasedFromTrash: true, keptDays: TRASH_KEEP_DAYS },
    });
    return erasure;
  },
});

/** The erasures this workspace's bucket has still to finish, oldest first. */
export const pendingErasures = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.array(v.object({ id: v.id("trashErasures"), keys: v.array(v.string()), histories: v.array(v.string()) })),
  handler: async (ctx, { workspaceId }) =>
    (await ctx.db.query("trashErasures").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).take(50)).map((row) => ({
      id: row._id,
      keys: row.keys,
      histories: row.histories,
    })),
});

/** The bucket removed everything this erasure named. */
export const finishErasure = internalMutation({
  args: { id: v.id("trashErasures") },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    if ((await ctx.db.get(id)) !== null) await ctx.db.delete(id);
    return null;
  },
});

/** The bucket could not finish this erasure: kept, with a fixed label, for the next pass. */
export const failErasure = internalMutation({
  args: { id: v.id("trashErasures"), error: v.string() },
  returns: v.null(),
  handler: async (ctx, { id, error }) => {
    const row = await ctx.db.get(id);
    if (row !== null) await ctx.db.patch(id, { attempts: row.attempts + 1, error });
    return null;
  },
});
