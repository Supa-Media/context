/**
 * The tree's side of copying each workspace into its workspace object, and
 * the one record of where its notes are read from (decided by the owner,
 * 2026-11-01; `docs/decisions/storage-and-credentials/workspace-objects.md`).
 * The actions that open a bucket and the object are `workspaceObjects.ts`;
 * these read and write only the tree and the record, never a credential, so
 * they stay out of the analyzer's decrypting list.
 */

import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type DatabaseReader } from "../_generated/server";
import { nodePaths } from "./lib/nodes/paths";

const homeValidator = v.union(v.literal("bucket"), v.literal("dual"), v.literal("object"));
export type NotesHome = "bucket" | "dual" | "object";

/** Rows walked per page: one page's rows stay well inside a query's read limits. */
const ROWS_PER_PAGE = 500;
/** Workspaces per page of a run. */
const WORKSPACES_PER_PAGE = 25;

const rowValidator = v.object({
  _id: v.string(),
  path: v.string(),
  kind: v.union(v.literal("file"), v.literal("folder")),
  noteId: v.optional(v.string()),
  storageKey: v.optional(v.string()),
  etag: v.optional(v.string()),
  size: v.optional(v.number()),
  collaborates: v.optional(v.boolean()),
  uploaded: v.optional(v.number()),
  role: v.optional(v.string()),
  order: v.optional(v.number()),
  archiveOf: v.optional(v.string()),
});

async function recordOf(db: DatabaseReader, workspaceId: Id<"workspaces">): Promise<Doc<"workspaceObjectHomes"> | null> {
  return await db
    .query("workspaceObjectHomes")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
}

/** Where `workspaceId`'s notes are read from: no record is `bucket`. */
export const homeOf = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: homeValidator,
  handler: async (ctx, { workspaceId }) => (await recordOf(ctx.db, workspaceId))?.home ?? "bucket",
});

/** The whole record, for a run to decide what is left to do. */
export const recordFor = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.any(),
  handler: async (ctx, { workspaceId }) => await recordOf(ctx.db, workspaceId),
});

/**
 * The live rows of one workspace, at the paths its readers use now
 * (`nodePaths`: built from parents where the workspace is flipped, so a moved
 * folder's notes are at their new paths), after the path `after`.
 */
export const rowsPage = internalQuery({
  args: { workspaceId: v.id("workspaces"), after: v.optional(v.string()) },
  returns: v.object({ rows: v.array(rowValidator), next: v.union(v.string(), v.null()) }),
  handler: async (ctx, { workspaceId, after }) => {
    const paths = await nodePaths(ctx.db, workspaceId);
    const rows: Array<typeof rowValidator.type> = [];
    let scanned = 0;
    for await (const row of paths.rows("", after)) {
      scanned += 1;
      if (row.goneAt === undefined && row.workspaceId === workspaceId) {
        const extra = row as Doc<"nodes"> & { collaborates?: boolean };
        rows.push({
          _id: String(row._id),
          path: row.path,
          kind: row.kind,
          ...(row.noteId === undefined ? {} : { noteId: row.noteId }),
          ...(row.storageKey === undefined ? {} : { storageKey: row.storageKey }),
          ...(row.etag === undefined ? {} : { etag: row.etag }),
          ...(row.size === undefined ? {} : { size: row.size }),
          ...(extra.collaborates === undefined ? {} : { collaborates: extra.collaborates }),
          ...(row.uploaded === undefined ? {} : { uploaded: row.uploaded }),
          ...(row.role === undefined ? {} : { role: row.role }),
          ...(row.order === undefined ? {} : { order: row.order }),
          ...(row.archiveOf === undefined ? {} : { archiveOf: row.archiveOf }),
        });
      }
      if (scanned >= ROWS_PER_PAGE) return { rows, next: row.path };
    }
    return { rows, next: null };
  },
});

/** One page of the workspaces that have storage, in id order. */
export const workspacesPage = internalQuery({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.object({ ids: v.array(v.id("workspaces")), cursor: v.string(), done: v.boolean() }),
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db.query("workspaces").paginate({ cursor: cursor ?? null, numItems: WORKSPACES_PER_PAGE });
    const ids: Id<"workspaces">[] = [];
    for (const workspace of page.page) {
      const binding = await ctx.db
        .query("storageBindings")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspace._id))
        .first();
      if (binding !== null) ids.push(workspace._id);
    }
    return { ids, cursor: page.continueCursor, done: page.isDone };
  },
});

/** The workspace a handle names, for a run on it alone; `null` for none. */
export const workspaceBySlug = internalQuery({
  args: { slug: v.string() },
  returns: v.union(v.id("workspaces"), v.null()),
  handler: async (ctx, { slug }) => {
    const workspace = await ctx.db
      .query("workspaces")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique();
    return workspace?._id ?? null;
  },
});

/** Every workspace at `home`. */
export const atHome = internalQuery({
  args: { home: homeValidator },
  returns: v.array(v.id("workspaces")),
  handler: async (ctx, { home }) =>
    (await ctx.db
      .query("workspaceObjectHomes")
      .withIndex("by_home", (q) => q.eq("home", home))
      .collect()).map((record) => record.workspaceId),
});

/** Sets the record's home. Only `workspaceObjects.setHome` calls it, after the object took the same home. */
export const recordHome = internalMutation({
  args: { workspaceId: v.id("workspaces"), home: homeValidator, now: v.number() },
  returns: v.null(),
  handler: async (ctx, { workspaceId, home, now }) => {
    const record = await recordOf(ctx.db, workspaceId);
    if (record === null) await ctx.db.insert("workspaceObjectHomes", { workspaceId, home, since: now });
    else if (record.home !== home) await ctx.db.patch(record._id, { home, since: now });
    return null;
  },
});

/** What a copy or a sync left: when, and the digest and rules version the object now holds. */
export const recordCopy = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    backfilledAt: v.optional(v.number()),
    rowsSha: v.optional(v.string()),
    rulesVersion: v.optional(v.number()),
    rowsSyncedAt: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, { workspaceId, ...fields }) => {
    const record = await recordOf(ctx.db, workspaceId);
    if (record === null) return null;
    const patch = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
    await ctx.db.patch(record._id, patch);
    return null;
  },
});

const bodiesValidator = v.object({
  bucketKeys: v.number(),
  objectKeys: v.number(),
  missingInObject: v.number(),
  extraInObject: v.number(),
  differ: v.number(),
});

export const parityValidator = v.object({
  at: v.number(),
  bodies: bodiesValidator,
  rows: v.object({ convex: v.number(), object: v.number(), match: v.boolean() }),
  rules: v.object({ match: v.boolean() }),
  visibility: v.object({ principals: v.number(), checked: v.number(), differ: v.number() }),
});

/** The last parity check's counts. */
export const recordParity = internalMutation({
  args: { workspaceId: v.id("workspaces"), parity: parityValidator },
  returns: v.null(),
  handler: async (ctx, { workspaceId, parity }) => {
    const record = await recordOf(ctx.db, workspaceId);
    if (record !== null) await ctx.db.patch(record._id, { parity });
    return null;
  },
});
