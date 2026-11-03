/**
 * Convex written behind a workspace object's access write (`apps/mcp/src/workspaceStore/accessWrite.js`, the change
 * `{op: "access", record, objectAt}` the gateway sends through `POST /gateway/rows/mirror`,
 * `functions/lib/gatewayRoutes/rowsMirror.ts`, which calls `access` here).
 *
 * The object has already decided the change: its own rows and grant rows, its version, its rules. This applies the
 * same change to Convex's row the way `setAccessRow` (`functions/lib/nodes/setAccess.ts`) would, with the object's
 * grantees, and sets the row's `objectAt` on the object's clock, never backwards. No check of who may change what is
 * made again: the route holds the gateway secret, and the object checked before it wrote.
 *
 * Versions. The object's version is what it held when it decided (`record.baseVersion`) and the one it minted
 * (`record.version`). Convex's `nodeAccessState.version` is the one it held before this write (`heldVersion`):
 * - equal to `baseVersion`: Convex had nothing the object did not see, so the version becomes `record.version`
 *   (or one above what Convex held, if that is higher);
 * - otherwise Convex took its own access change the object has not seen. The version goes one above the object's
 *   (`record.version + 1`), and an access push is scheduled so the object takes the workspace's access as Convex now
 *   holds it, at a version above its own.
 *
 * A change that names nothing Convex can hold answers `applied: false` with a reason and writes nothing:
 * `no_row` (no live row with that id in this workspace), `bad_grantee` (a user or group id that does not name a
 * real one here, an email that does not normalize, `accounts` outside the pinned workspace or at an edit role),
 * `bad_actor` (an actor id that names no user), and `bad_record` (more grantees than a list may hold).
 *
 * Built with `internalMutationMirrored`: the write is not opened as an outbox entry, so the object is not told its own
 * change back. The one outbox entry this writes is the deliberate push above, and only for the version case.
 */

import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internalMutationMirrored, flushRowChanges } from "./lib/rowWatch/mutations";
import type { WorkspaceChange } from "./lib/rowWatch/watch";
import { nodeByObjectId } from "./lib/nodes/objectIds";
import { MAX_GRANTEES, writeRowAccess, wantedOf, type GranteeInput } from "./lib/nodes/setAccess";
import { livePending, PENDING_MAX } from "./lib/nodes/pendingAccess";
import { liveNodeAt } from "./lib/nodes/paths";
import { removeUserGrantsIn } from "./lib/grants/removeUserGrants";

export const accessGranteeValidator = v.object({
  kind: v.union(v.literal("user"), v.literal("group"), v.literal("email"), v.literal("members"), v.literal("accounts")),
  /** A user or group id as text; an email; or `members` / `accounts` for those kinds. */
  id: v.string(),
  role: v.union(v.literal("view"), v.literal("edit")),
});

export const accessRecordValidator = v.object({
  rowId: v.string(),
  noteId: v.union(v.string(), v.null()),
  path: v.string(),
  kind: v.union(v.literal("file"), v.literal("folder")),
  /** `null` is inherit: the row takes no base of its own. */
  base: v.union(v.literal("private"), v.literal("team"), v.null()),
  grantees: v.array(accessGranteeValidator),
  /** Whether the object changed the base, and what it changed in the list, against what it held. */
  baseChanged: v.boolean(),
  listChanged: v.boolean(),
  added: v.array(accessGranteeValidator),
  removed: v.array(accessGranteeValidator),
  baseVersion: v.number(),
  version: v.number(),
  /** Whether the change may hide something (`accessWrite.js`): the object answered it without waiting for this. */
  narrowing: v.optional(v.boolean()),
  actorUserId: v.optional(v.string()),
  clientId: v.optional(v.string()),
});

export type MirrorAccessAnswer = { applied: true } | { applied: false; reason: string };

const answerValidator = v.union(v.object({ applied: v.literal(true) }), v.object({ applied: v.literal(false), reason: v.string() }));

const refused = (reason: string): MirrorAccessAnswer => ({ applied: false, reason });

