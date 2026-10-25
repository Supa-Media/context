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
import { keyedWorkspace } from "./lib/noteIds/keyedState";
import { nodePaths } from "./lib/nodes/paths";

/** Rows one `listLive` call returns at most. */
const LIST_CAP = 2_000;

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
 * Live file rows in the tree's order (`TreePaths.walk`), from just after `after`. Capped at
 * `LIST_CAP`; `cursor` is the last path returned when there may be more.
 */
export const listLive = internalQuery({
  args: { workspaceId: v.id("workspaces"), after: v.optional(v.string()), limit: v.number() },
  returns: v.object({
    rows: v.array(rowValidator),
    cursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, { workspaceId, after, limit }) => {
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
    ).walk("", after, (doc) => {
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

/** Whether the workspace is keyed (`lib/noteIds/keyedState.ts`), for the tree's runs to check before they sweep or check it. INTERNAL. */
export const isKeyed = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.boolean(),
  handler: async (ctx, { workspaceId }): Promise<boolean> => keyedWorkspace(ctx.db, workspaceId),
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
