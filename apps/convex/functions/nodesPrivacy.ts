/**
 * A workspace's privacy rules as the authority, and `privacy.md` as their
 * export (phase 3 of `docs/decisions/app-and-console/convex-tree.md`; the
 * rules are `lib/nodes/privacyAuthority.ts`).
 *
 * Internal only. The console reaches these through the credential barrier,
 * which wraps the store it opens (`apps/mcp/src/store/privacyAuthority.js`),
 * and the gateway through `/gateway/privacy`, which checks the person's token
 * first. Nothing here takes a rule from a client directly: a rule only ever
 * arrives as the text of a `privacy.md` the privacy code itself rendered.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type QueryCtx } from "../_generated/server";
import {
  EXPORT_RETRY_MS,
  heldRules,
  type HeldRules,
  isAuthority,
  newRulesVersion,
  privacyAuthorityOn,
  privacyRowOf as rowOf,
  scheduleExport,
} from "./lib/nodes/privacyAuthority";
import { privacyIsNewer } from "./lib/nodes/observe";
import { leasedGatewayJobWorkspace } from "./lib/controlPlane/gatewayJobs";
import { accessDerived, accessSourceOf, backfillAccess, deriveAccessPage, refreshAccess } from "./lib/nodes/accessBackfill";
import { accessVersionOf } from "./lib/nodes/accessRows";
import { accessParityPage } from "./lib/nodes/accessParity";
import { rulesForReaders } from "./lib/nodes/readerRules";

const folders = v.array(v.object({ prefix: v.string(), visibility: v.string() }));
const notes = v.array(v.object({ path: v.string(), visibility: v.string() }));
const heldValidator = v.object({ etag: v.string(), folders, notes, accessVersion: v.optional(v.number()) });

/**
 * The rules as the gateway holds them. While rows judge (`accessSource` = `rows`) they are the rules the rows
 * render for a member (`rulesForReaders`), with the rows' version beside the `privacy.md` etag the gateway
 * compares writes by. Otherwise they are the stored rules, exactly as before the switch.
 */
async function heldFor(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  row: Doc<"nodePrivacy"> & { etag: string },
): Promise<HeldRules & { accessVersion?: number }> {
  if ((await accessSourceOf(ctx.db)) !== "rows") return heldRules(row);
  const rendered = await rulesForReaders(ctx, workspaceId);
  return {
    etag: row.etag,
    folders: rendered.rules.map((rule) => ({ prefix: rule.prefix, visibility: rule.vis })),
    notes: [...rendered.overrides].map(([path, visibility]) => ({ path, visibility })),
    accessVersion: await accessVersionOf(ctx, workspaceId),
  };
}

/** The rules, while they are this workspace's authority; `null` while `privacy.md` is. */
export const authority = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.union(v.null(), heldValidator),
  handler: async (ctx, { workspaceId }) => {
    const row = await ctx.db
      .query("nodePrivacy")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique();
    return isAuthority(row, await privacyAuthorityOn(ctx.db)) ? await heldFor(ctx, workspaceId, row) : null;
  },
});

/** The rules Convex readers judge by (`lib/nodes/readerRules.ts`), as plain values a query can return. */
export const readerRules = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({
    rules: v.array(v.object({ prefix: v.string(), vis: v.string() })),
    overrides: v.array(v.object({ path: v.string(), vis: v.string() })),
  }),
  handler: async (ctx, { workspaceId }) => {
    const held = await rulesForReaders(ctx, workspaceId);
    return {
      rules: held.rules.map((rule) => ({ prefix: rule.prefix, vis: rule.vis })),
      overrides: [...held.overrides].map(([path, vis]) => ({ path, vis })),
    };
  },
});

/** Whether this workspace's file is still to be written from its rules: the export job's first question. */
export const exportOwedNow = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.boolean(),
  handler: async (ctx, { workspaceId }) => {
    const row = await ctx.db
      .query("nodePrivacy")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique();
    return row?.exportOwed === true && isAuthority(row, await privacyAuthorityOn(ctx.db));
  },
});

/** The workspace a queued move's ticket proves, while its lease holds (`/gateway/privacy`). */
export const jobWorkspace = internalQuery({
  args: { hashedTicket: v.string() },
  returns: v.union(v.null(), v.id("workspaces")),
  handler: async (ctx, { hashedTicket }) => await leasedGatewayJobWorkspace(ctx, hashedTicket),
});

