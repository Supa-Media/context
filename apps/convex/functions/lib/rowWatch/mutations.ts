/**
 * `mutation` and `internalMutation`, as every file in this deployment builds them: Convex's own, with the database
 * watched (`./watch.ts`). Import them from here, never from `_generated/server` (a CI test holds every file to it).
 *
 * After the handler returns, each workspace it changed whose notes live in their object gets one outbox entry,
 * written in the same transaction, and a push scheduled (`../../workspaceObjectPush.ts`). Any other workspace
 * costs one indexed read.
 */

import {
  internalMutation as convexInternalMutation,
  mutation as convexMutation,
  type MutationCtx,
} from "../../../_generated/server";
import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import { watchDb, type WorkspaceChange } from "./watch";
import { flushAccessWrites } from "../accessHandOff/flush";

/** The most rows one outbox entry names; a mutation that changes more is pushed whole (`all`). */
export const OUTBOX_MAX_IDS = 2_000;

/** Whether this workspace's notes are judged in its object. No row means the bucket, which needs nothing. */
async function judgedInObject(ctx: MutationCtx, workspaceId: Id<"workspaces">): Promise<boolean> {
  const home = await ctx.db
    .query("workspaceObjectHomes")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
  return home?.home === "object";
}

/** One outbox entry per object-mode workspace, and its push, in the mutation's own transaction. */
export async function flushRowChanges(
  ctx: MutationCtx,
  changes: Map<Id<"workspaces">, WorkspaceChange>,
): Promise<void> {
  for (const [workspaceId, change] of changes) {
    if (!(await judgedInObject(ctx, workspaceId))) continue;
    const ids = [...change.nodeIds];
    const all = ids.length > OUTBOX_MAX_IDS;
    await ctx.db.insert("workspaceObjectOutbox", {
      workspaceId,
      nodeIds: all ? [] : ids,
      access: change.access,
      ...(all ? { all: true } : {}),
      at: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.functions.workspaceObjectPush.drain, { workspaceId });
  }
}

type AnyDefinition = { handler: (ctx: MutationCtx, args: never) => unknown } & Record<string, unknown>;
type Handler = (ctx: MutationCtx, args: never) => unknown;

function watched<T>(definition: T, options: { writeBehind: boolean } = { writeBehind: false }): T {
  const def = (typeof definition === "function" ? { handler: definition as Handler } : definition) as AnyDefinition;
  const handler = def.handler;
  return {
    ...def,
    handler: async (ctx: MutationCtx, args: never) => {
      const watch = watchDb(ctx.db);
      const result = await handler({ ...ctx, db: watch.db }, args);
      await flushRowChanges(ctx, watch.changes);
      await flushAccessWrites(ctx, watch.accessWrites, options);
      return result;
    },
  } as T;
}

/** Convex's `mutation`, with its row writes told to the workspace's object. */
export const mutation = ((definition: unknown) => convexMutation(watched(definition) as never)) as typeof convexMutation;

/** Convex's `internalMutation`, with its row writes told to the workspace's object. */
export const internalMutation = ((definition: unknown) =>
  convexInternalMutation(watched(definition) as never)) as typeof convexInternalMutation;

/**
 * An `internalMutation` that writes Convex's access tables behind an object that already took the change (the
 * gateway's mirror while a workspace is on `object`; the copy). Its access writes are
 * never refused and never pushed back to the object. Tree-row writes are watched as usual.
 */
export const internalMutationWriteBehind = ((definition: unknown) =>
  convexInternalMutation(watched(definition, { writeBehind: true }) as never)) as typeof convexInternalMutation;

// The rest of the builders and contexts, so a file that takes its mutations from here needs one import.
export { action, internalAction, internalQuery, query, type ActionCtx, type MutationCtx, type QueryCtx } from "../../../_generated/server";
