/**
 * Convex's side of copying access into the objects, and the record of where
 * each workspace's access is read from (decided by the owner, 2026-11-01, plan
 * "Access lives in the objects"). The actions that reach the objects are
 * `accessObjects.ts`; these read the control plane's tables and write only the
 * record, on `workspaceObjectHomes` beside the notes switch (one record per
 * workspace, never a second table):
 *
 * - `access`: the workspace's members and invites.
 * - `personAccess`: a personal workspace's person (reach, "shared with me",
 *   connections), which its object also holds.
 *
 * Each is `convex` (absent), `dual` (Convex decides, changes are mirrored) or
 * `object` (the object decides).
 */

import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalQuery, type DatabaseReader } from "../_generated/server";
import { internalMutation } from "./lib/rowWatch/mutations";
import { accessHomeOf } from "./lib/accessObjects/home";

export const accessValidator = v.union(v.literal("convex"), v.literal("dual"), v.literal("object"));
export const scopeValidator = v.union(v.literal("workspace"), v.literal("person"));
export type AccessHome = "convex" | "dual" | "object";

/** Workspaces per page of a run. */
const WORKSPACES_PER_PAGE = 25;

const tableParityValidator = v.object({ table: v.string(), convex: v.number(), object: v.number(), match: v.boolean() });
export const accessParityValidator = v.object({ at: v.number(), tables: v.array(tableParityValidator) });

async function recordOf(db: DatabaseReader, workspaceId: Id<"workspaces">): Promise<Doc<"workspaceObjectHomes"> | null> {
  return await db
    .query("workspaceObjectHomes")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
}

/** The fields of the record one scope uses. */
const FIELDS = {
  workspace: { home: "access", since: "accessSince", backfilledAt: "accessBackfilledAt", parity: "accessParity" },
  person: { home: "personAccess", since: "personAccessSince", backfilledAt: "personBackfilledAt", parity: "personParity" },
} as const;

/** Where `workspaceId`'s access is read from, for one scope (`lib/accessObjects/home.ts`). */
export const accessOf = internalQuery({
  args: { workspaceId: v.id("workspaces"), scope: scopeValidator },
  returns: accessValidator,
  handler: async (ctx, { workspaceId, scope }) => await accessHomeOf(ctx.db, workspaceId, scope),
});

/** One scope's switch, last copy and last parity check for `workspaceId`; no record is `convex`. */
export const accessRecordFor = internalQuery({
  args: { workspaceId: v.id("workspaces"), scope: scopeValidator },
  returns: v.object({ home: accessValidator, backfilledAt: v.optional(v.number()), parity: v.optional(accessParityValidator) }),
  handler: async (ctx, { workspaceId, scope }) => {
    const record = await recordOf(ctx.db, workspaceId);
    const fields = FIELDS[scope];
    const home = (record?.[fields.home] ?? "convex") as AccessHome;
    const backfilledAt = record?.[fields.backfilledAt];
    const parity = record?.[fields.parity];
    return { home, ...(backfilledAt === undefined ? {} : { backfilledAt }), ...(parity === undefined ? {} : { parity }) };
  },
});

/** One page of every workspace, in id order. */
export const workspacesPage = internalQuery({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.object({ ids: v.array(v.id("workspaces")), cursor: v.string(), done: v.boolean() }),
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db.query("workspaces").paginate({ cursor: cursor ?? null, numItems: WORKSPACES_PER_PAGE });
    return { ids: page.page.map((workspace) => workspace._id), cursor: page.continueCursor, done: page.isDone };
  },
});

/**
 * Whether `workspaceId` is a personal workspace, and its person (its one owner
 * member), whose reach, connections and "shared with me" its object holds.
 * `null` for a workspace that is gone.
 */
export const workspaceFacts = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.union(v.null(), v.object({ personal: v.boolean(), personId: v.union(v.id("users"), v.null()) })),
  handler: async (ctx, { workspaceId }) => {
    const workspace = await ctx.db.get(workspaceId);
    if (workspace === null) return null;
    if (workspace.kind !== "personal") return { personal: false, personId: null };
    const owners = (
      await ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .take(10)
    ).filter((member) => member.role === "owner");
    // A personal workspace has exactly one owner; anything else is not copied as a person.
    return { personal: true, personId: owners.length === 1 ? owners[0]!.userId : null };
  },
});

/** Sets one scope's switch. Only `accessObjects.setAccess` calls it, after the object took the same switch. */
export const recordAccess = internalMutation({
  args: { workspaceId: v.id("workspaces"), scope: scopeValidator, home: accessValidator, now: v.number() },
  returns: v.null(),
  handler: async (ctx, { workspaceId, scope, home, now }) => {
    const fields = FIELDS[scope];
    const record = await recordOf(ctx.db, workspaceId);
    if (record === null) await ctx.db.insert("workspaceObjectHomes", { workspaceId, home: "bucket", since: now, [fields.home]: home, [fields.since]: now });
    else if ((record[fields.home] ?? "convex") !== home) await ctx.db.patch(record._id, { [fields.home]: home, [fields.since]: now });
    return null;
  },
});

/** When one scope's tables were last copied whole. */
export const recordAccessCopy = internalMutation({
  args: { workspaceId: v.id("workspaces"), scope: scopeValidator, at: v.number() },
  returns: v.null(),
  handler: async (ctx, { workspaceId, scope, at }) => {
    const record = await recordOf(ctx.db, workspaceId);
    if (record !== null) await ctx.db.patch(record._id, { [FIELDS[scope].backfilledAt]: at });
    return null;
  },
});

/** One scope's last parity check. */
export const recordAccessParity = internalMutation({
  args: { workspaceId: v.id("workspaces"), scope: scopeValidator, parity: accessParityValidator },
  returns: v.null(),
  handler: async (ctx, { workspaceId, scope, parity }) => {
    const record = await recordOf(ctx.db, workspaceId);
    if (record !== null) await ctx.db.patch(record._id, { [FIELDS[scope].parity]: parity });
    return null;
  },
});
