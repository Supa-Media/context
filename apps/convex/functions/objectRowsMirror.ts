/**
 * Convex written behind a workspace object's note write (decided by the owner, 2026-11-02:
 * `docs/decisions/storage-and-credentials/object-row-writes.md`).
 *
 * The object takes a note's version first and stamps it with its own clock. The gateway then tells Convex, through
 * `POST /gateway/rows/mirror` (`functions/lib/gatewayRoutes/rowsMirror.ts`), which calls `wrote` here, so Convex's
 * row says the same. The change is applied the way the gateway's own write would apply it (`recordKeyedRow` for a
 * keyed note, `recordCopyRow` for an unkeyed copy), with no authorization and no settle: the route already checked the
 * gateway secret, and the object already holds the change.
 *
 * `wrote` answers `{ applied: true }` when the row took the change, and `{ applied: false, reason }` when it did not.
 * It never throws for a row that is missing or a record Convex refuses: the caller drops such a change, so a refused
 * one is not retried forever. Each applied change also keeps `objectAt` on the row at the object's clock, never
 * backwards, so a push Convex still sends for this row can be told apart from what the object wrote later.
 *
 * Built with `internalMutationMirrored`: its write is not opened as an outbox entry, so the mirror never sends the
 * change back to the object.
 */

import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutationMirrored } from "./lib/rowWatch/mutations";
import { nodeAt } from "./lib/noteIds/state";
import { recordCopyRow } from "./noteIds";
import { adoptKeyedRow, keyedPathOf, recordKeyedRow } from "./noteIdsKeyed";
import { nodeByObjectId, OBJECT_ROW_ID } from "./lib/nodes/objectIds";
import { mirrorTree, MIRROR_TREE_MAX } from "./lib/nodes/mirrorTree";
import type { MutationCtx } from "../_generated/server";

export const mirrorRecordValidator = v.object({
  path: v.string(),
  key: v.string(),
  etag: v.string(),
  size: v.optional(v.number()),
  at: v.optional(v.number()),
  keyed: v.boolean(),
  keyEtag: v.optional(v.string()),
});

export type MirrorWroteAnswer = { applied: true } | { applied: false; reason: string };

export const wrote = internalMutationMirrored({
  args: { workspaceId: v.id("workspaces"), objectAt: v.number(), record: mirrorRecordValidator },
  returns: v.union(v.object({ applied: v.literal(true) }), v.object({ applied: v.literal(false), reason: v.string() })),
  handler: async (ctx, { workspaceId, objectAt, record }): Promise<MirrorWroteAnswer> => {
    if (record.keyed) {
      // A keyed write is the note's own time; without it the write has nothing to say when it happened.
      if (record.at === undefined) return { applied: false, reason: "bad_record" };
      const applied = await recordKeyedRow(ctx, {
        workspaceId,
        path: record.path,
        key: record.key,
        etag: record.etag,
        ...(record.size === undefined ? {} : { size: record.size }),
        at: record.at,
      });
      return await settle(ctx, workspaceId, await keyedPathOf(ctx.db, workspaceId, record.path), objectAt, applied);
    }
    const applied = await recordCopyRow(ctx, {
      workspaceId,
      path: record.path,
      key: record.key,
      etag: record.etag,
      ...(record.keyEtag === undefined ? {} : { keyEtag: record.keyEtag }),
    });
    return await settle(ctx, workspaceId, record.path, objectAt, applied);
  },
});

export const mirrorAdoptValidator = v.object({
  path: v.string(),
  noteId: v.string(),
  key: v.string(),
  etag: v.string(),
  size: v.optional(v.number()),
  at: v.number(),
  objectId: v.string(),
});

/**
 * A new note the object made (`ws.write.adopt`): Convex gives it its row by the rule the gateway's own adoption takes
 * (`adoptKeyedRow`), and keeps the object's id on it (`nodes.objectId`), so every later push names the row as the
 * object does. Sent again after a lost answer, the row the object's id already names is the answer. A name Convex holds
 * for another note is `taken`: the change is dropped, and the object's row stays the note's.
 */
export const adopt = internalMutationMirrored({
  args: { workspaceId: v.id("workspaces"), objectAt: v.number(), record: mirrorAdoptValidator },
  returns: v.union(v.object({ applied: v.literal(true) }), v.object({ applied: v.literal(false), reason: v.string() })),
  handler: async (ctx, { workspaceId, objectAt, record }): Promise<MirrorWroteAnswer> => {
    if (!OBJECT_ROW_ID.test(record.objectId)) return { applied: false, reason: "bad_record" };
    const known = await nodeByObjectId(ctx.db, workspaceId, record.objectId);
    if (known !== null) {
      if (known.goneAt !== undefined || known.noteId !== record.noteId) return { applied: false, reason: "refused" };
      return await settle(ctx, workspaceId, (await keyedPathOf(ctx.db, workspaceId, record.path)), objectAt, true);
    }
    const answer = await adoptKeyedRow(ctx, {
      workspaceId,
      path: record.path,
      noteId: record.noteId,
      key: record.key,
      etag: record.etag,
      ...(record.size === undefined ? {} : { size: record.size }),
      at: record.at,
    });
    if (!answer.adopted) return { applied: false, reason: answer.taken === null ? "refused" : "taken" };
    const path = await keyedPathOf(ctx.db, workspaceId, record.path);
    const row = await nodeAt(ctx.db, workspaceId, path);
    if (row !== null && row.objectId === undefined) await ctx.db.patch(row._id, { objectId: record.objectId });
    return await settle(ctx, workspaceId, path, objectAt, true);
  },
});

/** A tree change the object took (`lib/nodes/mirrorTree.ts`): each list is capped at `MIRROR_TREE_MAX`, checked there. */
export const mirrorTreeValidator = v.object({
  moves: v.array(v.object({ id: v.string(), kind: v.union(v.literal("file"), v.literal("folder")), from: v.string(), to: v.string(), at: v.number() })),
  folders: v.array(v.object({ id: v.string(), noteId: v.union(v.string(), v.null()), path: v.string(), role: v.union(v.string(), v.null()), at: v.number() })),
  removed: v.array(v.object({ id: v.string(), at: v.number() })),
  trash: v.boolean(),
  erase: v.optional(v.boolean()),
});

export const tree = internalMutationMirrored({
  args: { workspaceId: v.id("workspaces"), objectAt: v.number(), record: mirrorTreeValidator },
  returns: v.union(v.object({ applied: v.literal(true) }), v.object({ applied: v.literal(false), reason: v.string() })),
  handler: async (ctx, { workspaceId, objectAt, record }): Promise<MirrorWroteAnswer> => {
    if (record.moves.length > MIRROR_TREE_MAX || record.folders.length > MIRROR_TREE_MAX || record.removed.length > MIRROR_TREE_MAX) {
      return { applied: false, reason: "bad_record" };
    }
    return await mirrorTree(ctx, { workspaceId, objectAt, record });
  },
});

/** The row at `path` takes the object's clock when the record applied; a missing row or a refused record says why. */
async function settle(ctx: MutationCtx, workspaceId: Id<"workspaces">, path: string, objectAt: number, applied: boolean): Promise<MirrorWroteAnswer> {
  const row = await nodeAt(ctx.db, workspaceId, path);
  if (row === null || row.goneAt !== undefined) return { applied: false, reason: "no_row" };
  if (!applied) return { applied: false, reason: "refused" };
  const next = Math.max(row.objectAt ?? 0, objectAt);
  if (next !== row.objectAt) await ctx.db.patch(row._id, { objectAt: next });
  return { applied: true };
}