/**
 * Change the rules, from the version `expected` names (`null`: whatever is
 * held). Answers the new version, or, when `expected` is not the one held,
 * the rules that are (`current`): the store reports a failed precondition, and
 * the caller's next read sees them, as it would against a bucket. `null` while
 * the file is the authority.
 */
export const write = internalMutation({
  args: { workspaceId: v.id("workspaces"), expected: v.union(v.null(), v.string()), folders, notes },
  returns: v.union(v.null(), v.object({ etag: v.string() }), v.object({ current: heldValidator })),
  handler: async (ctx, args) => {
    const row = await rowOf(ctx, args.workspaceId);
    if (!isAuthority(row, await privacyAuthorityOn(ctx.db))) return null;
    if (args.expected !== null && args.expected !== row.etag) {
      return { current: await heldFor(ctx, args.workspaceId, row) };
    }
    const now = Date.now();
    const etag = newRulesVersion(now, Math.random);
    await ctx.db.patch(row._id, {
      etag,
      folders: args.folders,
      notes: args.notes,
      observedAt: now,
      exportOwed: true,
    });
    await refreshAccess(ctx, args.workspaceId);
    // The writer exports at once. This is the net under it, should the
    // writer stop between the two: it does nothing once the export settled.
    await scheduleExport(ctx, args.workspaceId, EXPORT_RETRY_MS);
    return { etag };
  },
});

/**
 * The bucket's `privacy.md` was written, from version `previous` to `etag`,
 * while the file is the authority (or was, when the write began).
 *
 * While the file is the authority this is an early observation of it. Once
 * the rules are, it counts only as the direct successor of the version held:
 * that is a write begun just before staff turned the authority on, and it is
 * kept rather than lost. Anything else is a file written past the rules, and
 * the export puts the rules back over it.
 */
export const written = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    previous: v.union(v.null(), v.string()),
    etag: v.string(),
    folders,
    notes,
    at: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const row = await rowOf(ctx, args.workspaceId);
    const rules = { etag: args.etag, invalid: false, folders: args.folders, notes: args.notes };
    if (isAuthority(row, await privacyAuthorityOn(ctx.db))) {
      if (args.previous !== null && args.previous === row.etag) {
        // Kept as the held version's successor: from here the rules are ours.
        await ctx.db.patch(row._id, { ...rules, exportedEtag: args.etag, observedAt: args.at, exportOwed: false });
        await refreshAccess(ctx, args.workspaceId);
      } else if (!row.exportOwed) {
        await ctx.db.patch(row._id, { exportOwed: true });
        await scheduleExport(ctx, args.workspaceId, 0);
      }
      return null;
    }
    // While the file is the authority this is a copy of it, like any read:
    // nothing marks it as decided here (`rulesAuthoredHere`), so an edit to
    // the file made before the flip and not yet read is never written over.
    if (row === null) {
      await ctx.db.insert("nodePrivacy", { workspaceId: args.workspaceId, ...rules, observedAt: args.at });
      await refreshAccess(ctx, args.workspaceId);
    } else if (privacyIsNewer(row.observedAt, args.at)) {
      await ctx.db.patch(row._id, { ...rules, exportedEtag: undefined, observedAt: args.at });
      await refreshAccess(ctx, args.workspaceId);
    }
    return null;
  },
});

/**
 * The bucket's `privacy.md` was written from the rules at version `rendered`.
 * Settled only if those are still the rules held: a later change owes its own
 * export, and an export that landed late is written over again.
 */
export const exported = internalMutation({
  args: { workspaceId: v.id("workspaces"), rendered: v.string(), etag: v.union(v.null(), v.string()) },
  returns: v.null(),
  handler: async (ctx, { workspaceId, rendered, etag }): Promise<null> => {
    const row = await rowOf(ctx, workspaceId);
    if (row === null) return null;
    if (row.etag === rendered) {
      await ctx.db.patch(row._id, { exportOwed: false, ...(etag === null ? {} : { exportedEtag: etag }) });
      return null;
    }
    if (isAuthority(row, await privacyAuthorityOn(ctx.db))) {
      await ctx.db.patch(row._id, { exportOwed: true });
      await scheduleExport(ctx, workspaceId, 0);
    }
    return null;
  },
});

