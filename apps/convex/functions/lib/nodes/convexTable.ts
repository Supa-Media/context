/**
 * The `NodeTable` of one workspace, over Convex's `nodes` table. The rules
 * that change it are in `observe.ts`; this file only knows how to read and
 * write rows through the three indexes.
 *
 * Tenancy: every read is an index range that starts at this workspace, and
 * every write addressed by id first loads the row and refuses one that
 * belongs to another workspace. An id is an opaque string a caller may have
 * been handed, so it is never trusted to name a row of this workspace.
 */

import { roleForNewFolder } from "./folderJobs";
import type { Doc, Id } from "../../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import { nodePath, type LeftAudiences, type NodeTable, type StoredNode } from "./table";
import { readerMirror } from "./readerRules";
import { NODE_LOG_PRUNE, audiencesNow, expiredBefore, mirrorRules, nextSeq, type Rules } from "./log";
import { newNoteId } from "./noteIds";
import { applyPendingAccess } from "./pendingAccess";

/**
 * The fields a patch may set. A key passed as `undefined` clears the field
 * (`patch` below), so a row leaves keyed state by `storageKey: undefined`.
 */
const PATCHABLE = [
  "parentId",
  "name",
  "etag",
  "size",
  "uploaded",
  "observedAt",
  "goneAt",
  "noteId",
  "storageKey",
  "idCopy",
  "keyedFrom",
] as const;

function toStored(doc: Doc<"nodes">): StoredNode {
  return {
    id: doc._id,
    path: doc.path,
    parentId: doc.parentId,
    name: doc.name,
    kind: doc.kind,
    etag: doc.etag,
    size: doc.size,
    uploaded: doc.uploaded,
    observedAt: doc.observedAt,
    goneAt: doc.goneAt,
    noteId: doc.noteId,
    storageKey: doc.storageKey,
    idCopy: doc.idCopy,
    keyedFrom: doc.keyedFrom,
    access: doc.access,
    role: doc.role,
  };
}

/**
 * The table for `workspaceId`. Pass a `QueryCtx` for reads only (`insert`,
 * `patch`, `remove` will then be unavailable at runtime, so callers that
 * write take a `MutationCtx`).
 */