export const access = internalMutationMirrored({
  args: { workspaceId: v.id("workspaces"), objectAt: v.number(), record: accessRecordValidator },
  returns: answerValidator,
  handler: async (ctx, { workspaceId, objectAt, record }): Promise<MirrorAccessAnswer> => {
    const row = await liveRow(ctx, workspaceId, record.rowId);
    if (row === null) return refused("no_row");
    if (record.grantees.length > MAX_GRANTEES) return refused("bad_record");
    // Everything that can refuse is decided before the first write: a refused change writes nothing.
    const actorUserId = record.actorUserId === undefined ? undefined : ctx.db.normalizeId("users", record.actorUserId) ?? undefined;
    if (record.actorUserId !== undefined && actorUserId === undefined) return refused("bad_actor");
    const grants = await ctx.db
      .query("nodeAccess")
      .withIndex("by_node", (q) => q.eq("nodeId", row._id))
      .collect();
    // The object's change applied onto the row as Convex holds it now, not the object's whole list: a grant Convex
    // took or took back since the object last heard (a writer not on the object yet) stays as Convex has it, unless the
    // object changed that same grantee. With nothing missed this is the object's list exactly.
    let wanted: Awaited<ReturnType<typeof wantedOf>> = [];
    if (record.listChanged) {
      const merged = new Map<string, { kind: string; id: string; role: "view" | "edit" }>();
      for (const grant of grants) {
        if (grant.source === "share" || grant.source === "privacy.md") continue;
        const held = granteeOfGrant(grant);
        if (held !== null) merged.set(keyOf(held), held);
      }
      for (const grantee of record.removed) merged.delete(keyOf(grantee));
      for (const grantee of record.added) merged.set(keyOf(grantee), grantee);
      if (merged.size > MAX_GRANTEES) return refused("bad_record");
      const asked = granteesOf(ctx, [...merged.values()]);
      if (asked === null) return refused("bad_grantee");
      wanted = await wantedOf(ctx, workspaceId, asked);
      if (wanted === null) return refused("bad_grantee");
    }

    const state = await ctx.db
      .query("nodeAccessState")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique();
    // What Convex held before this write: the version the object's `baseVersion` is judged against.
    const heldVersion = state?.version ?? 0;
    await writeRowAccess(ctx, {
      workspaceId,
      path: row.path,
      row,
      state,
      base: record.baseChanged ? (record.base ?? undefined) : row.access?.base,
      grants,
      // A list the object changed replaces the owner's with the merge above; an unchanged one is kept as Convex has it.
      replaces: record.listChanged,
      wanted,
      actorUserId,
      actorClientId: record.clientId,
    });

    await settleVersion(ctx, workspaceId, heldVersion, record);

    // The row takes the object's clock, as `objectRowsMirror.wrote` does for a note write: never backwards.
    const current = await ctx.db.get(row._id);
    const next = Math.max(current?.objectAt ?? 0, objectAt);
    if (current !== null && next !== current.objectAt) await ctx.db.patch(row._id, { objectAt: next });
    return { applied: true };
  },
});

export const pendingRecordValidator = v.object({
  path: v.string(),
  kind: v.union(v.literal("file"), v.literal("folder")),
  /** `null` is inherit: a waiting entry at the path is dropped. */
  base: v.union(v.literal("private"), v.literal("team"), v.null()),
  baseVersion: v.number(),
  version: v.number(),
  narrowing: v.optional(v.boolean()),
  actorUserId: v.optional(v.string()),
  clientId: v.optional(v.string()),
});

/**
 * A base the object kept for a path with no row yet (`accessWrite.js` `writePending`), kept here the same way
 * (`lib/nodes/setAccess.ts` `setPendingAccess`): Convex renders the private entry for its own readers, and gives the
 * row that access when it is born at the path (`applyPendingAccess`, which the object's `adopt` mirror reaches through
 * the row's insert). A row Convex already holds at the path takes the base as its own instead. Versions as `access`.
 */
export const pending = internalMutationMirrored({
  args: { workspaceId: v.id("workspaces"), objectAt: v.number(), record: pendingRecordValidator },
  returns: answerValidator,
  handler: async (ctx, { workspaceId, record }): Promise<MirrorAccessAnswer> => {
    const actorUserId = record.actorUserId === undefined ? undefined : ctx.db.normalizeId("users", record.actorUserId) ?? undefined;
    if (record.actorUserId !== undefined && actorUserId === undefined) return refused("bad_actor");
    const state = await ctx.db
      .query("nodeAccessState")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique();
    const heldVersion = state?.version ?? 0;
    const row = await liveNodeAt(ctx.db, workspaceId, record.path);
    if (row !== null && row.kind === record.kind) {
      const grants = await ctx.db
        .query("nodeAccess")
        .withIndex("by_node", (q) => q.eq("nodeId", row._id))
        .collect();
      await writeRowAccess(ctx, {
        workspaceId,
        path: row.path,
        row,
        state,
        base: record.base ?? undefined,
        grants,
        replaces: false,
        wanted: [],
        actorUserId,
        actorClientId: record.clientId,
      });
    } else {
      const now = Date.now();
      const waiting = livePending(state?.pending, now).filter((entry) => entry.path !== record.path);
      if (record.base !== null && waiting.length >= PENDING_MAX) return refused("pending_full");
      const next = record.base === null ? waiting : [...waiting, { path: record.path, kind: record.kind, base: record.base, at: now }];
      if (state === null) await ctx.db.insert("nodeAccessState", { workspaceId, version: heldVersion, orphans: [], pending: next });
      else await ctx.db.patch(state._id, { pending: next });
    }
    await settleVersion(ctx, workspaceId, heldVersion, record);
    return { applied: true };
  },
});

