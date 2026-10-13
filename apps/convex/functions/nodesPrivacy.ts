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
import { internalMutation, internalQuery } from "../_generated/server";
import {
  EXPORT_RETRY_MS,
  heldRules,
  isAuthority,
  newRulesVersion,
  privacyAuthorityOn,
  privacyRowOf as rowOf,
  scheduleExport,
} from "./lib/nodes/privacyAuthority";
import { privacyIsNewer } from "./lib/nodes/observe";
import { leasedGatewayJobWorkspace } from "./lib/controlPlane/gatewayJobs";

const folders = v.array(v.object({ prefix: v.string(), visibility: v.string() }));
const notes = v.array(v.object({ path: v.string(), visibility: v.string() }));
const heldValidator = v.object({ etag: v.string(), folders, notes });

/** The rules, while they are this workspace's authority; `null` while `privacy.md` is. */
export const authority = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.union(v.null(), heldValidator),
  handler: async (ctx, { workspaceId }) => {
    const row = await ctx.db
      .query("nodePrivacy")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique();
    return isAuthority(row, await privacyAuthorityOn(ctx.db)) ? heldRules(row) : null;
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
    if (args.expected !== null && args.expected !== row.etag) return { current: heldRules(row) };
    const now = Date.now();
    const etag = newRulesVersion(now, Math.random);
    await ctx.db.patch(row._id, {
      etag,
      folders: args.folders,
      notes: args.notes,
      observedAt: now,
      exportOwed: true,
    });
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
    const rules = { etag: args.etag, invalid: false, folders: args.folders, notes: args.notes, exportedEtag: args.etag };
    if (isAuthority(row, await privacyAuthorityOn(ctx.db))) {
      if (args.previous !== null && args.previous === row.etag) {
        await ctx.db.patch(row._id, { ...rules, observedAt: args.at, exportOwed: false });
      } else if (!row.exportOwed) {
        await ctx.db.patch(row._id, { exportOwed: true });
        await scheduleExport(ctx, args.workspaceId, 0);
      }
      return null;
    }
    if (row === null) {
      await ctx.db.insert("nodePrivacy", { workspaceId: args.workspaceId, ...rules, observedAt: args.at });
    } else if (privacyIsNewer(row.observedAt, args.at)) {
      await ctx.db.patch(row._id, { ...rules, observedAt: args.at });
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