export function convexNodeTable(ctx: MutationCtx, workspaceId: Id<"workspaces">, left?: readonly LeftAudiences[]): NodeTable;
export function convexNodeTable(ctx: QueryCtx, workspaceId: Id<"workspaces">): Pick<NodeTable, "byPath" | "underPrefix" | "observedBefore" | "hasLiveChild">;
export function convexNodeTable(
  ctx: MutationCtx | QueryCtx,
  workspaceId: Id<"workspaces">,
  left: readonly LeftAudiences[] = [],
): NodeTable {
  const writable = "insert" in ctx.db;
  const ownRow = async (id: string): Promise<Id<"nodes">> => {
    const nodeId = id as Id<"nodes">;
    const doc = await ctx.db.get(nodeId);
    if (doc === null || doc.workspaceId !== workspaceId) throw new Error("node is not in this workspace");
    return nodeId;
  };
  const writer = ctx as MutationCtx;
  // What the writer knew of who could see each key before it left: a gone row narrows to it.
  const knewBefore = new Map<string, Set<string>>();
  for (const entry of left) {
    const path = nodePath(entry.path);
    if (path !== null) knewBefore.set(path, new Set(entry.audiences));
  }
  /**
   * Who a key that left is told to. The rules as they stand, narrowed to what
   * the writer said could see it before: a move clears the source's exact
   * exception before the tree is re-checked, so the rules alone would answer
   * with the folder's default and name a private note to the team. Narrowed,
   * never widened: the writer's word only ever takes audiences away.
   */
  const goneAudiences = async (path: string): Promise<string[]> => {
    const now = audiencesNow(path, await rulesNow());
    const before = knewBefore.get(path);
    return before === undefined ? now : now.filter((audience) => before.has(audience));
  };

  /*
    The change log's state for this transaction, read on the first append:
    the last `seq` (which every later append in it counts on from) and the
    rules a row that leaves records its audiences by. Reading the last row
    is also what makes two appenders conflict, so `seq` follows commit order.
  */
  let lastSeq: number | undefined;
  let logOpened = false;
  let rules: Rules | null = null;
  const openLog = async (): Promise<void> => {
    if (logOpened) return;
    logOpened = true;
    const last = await writer.db
      .query("nodeLog")
      .withIndex("by_workspace_seq", (q) => q.eq("workspaceId", workspaceId))
      .order("desc")
      .first();
    lastSeq = last?.seq;
    // Rows past keeping go as later ones arrive, a few per append; the newest is never among them.
    const expired = await writer.db
      .query("nodeLog")
      .withIndex("by_workspace_seq", (q) => q.eq("workspaceId", workspaceId).lt("seq", expiredBefore(Date.now())))
      .take(NODE_LOG_PRUNE);
    for (const row of expired) if (row._id !== last?._id) await writer.db.delete(row._id);
  };
  const rulesNow = async (): Promise<Rules> => {
    if (rules === null) rules = await mirrorRules(await readerMirror(writer, workspaceId));
    return rules;
  };

  return {
    async byPath(path) {
      const doc = await ctx.db
        .query("nodes")
        .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId).eq("path", path))
        .unique();
      return doc === null ? null : toStored(doc);
    },

    async insert(node) {
      if (!writable) throw new Error("insert on a read-only node table");
      // Every row has its id from the start (`noteIds.ts`): a seam write brings the note's own, a bucket row mints one.
      const noteId = node.noteId ?? newNoteId();
      // A built-in folder takes its job the moment its row is made (`folderJobs.ts`).
      const role = node.goneAt === undefined ? await roleForNewFolder(writer.db, workspaceId, node) : undefined;
      const id = await writer.db.insert("nodes", {
        workspaceId,
        noteId,
        storageKey: node.storageKey,
        path: node.path,
        parentId: node.parentId as Id<"nodes"> | undefined,
        name: node.name,
        kind: node.kind,
        etag: node.etag,
        size: node.size,
        uploaded: node.uploaded,
        observedAt: node.observedAt,
        goneAt: node.goneAt,
        ...(role === undefined ? {} : { role }),
      });
      // A row born where access was asked for before it existed takes that access now, in this mutation.
      if (node.goneAt === undefined) {
        await applyPendingAccess(writer, workspaceId, { id, path: node.path, kind: node.kind, noteId }, Date.now());
      }
      return id;
    },

    async patch(id, fields) {
      if (!writable) throw new Error("patch on a read-only node table");
      const nodeId = await ownRow(id);
      // Only the keys the caller named: a key passed as `undefined` clears that
      // field, and a key left out keeps it (a tombstone must not wipe an etag).
      const patch: Record<string, unknown> = {};
      for (const key of PATCHABLE) {
        if (Object.prototype.hasOwnProperty.call(fields, key)) {
          patch[key] = (fields as Record<string, unknown>)[key];
        }
      }
      await writer.db.patch(nodeId, patch as Partial<Doc<"nodes">>);
    },

    async remove(id) {
      if (!writable) throw new Error("remove on a read-only node table");
      await writer.db.delete(await ownRow(id));
    },

    async underPrefix(prefix, { after, limit }) {
      // Everything under `prefix` sorts from `prefix` on; resume strictly after
      // `after` when it is itself under the walk. Stops at the first key that
      // leaves the prefix, so a page never reads past its own range.
      const lower = after !== undefined && after >= prefix ? after : prefix;
      const strictly = after !== undefined && after >= prefix;
      const rows = ctx.db.query("nodes").withIndex("by_workspace_path", (q) => {
        const scoped = q.eq("workspaceId", workspaceId);
        return strictly ? scoped.gt("path", lower) : scoped.gte("path", lower);
      });
      const out: StoredNode[] = [];
      for await (const doc of rows) {
        if (!doc.path.startsWith(prefix)) break;
        out.push(toStored(doc));
        if (out.length >= limit) break;
      }
      return out;
    },

    async hasLiveChild(parentId) {
      const child = await ctx.db
        .query("nodes")
        .withIndex("by_parent_name", (q) => q.eq("workspaceId", workspaceId).eq("parentId", parentId as Id<"nodes">))
        .filter((q) => q.eq(q.field("goneAt"), undefined))
        .first();
      return child !== null;
    },

    async idHeldElsewhere(noteId, exceptId) {
      const holders = await ctx.db
        .query("nodes")
        .withIndex("by_workspace_noteId", (q) => q.eq("workspaceId", workspaceId).eq("noteId", noteId))
        .collect();
      return holders.some((holder) => holder._id !== exceptId && holder.goneAt === undefined);
    },

    async logChange(path, gone) {
      if (!writable) throw new Error("log on a read-only node table");
      await openLog();
      const seq = nextSeq(lastSeq, Date.now());
      lastSeq = seq;
      await writer.db.insert("nodeLog", {
        workspaceId,
        seq,
        path,
        gone,
        // Who could see it until now, judged by the rules as they stand (the
        // only honest answer once it has left, `log.ts`), narrowed to what
        // its writer knew of before the change (`goneAudiences`).
        ...(gone ? { audiences: await goneAudiences(path) } : {}),
      });
    },

    async observedBefore(before, limit) {
      // A keyed row is never pruned by an observation's age (`observe.ts`), so it is
      // not read here at all: a page of only keyed rows would otherwise never end.
      // The same holds for a row carrying its own access (`nodes.access`, the
      // folder anchors and overrides `accessBackfill.ts` derives): a rule names it.
      const docs = await ctx.db
        .query("nodes")
        .withIndex("by_workspace_observed", (q) => q.eq("workspaceId", workspaceId).lt("observedAt", before))
        .filter((q) => q.and(q.eq(q.field("storageKey"), undefined), q.eq(q.field("access"), undefined)))
        .take(limit);
      return docs.map(toStored);
    },
  };
}
