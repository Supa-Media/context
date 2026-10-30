/**
 * The workspace tree's internal functions (`lib/schema/nodes.ts`). Every one
 * is internal: a client never writes the tree directly. Rows are written by the
 * product's seam (writes, moves, trash and the keyed copy), never by listing
 * the bucket.
 *
 * Every reader of which notes exist answers from these rows once the
 * workspace's `nodeTrees` row is `ready` (`lib/nodes/listing.ts`,
 * `docs/decisions/app-and-console/convex-tree.md`).
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { readMirror, treeServesNow } from "./lib/nodes/listing";
import { readerMirror } from "./lib/nodes/readerRules";
import { liveNode } from "./lib/nodes/facts";
import { mirrorRules } from "./lib/nodes/log";
import { canSee } from "./lib/privacy";
import { migrationPaused } from "./lib/nodes/pause";
import { nodePaths } from "./lib/nodes/paths";

/** Rows one `listLive` call returns at most. */
const LIST_CAP = 2_000;

/** Rows observed since a check-in's last look that `listChangedSince` reads before it says "too many". */
export const CHANGED_CAP = 1_000;

const rowValidator = v.object({
  path: v.string(),
  etag: v.optional(v.string()),
  size: v.optional(v.number()),
  uploaded: v.optional(v.number()),
  noteId: v.optional(v.string()),
});

const mirrorValidator = v.object({
  etag: v.optional(v.string()),
  invalid: v.boolean(),
  folders: v.array(v.object({ prefix: v.string(), visibility: v.string() })),
  notes: v.array(v.object({ path: v.string(), visibility: v.string() })),
  /** Set on a reader's mirror in rows mode: `folders` and `notes` are the rows' judgement, not file text. */
  rows: v.optional(v.boolean()),
});

/** Whether the workspace has a storage binding (a row, nothing decrypted). A workspace with none has nothing to read. */
export const bound = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.boolean(),
  handler: async (ctx, { workspaceId }): Promise<boolean> => {
    const binding = await ctx.db
      .query("storageBindings")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .first();
    return binding !== null;
  },
});

/**
 * Live notes written after `since`, each at its path now, in key order: what a check-in asks
 * (`lib/nodes/gatewayManifest.ts`), read by the `observedAt` index rather than by walking the tree, so it
 * costs the rows that changed and the folders above them, however big the workspace (2026-10-28: a whole
 * built-path walk per look took longer than the gateway waits). Every row written is observed then, so
 * none is missed; a row only re-observed is passed over by its `uploaded`. `complete` is false when more
 * than `CHANGED_CAP` rows were observed since, and the caller walks the whole tree instead.
 */
export const listChangedSince = internalQuery({
  args: { workspaceId: v.id("workspaces"), since: v.number() },
  returns: v.object({ rows: v.array(rowValidator), complete: v.boolean() }),
  handler: async (ctx, { workspaceId, since }) => {
    const observed = await ctx.db
      .query("nodes")
      .withIndex("by_workspace_observed", (q) => q.eq("workspaceId", workspaceId).gt("observedAt", since))
      .take(CHANGED_CAP + 1);
    if (observed.length > CHANGED_CAP) return { rows: [], complete: false };
    const paths = await nodePaths(ctx.db, workspaceId);
    const rows: { path: string; etag?: string; size?: number; uploaded?: number; noteId?: string }[] = [];
    for (const doc of observed) {
      if (doc.kind !== "file" || doc.goneAt !== undefined) continue;
      if (doc.uploaded === undefined || doc.uploaded <= since) continue;
      const path = await paths.pathOf(doc);
      if (path === null) continue;
      rows.push({
        path,
        etag: doc.etag,
        size: doc.size,
        uploaded: doc.uploaded,
        ...(doc.noteId === undefined ? {} : { noteId: doc.noteId }),
      });
    }
    rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { rows, complete: true };
  },
});

/**
 * Live file rows in the tree's order (`TreePaths.walk`), from just after `after`. Capped at
 * `LIST_CAP`; `cursor` is the last path returned when there may be more. `root` keeps the walk
 * inside one folder: a folder's listing used to read on past its last row to the cap, through
 * the rest of the tree, which was most of this query's database reads (Convex invoice, owner
 * 2026-10-30).
 */
export const listLive = internalQuery({
  args: { workspaceId: v.id("workspaces"), after: v.optional(v.string()), limit: v.number(), root: v.optional(v.string()) },
  returns: v.object({
    rows: v.array(rowValidator),
    cursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, { workspaceId, after, limit, root }) => {
    const size = Math.max(1, Math.min(Math.floor(limit), LIST_CAP));
    const rows: {
      path: string;
      etag?: string;
      size?: number;
      uploaded?: number;
      noteId?: string;
    }[] = [];
    await (
      await nodePaths(ctx.db, workspaceId)
    ).walk(root ?? "", after, (doc) => {
      if (doc.kind !== "file" || doc.goneAt !== undefined) return;
      rows.push({
        path: doc.path,
        etag: doc.etag,
        size: doc.size,
        uploaded: doc.uploaded,
        ...(doc.noteId === undefined ? {} : { noteId: doc.noteId }),
      });
      return rows.length < size;
    });
    const cursor = rows.length >= size ? rows[rows.length - 1].path : null;
    return { rows, cursor };
  },
});

/** The privacy rules the tree last mirrored from `privacy.md`, or null when none. */
export const privacy = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.union(v.null(), mirrorValidator),
  handler: async (ctx, { workspaceId }) => await readMirror(ctx.db, workspaceId),
});

/**
 * Whether a link's readers, at `team` with no names, would see this note, and
 * whether its facts say it is sealed: the share-link mint's courtesy check,
 * from the rows and the rules mirror rather than by opening the note. `null`
 * while the tree does not serve. An unreadable `privacy.md` sees nothing.
 */
export const teamShareable = internalQuery({
  args: { workspaceId: v.id("workspaces"), path: v.string() },
  returns: v.union(v.null(), v.object({ visible: v.boolean(), sealed: v.boolean() })),
  handler: async (ctx, { workspaceId, path }) => {
    if (!(await treeServesNow(ctx.db, workspaceId))) return null;
    const row = await liveNode(ctx.db, workspaceId, path);
    const mirror = await readerMirror(ctx, workspaceId);
    if (row === null || mirror?.invalid === true) return { visible: false, sealed: false };
    const rules = await mirrorRules(mirror);
    return { visible: canSee(path, "team", rules.rules, rules.overrides), sealed: row.sealed === true };
  },
});

/**
 * Whether the tree answers this workspace's walks (its `nodeTrees` row is
 * `ready`), and with which rules: read in one transaction, so a walk never
 * pairs a served tree with rules from before the check. `null` is "not
 * served", never "ask the bucket".
 */
export const served = internalQuery({
  // `guest`: the rules a pin reader is judged by (`lib/pinnedReaders.ts`). A member's when absent.
  args: { workspaceId: v.id("workspaces"), audience: v.optional(v.union(v.literal("member"), v.literal("guest"))) },
  returns: v.union(v.null(), v.object({ mirror: v.union(v.null(), mirrorValidator) })),
  handler: async (ctx, { workspaceId, audience }) => {
    if (!(await treeServesNow(ctx.db, workspaceId))) return null;
    return { mirror: await readerMirror(ctx, workspaceId, audience ?? "member") };
  },
});

/** Whether staff paused the migration (`lib/nodes/pause.ts`). */
export const paused = internalQuery({
  args: {},
  returns: v.boolean(),
  handler: async (ctx): Promise<boolean> => await migrationPaused(ctx.db),
});