/**
 * One account's own grants taken out of the workspace by the object (`accessDrop.js`), taken out here the same way
 * (`lib/grants/removeUserGrants.ts` `removeUserGrantsIn`: every `user` grant it holds here, audited once). Versions as
 * `access`. `bad_grantee` / `bad_actor` for an id that names no user.
 */
export const dropGrantee = internalMutationMirrored({
  args: {
    workspaceId: v.id("workspaces"),
    objectAt: v.number(),
    record: v.object({
      kind: v.literal("user"),
      id: v.string(),
      actorUserId: v.string(),
      baseVersion: v.number(),
      version: v.number(),
      dropped: v.optional(v.number()),
    }),
  },
  returns: answerValidator,
  handler: async (ctx, { workspaceId, record }): Promise<MirrorAccessAnswer> => {
    const userId = ctx.db.normalizeId("users", record.id);
    if (userId === null) return refused("bad_grantee");
    const actorUserId = ctx.db.normalizeId("users", record.actorUserId);
    if (actorUserId === null) return refused("bad_actor");
    const state = await ctx.db
      .query("nodeAccessState")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique();
    const heldVersion = state?.version ?? 0;
    await removeUserGrantsIn(ctx, { workspaceId, userId, actorUserId });
    await settleVersion(ctx, workspaceId, heldVersion, record);
    return { applied: true };
  },
});

/**
 * Convex's access version after a mirrored change: the object's when Convex had nothing the object did not see, else one
 * above it, with an access push so the object takes the access as Convex now holds it.
 */
async function settleVersion(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  heldVersion: number,
  record: { baseVersion: number; version: number },
): Promise<void> {
  const fresh = await ctx.db
    .query("nodeAccessState")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
  if (fresh === null) return;
  const sawSame = heldVersion === record.baseVersion;
  const version = sawSame ? Math.max(heldVersion + 1, record.version) : Math.max(heldVersion + 1, record.version + 1);
  if (fresh.version !== version) await ctx.db.patch(fresh._id, { version });
  if (!sawSame) {
    // Convex's own access change is not in the object: an access push sends the object the set as Convex now holds it.
    const push: WorkspaceChange = { nodeIds: new Set(), access: true, narrows: false, binding: false, born: new Set(), bornPaths: new Set(), goneObjectIds: new Set() };
    await flushRowChanges(ctx, new Map([[workspaceId, push]]), "objectAccessMirror");
  }
}

/** The live row the object calls `rowId` in this workspace, or `null`: a row of another workspace or a gone one is no row here. */
async function liveRow(ctx: MutationCtx, workspaceId: Id<"workspaces">, rowId: string): Promise<Doc<"nodes"> | null> {
  // By the object's id: a row Convex made by its `_id`, one the object made by `objectId` (`lib/nodes/objectIds.ts`).
  const row = await nodeByObjectId(ctx.db, workspaceId, rowId);
  return row === null || row.goneAt !== undefined ? null : row;
}

/**
 * The object's grantees as the grantee inputs `wantedOf` takes. A user or group id that does not normalize is `null`
 * (`bad_grantee`); an email is passed on for `wantedOf` to normalize.
 */
function granteesOf(ctx: MutationCtx, grantees: ReadonlyArray<{ kind: string; id: string; role: "view" | "edit" }>): GranteeInput[] | null {
  const out: GranteeInput[] = [];
  for (const grantee of grantees) {
    if (grantee.kind === "user") {
      const userId = ctx.db.normalizeId("users", grantee.id);
      if (userId === null) return null;
      out.push({ kind: "user", userId, role: grantee.role });
    } else if (grantee.kind === "group") {
      const groupId = ctx.db.normalizeId("workspaceGroups", grantee.id);
      if (groupId === null) return null;
      out.push({ kind: "group", groupId, role: grantee.role });
    } else if (grantee.kind === "email") {
      out.push({ kind: "email", email: grantee.id, role: grantee.role });
    } else {
      out.push({ kind: grantee.kind as "members" | "accounts", role: grantee.role });
    }
  }
  return out;
}

const keyOf = (grantee: { kind: string; id: string }) => `${grantee.kind}:${grantee.kind === "email" ? grantee.id.trim().toLowerCase() : grantee.id}`;

/** A Convex grant in the object's `{kind, id, role}` shape, or `null` for one with no grantee. */
function granteeOfGrant(grant: Doc<"nodeAccess">): { kind: string; id: string; role: "view" | "edit" } | null {
  if (grant.granteeKind === "user" && grant.granteeUserId !== undefined) return { kind: "user", id: grant.granteeUserId, role: grant.role };
  if (grant.granteeKind === "group" && grant.granteeGroupId !== undefined) return { kind: "group", id: grant.granteeGroupId, role: grant.role };
  if (grant.granteeKind === "email" && grant.granteeEmail !== undefined) return { kind: "email", id: grant.granteeEmail, role: grant.role };
  if (grant.granteeKind === "members" || grant.granteeKind === "accounts") return { kind: grant.granteeKind, id: grant.granteeKind, role: grant.role };
  return null;
}
