/**
 * Each person's feature flags, written into their person object so every session it answers carries them with no
 * call of its own (decided by the owner, 2026-11-08; `docs/decisions/app-and-console/feature-flags.md`). The object
 * keeps the set (`apps/mcp/src/workspaceStore/personFlags.js`); here is what decides it and when it is written.
 *
 * - **On every change** staff make in the Features tab (`functions/featureFlags.ts`), the people it touches are
 *   pushed at once: one person, a group's members, a flag's list, or everyone when a flag goes to or from
 *   `everyone`.
 * - **Every hour** the reconcile walks every person whose access their object decides and pushes only where the set
 *   moved since the last push (`flagsPushed` on their homes row): a push that failed, a person switched since, a new
 *   account and a flag launched or removed in code are all caught there.
 *
 * Ids only, never who else has a flag. A person not yet answered by their object gets their set from the control
 * plane's session instead (`controlPlane.resolveGatewaySession`).
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction, internalQuery, type ActionCtx } from "../_generated/server";
import { internalMutation } from "./lib/rowWatch/mutations";
import { consoleWorkspaceClient } from "./lib/workspaceObjects/door";
import { flagsFor } from "./lib/featureFlags";
import { personalWorkspaceOf } from "./textLinks";

/** People pushed per scheduled run, and homes rows read per reconcile page. */
export const PUSH_BATCH = 50;

/** What a person's object should hold: their personal workspace and their set, or null without one. */
export const flagSetFor = internalQuery({
  args: { userId: v.id("users") },
  returns: v.union(v.object({ workspaceId: v.id("workspaces"), flags: v.array(v.string()), pushed: v.union(v.string(), v.null()) }), v.null()),
  handler: async (ctx, { userId }) => {
    const workspaceId = await personalWorkspaceOf(ctx, userId);
    if (workspaceId === null) return null;
    const home = await ctx.db
      .query("workspaceObjectHomes")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique();
    return { workspaceId, flags: await flagsFor(ctx, userId), pushed: home?.flagsPushed ?? null };
  },
});

export const markFlagsPushed = internalMutation({
  args: { workspaceId: v.id("workspaces"), flags: v.string(), at: v.number() },
  returns: v.null(),
  handler: async (ctx, { workspaceId, flags, at }) => {
    const home = await ctx.db
      .query("workspaceObjectHomes")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique();
    if (home !== null && !(typeof home.flagsPushedAt === "number" && home.flagsPushedAt > at)) {
      await ctx.db.patch(home._id, { flagsPushed: flags, flagsPushedAt: at });
    }
    return null;
  },
});

type FlagsObject = { access: { flags: { put: (record: { flags: string[]; at: number }) => Promise<{ kept?: boolean }> } } };
export type OpenFlags = (ctx: ActionCtx, workspaceId: Id<"workspaces">) => FlagsObject | null;
const openFlags: OpenFlags = (ctx, workspaceId) => consoleWorkspaceClient(ctx, workspaceId) as unknown as FlagsObject | null;

/** Write one person's set into their object. `onlyIfMoved` skips a person whose last push already matches. */
export async function pushPersonFlags(ctx: ActionCtx, userId: Id<"users">, onlyIfMoved: boolean, open: OpenFlags = openFlags): Promise<"pushed" | "same" | "skipped"> {
  const want = await ctx.runQuery(internal.functions.flagObjects.flagSetFor, { userId });
  if (want === null) return "skipped";
  const joined = want.flags.join(",");
  if (onlyIfMoved && want.pushed === joined) return "same";
  const client = open(ctx, want.workspaceId);
  if (client === null) return "skipped";
  const at = Date.now();
  const answer = await client.access.flags.put({ flags: want.flags, at });
  if (answer?.kept !== true && answer?.kept !== false) throw new Error("the person object did not take the flags");
  await ctx.runMutation(internal.functions.flagObjects.markFlagsPushed, { workspaceId: want.workspaceId, flags: joined, at });
  return "pushed";
}

/** Push these people now, a batch per run. A failed push is left for the hourly reconcile, which retries it. */
export const pushPeople = internalAction({
  args: { userIds: v.array(v.id("users")) },
  returns: v.object({ pushed: v.number(), failed: v.number() }),
  handler: async (ctx, { userIds }): Promise<{ pushed: number; failed: number }> => {
    const now = userIds.slice(0, PUSH_BATCH);
    const later = userIds.slice(PUSH_BATCH);
    if (later.length > 0) await ctx.scheduler.runAfter(0, internal.functions.flagObjects.pushPeople, { userIds: later });
    let pushed = 0, failed = 0;
    for (const userId of now) {
      try {
        if ((await pushPersonFlags(ctx, userId, false)) === "pushed") pushed += 1;
      } catch {
        failed += 1;
      }
    }
    return { pushed, failed };
  },
});

/** One page of people whose access their object decides. */
export const switchedPeople = internalQuery({
  args: { after: v.union(v.string(), v.null()), limit: v.number() },
  returns: v.object({ userIds: v.array(v.id("users")), next: v.union(v.string(), v.null()) }),
  handler: async (ctx, { after, limit }) => {
    const page = await ctx.db
      .query("workspaceObjectHomes")
      .withIndex("by_person_access", (q) => q.eq("personAccess", "object"))
      .paginate({ cursor: after, numItems: Math.max(1, Math.min(limit, 100)) });
    const userIds: Id<"users">[] = [];
    for (const row of page.page) {
      const workspace = await ctx.db.get(row.workspaceId);
      if (workspace?.kind === "personal" && workspace.createdBy !== undefined) userIds.push(workspace.createdBy);
    }
    return { userIds, next: page.isDone ? null : page.continueCursor };
  },
});

/**
 * Walk every switched person and push where the set moved (`onlyIfMoved`), or push everyone (`all`, when a flag
 * goes to or from everyone). Pages schedule the next; safe to repeat.
 */
export const reconcile = internalAction({
  args: { after: v.optional(v.union(v.string(), v.null())), all: v.optional(v.boolean()) },
  returns: v.object({ pushed: v.number(), same: v.number(), failed: v.number(), next: v.union(v.string(), v.null()) }),
  handler: async (ctx, { after = null, all = false }): Promise<{ pushed: number; same: number; failed: number; next: string | null }> => {
    const { userIds, next }: { userIds: Id<"users">[]; next: string | null } = await ctx.runQuery(internal.functions.flagObjects.switchedPeople, { after, limit: PUSH_BATCH });
    let pushed = 0, same = 0, failed = 0;
    for (const userId of userIds) {
      try {
        const result = await pushPersonFlags(ctx, userId, !all);
        if (result === "pushed") pushed += 1;
        else if (result === "same") same += 1;
      } catch {
        failed += 1;
      }
    }
    if (next !== null) await ctx.scheduler.runAfter(0, internal.functions.flagObjects.reconcile, { after: next, all });
    return { pushed, same, failed, next };
  },
});
