/**
 * Deletions, dropped-domain leaves and folds run objects first (`lib/accessHandOff/takeAway.ts` and `fold.ts` have the why).
 * `run` takes one queued deletion: it removes the members and invites and
 * revokes the connections in each object the deletion touches, then deletes
 * Convex's rows behind them in one transaction (`finish`). An object that does
 * not answer is retried with backoff; the deletion stays queued, and is never
 * finished in Convex before the objects took it.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction, internalQuery, type ActionCtx } from "../_generated/server";
import { internalMutationAfterTakeAway } from "./lib/rowWatch/mutations";
import { takeAwaySteps, type TakeAwayStep, type TakeAwayTarget } from "./lib/accessHandOff/takeAway";
import { foldSteps } from "./lib/accessHandOff/fold";
import { leaveDroppedDomains } from "./lib/domainMembership";
import { consoleWorkspaceClient } from "./lib/workspaceObjects/door";
import { deleteAccountFor, deleteWorkspaceCascade } from "./account";

/** Tries before it stops and says so in the logs: about a day with the backoff below. */
const MAX_ATTEMPTS = 12;
/** Keys per object call, under the contract's `MAX_ROWS_PER_CALL`. */
const PER_CALL = 1000;

const backoffMs = (attempt: number) => Math.min(30_000 * 2 ** attempt, 6 * 60 * 60 * 1000);

/** The calls a take-away makes on one object: the gateway's own client (`apps/mcp/src/workspaceStore/api.js`). */
export interface TakeAwayObject {
  members: { remove(userIds: string[], at: number): Promise<unknown>; put(rows: unknown[], extra: { workspace: { slug: string; kind: string } }): Promise<unknown> };
  invites: { remove(ids: string[], at: number): Promise<unknown> };
  access: { connections: { revoke(grantId: string, at: number): Promise<unknown> } };
}
export type OpenObject = (workspaceId: Id<"workspaces">) => TakeAwayObject | null;

/** The queued deletion and the object steps it needs now, or `null` once it is gone. */
export const planOf = internalQuery({
  args: { id: v.id("accessTakeAways") },
  returns: v.any(),
  handler: async (ctx, { id }) => {
    const job = await ctx.db.get(id);
    if (job === null) return null;
    if (job.kind === "fold") return { at: job.at, attempt: job.attempt, steps: await foldSteps(ctx, job) };
    const target: TakeAwayTarget =
      job.kind === "account"
        ? { kind: "account", userId: job.userId! }
        : job.kind === "leave"
          ? { kind: "leave", userId: job.userId!, workspaceIds: job.workspaceIds ?? [] }
          : { kind: "workspace", workspaceId: job.workspaceId! };
    return { at: job.at, attempt: job.attempt, steps: await takeAwaySteps(ctx, target) };
  },
});

const failed = (answer: unknown) => answer === null || typeof answer !== "object" || typeof (answer as { error?: unknown }).error === "string";

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += PER_CALL) out.push(items.slice(i, i + PER_CALL));
  return out;
}

async function applyStep(open: OpenObject, step: TakeAwayStep, at: number): Promise<void> {
  const object = open(step.workspaceId);
  if (object === null) throw new Error("take-away: object unreachable");
  if (step.scope === "workspace") {
    // A fold puts the account it moved into; its row carries the workspace's name, as a first put must.
    if (step.put !== undefined && failed(await object.members.put([step.put.row], { workspace: step.put.workspace }))) throw new Error("take-away: member put refused");
    for (const userIds of chunks(step.userIds)) if (failed(await object.members.remove(userIds, at))) throw new Error("take-away: members refused");
    for (const ids of chunks(step.inviteIds)) if (failed(await object.invites.remove(ids, at))) throw new Error("take-away: invites refused");
    return;
  }
  for (const grantId of step.grantIds) if (failed(await object.access.connections.revoke(grantId, at))) throw new Error("take-away: revoke refused");
}

/** One pass over a queued deletion: `"done"`, `"gone"` (nothing queued) or `"failed"` (left queued). */
export async function runTakeAway(ctx: ActionCtx, id: Id<"accessTakeAways">, open: OpenObject): Promise<"done" | "gone" | "failed"> {
  const plan = (await ctx.runQuery(internal.functions.accessTakeAway.planOf, { id })) as { at: number; attempt: number; steps: TakeAwayStep[] } | null;
  if (plan === null) return "gone";
  try {
    for (const step of plan.steps) await applyStep(open, step, plan.at);
  } catch {
    return "failed";
  }
  await ctx.runMutation(internal.functions.accessTakeAway.finish, { id });
  return "done";
}

export const run = internalAction({
  args: { id: v.id("accessTakeAways") },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    const open: OpenObject = (workspaceId) => consoleWorkspaceClient(ctx, workspaceId) as unknown as TakeAwayObject | null;
    if ((await runTakeAway(ctx, id, open)) !== "failed") return null;
    const attempt = await ctx.runMutation(internal.functions.accessTakeAway.retried, { id });
    if (attempt === null) return null;
    if (attempt >= MAX_ATTEMPTS) {
      // Ids and counts only. The deletion stays queued and is named here for someone to look at.
      console.error(JSON.stringify({ event: "access_take_away_stuck", takeAwayId: id, attempts: attempt }));
      return null;
    }
    await ctx.scheduler.runAfter(backoffMs(attempt), internal.functions.accessTakeAway.run, { id });
    return null;
  },
});

export const retried = internalMutationAfterTakeAway({
  args: { id: v.id("accessTakeAways") },
  returns: v.union(v.null(), v.number()),
  handler: async (ctx, { id }) => {
    const job = await ctx.db.get(id);
    if (job === null) return null;
    await ctx.db.patch(id, { attempt: job.attempt + 1 });
    return job.attempt + 1;
  },
});

/**
 * Convex's rows, deleted behind the objects that already took the deletion.
 * Writes to a switched scope's members, invites and connections are written
 * behind; every other access change (the copies in other people's objects) is
 * pushed as usual (`internalMutationAfterTakeAway`).
 */
export const finish = internalMutationAfterTakeAway({
  args: { id: v.id("accessTakeAways") },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    const job = await ctx.db.get(id);
    if (job === null) return null;
    await ctx.db.delete(id);
    // A fold is already in Convex: the objects were all that was owed.
    if (job.kind === "fold") return null;
    if (job.kind === "leave" && job.userId !== undefined) {
      await leaveDroppedDomains(ctx, job.userId, job.workspaceIds ?? []);
    } else if (job.kind === "account" && job.userId !== undefined) {
      if ((await ctx.db.get(job.userId)) !== null) await deleteAccountFor(ctx, job.userId);
    } else if (job.workspaceId !== undefined && (await ctx.db.get(job.workspaceId)) !== null) {
      await deleteWorkspaceCascade(ctx, job.workspaceId);
    }
    return null;
  },
});