/** The export did not happen (a bucket that refused, or a removed file): try again in a minute. */
export const owed = internalMutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.null(),
  handler: async (ctx, { workspaceId }): Promise<null> => {
    const row = await rowOf(ctx, workspaceId);
    if (!isAuthority(row, await privacyAuthorityOn(ctx.db))) return null;
    await ctx.db.patch(row._id, { exportOwed: true });
    await scheduleExport(ctx, workspaceId, EXPORT_RETRY_MS);
    return null;
  },
});

/**
 * One page of the access derivation for a large tree (`lib/nodes/accessBackfill.ts`),
 * scheduled by the dual write when the tree is too big to walk in its own
 * transaction. Each page schedules the next until the walk is done.
 */
export const backfillAccessPage = internalMutation({
  args: { workspaceId: v.id("workspaces"), after: v.union(v.null(), v.string()), pageSize: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, { workspaceId, after, pageSize }): Promise<null> => {
    const step = await deriveAccessPage(ctx, workspaceId, { after, pageSize });
    if (!step.done) {
      await ctx.scheduler.runAfter(0, internal.functions.nodesPrivacy.backfillAccessPage, {
        workspaceId,
        after: step.next,
        pageSize,
      });
    }
    return null;
  },
});

/**
 * Staff's switch for access rows (`nodeMigration.accessSource`, the deployment's one switch). `file` derives
 * nothing; `shadow` and `rows` derive on every rules write and move, and backfill the workspace now. The
 * workspace argument scopes the backfill only: other workspaces derive when they next write or move.
 */
export const setAccessSource = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    source: v.union(v.literal("file"), v.literal("shadow"), v.literal("rows")),
  },
  returns: v.null(),
  handler: async (ctx, { workspaceId, source }): Promise<null> => {
    const row = await ctx.db.query("nodeMigration").first();
    const fields = { accessSource: source, updatedAt: Date.now() };
    if (row === null) await ctx.db.insert("nodeMigration", { paused: false, ...fields });
    else await ctx.db.patch(row._id, fields);
    if (accessDerived(source)) await backfillAccess(ctx, workspaceId);
    return null;
  },
});

/**
 * Shadow parity (`lib/nodes/accessParity.ts`): one page of every live row's answer from the rules against
 * its answer from the access rows, under each clearance. Staff reads it; a diff is a derivation bug.
 */
export const accessParity = internalQuery({
  args: { workspaceId: v.id("workspaces"), cursor: v.optional(v.string()) },
  returns: v.object({
    diffs: v.array(v.object({ path: v.string(), clearance: v.string(), old: v.boolean(), new: v.boolean() })),
    next: v.union(v.null(), v.string()),
    checked: v.number(),
  }),
  handler: async (ctx, { workspaceId, cursor }) => await accessParityPage(ctx, workspaceId, cursor ?? null),
});

/** How many times a new workspace's rows are looked for, and how far apart: rows come with the first tree listing. */
const SCAFFOLD_DERIVE_TRIES = 40;
const SCAFFOLD_DERIVE_RETRY_MS = 15_000;

/**
 * A new context's folders take the defaults its scaffolded `privacy.md` gives them, once its rows exist (scheduled
 * by `lib/scaffold/step.ts` in rows mode). Rows mode derives nothing on its own, so this is the one derivation,
 * and only while the workspace has no access state: once it has one, the rows are the owner's and are not touched.
 * INTERNAL.
 */
export const deriveNewWorkspaceRows = internalMutation({
  args: { workspaceId: v.id("workspaces"), attempt: v.number() },
  returns: v.null(),
  handler: async (ctx, { workspaceId, attempt }): Promise<null> => {
    if ((await accessSourceOf(ctx.db)) !== "rows") return null;
    const state = await ctx.db
      .query("nodeAccessState")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique();
    if (state !== null) return null;
    const anyRow = await ctx.db
      .query("nodes")
      .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId))
      .first();
    if (anyRow === null) {
      if (attempt < SCAFFOLD_DERIVE_TRIES) {
        await ctx.scheduler.runAfter(SCAFFOLD_DERIVE_RETRY_MS, internal.functions.nodesPrivacy.deriveNewWorkspaceRows, {
          workspaceId,
          attempt: attempt + 1,
        });
      }
      return null;
    }
    await backfillAccess(ctx, workspaceId);
    return null;
  },
});
