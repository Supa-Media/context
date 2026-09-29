/**
 * The walk: one page of one workspace per run, self-scheduling, the same
 * shape as the managed hand-off copy (`runManagedStorageMigration`).
 *
 *   waiting ──key exists──▶ encrypting/count ──▶ encrypting/seal ──▶ checking ──▶ encrypted
 *                                   any failure ──▶ failed (the rollout pauses itself)
 *
 * The per-object work is the gateway's (`apps/mcp/src/store/managedEncryptionWalk.js`):
 * conditional seal, read back, verify. Every run carries a `runId`; a run
 * whose id is no longer the row's stops without writing, which is how a
 * pause, a retry or a restart retires a run already in flight.
 *
 * `checking` re-reads everything once more before encrypted-only reads
 * start. An object still plain at that point (a save from a request that
 * began before the walk did) is sealed there and then rather than failing
 * the workspace.
 */

import { ConvexError } from "convex/values";
import { internal } from "../../../_generated/api";
import type { Doc, Id } from "../../../_generated/dataModel";
import type { ActionCtx, MutationCtx, QueryCtx } from "../../../_generated/server";
import { storeForBinding } from "../../../../mcp/src/store/factory.js";
import { ManagedCipher } from "../../../../mcp/src/store/managedEncryption.js";
import { checkObject, sealObject } from "../../../../mcp/src/store/managedEncryptionWalk.js";
import type { GatewayCredential } from "../storage/shapes";
import { rolloutRow } from "./rollout";
import { bindingIsManaged, workspaceEncryptionRow } from "./state";

export const COUNT_PAGE = 1000;
export const SEAL_PAGE = 100;
const PARALLEL = 8;

type Row = Doc<"managedEncryptionWorkspaces">;
export type WalkPlan = Pick<Row, "state" | "phase" | "cursor">;

/** What this run should do, or null when it should stop without writing. */
export async function walkPlanHandler(
  ctx: QueryCtx,
  args: { workspaceId: Id<"workspaces">; runId: number },
): Promise<WalkPlan | null> {
  const row = await workspaceEncryptionRow(ctx, args.workspaceId);
  if (row === null || row.runId !== args.runId) return null;
  if (row.state === "encrypted" || row.state === "failed") return null;
  const rollout = await rolloutRow(ctx);
  if (rollout === null) return null;
  // Paused and failed stop every walk. `off` lets a started walk finish, and
  // lets nothing new start (`tick` never schedules a waiting row then).
  if (rollout.state === "paused" || rollout.state === "failed") return null;
  if (row.state === "waiting" && rollout.state !== "running") return null;
  const binding = await ctx.db
    .query("storageBindings")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .unique();
  if (!bindingIsManaged(binding)) return null;
  return { state: row.state, phase: row.phase, cursor: row.cursor };
}

export async function beginWalkHandler(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces">; runId: number },
): Promise<boolean> {
  const row = await workspaceEncryptionRow(ctx, args.workspaceId);
  if (row === null || row.runId !== args.runId || row.state !== "waiting") return false;
  await ctx.db.patch(row._id, {
    state: "encrypting",
    phase: "count",
    cursor: undefined,
    filesDone: 0,
    filesTotal: undefined,
    updatedAt: Date.now(),
  });
  return true;
}

export type PageResult = {
  workspaceId: Id<"workspaces">;
  runId: number;
  phase: "count" | "seal" | "check";
  nextCursor: string | null;
  counted: number;
  done: number;
};

/** Record one page. Returns whether the walk should schedule its next run. */
export async function recordPageHandler(ctx: MutationCtx, args: PageResult): Promise<boolean> {
  const row = await workspaceEncryptionRow(ctx, args.workspaceId);
  if (row === null || row.runId !== args.runId || row.phase !== args.phase) return false;
  const now = Date.now();
  if (args.phase === "count") {
    const total = (row.filesTotal ?? 0) + args.counted;
    await ctx.db.patch(row._id, args.nextCursor === null
      ? { phase: "seal", cursor: undefined, filesTotal: total, updatedAt: now }
      : { cursor: args.nextCursor, filesTotal: total, updatedAt: now });
    return true;
  }
  const sum = row.filesDone + args.done;
  // Objects written after the count can push the sum past it; the total grows
  // with them rather than the bar reading more than full.
  const filesDone = sum;
  const filesTotal = Math.max(row.filesTotal ?? 0, sum);
  if (args.nextCursor !== null) {
    await ctx.db.patch(row._id, { cursor: args.nextCursor, filesDone, filesTotal, updatedAt: now });
    return true;
  }
  if (args.phase === "seal") {
    await ctx.db.patch(row._id, { state: "checking", phase: "check", cursor: undefined, filesDone, filesTotal, updatedAt: now });
    return true;
  }
  await ctx.db.patch(row._id, {
    state: "encrypted",
    phase: undefined,
    cursor: undefined,
    filesDone,
    filesTotal,
    completedAt: now,
    updatedAt: now,
  });
  await ctx.scheduler.runAfter(0, internal.functions.managedEncryption.tick, { restartActive: false });
  return false;
}

export async function failWalkHandler(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces">; runId: number; errorCode: string },
): Promise<void> {
  const row = await workspaceEncryptionRow(ctx, args.workspaceId);
  if (row === null || row.runId !== args.runId) return;
  await ctx.db.patch(row._id, { state: "failed", errorCode: args.errorCode, updatedAt: Date.now() });
  const rollout = await rolloutRow(ctx);
  if (rollout !== null && rollout.state === "running") {
    await ctx.db.patch(rollout._id, { state: "failed", changedBy: "system", updatedAt: Date.now() });
  }
}

/** Stable, content-free codes only. A message could quote a key or a path. */
function errorCodeOf(error: unknown): string {
  // A ConvexError carries its code on `.data`; the gateway's errors on `.code`.
  const shaped = error as { code?: unknown; data?: { code?: unknown } } | null;
  const code = shaped?.code ?? shaped?.data?.code;
  if (typeof code === "string" && /^[A-Z_]{3,40}$/.test(code)) return code;
  return "WALK_FAILED";
}

async function inBatches<T>(items: T[], work: (item: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += PARALLEL) {
    await Promise.all(items.slice(i, i + PARALLEL).map(work));
  }
}

export async function runWalkHandler(
  ctx: ActionCtx,
  args: { workspaceId: Id<"workspaces">; runId: number },
): Promise<void> {
  const plan: WalkPlan | null = await ctx.runQuery(internal.functions.managedEncryption.walkPlan, args);
  if (plan === null) return;
  const fail = async (error: unknown): Promise<void> => {
    await ctx.runMutation(internal.functions.managedEncryption.failWalk, { ...args, errorCode: errorCodeOf(error) });
  };

  let key: { current: string; keys: Record<string, string> } | null;
  let credential: GatewayCredential | null;
  try {
    // Get-or-create, and only here: the walk is the one thing that decides a
    // managed workspace needs a key. The same key opens its encrypted notes.
    key = await ctx.runAction(internal.functions.encryptionKeys.openWorkspaceDataKey, {
      workspaceId: args.workspaceId,
      create: true,
    });
    credential = await ctx.runAction(internal.functions.storage.getBindingForGateway, {
      workspaceId: args.workspaceId,
    });
  } catch (error) {
    return await fail(error);
  }
  if (key === null || credential === null) return await fail(new ConvexError({ code: "KEY_UNAVAILABLE" }));

  if (plan.state === "waiting") {
    const began: boolean = await ctx.runMutation(internal.functions.managedEncryption.beginWalk, args);
    if (began) await ctx.scheduler.runAfter(0, internal.functions.managedEncryption.runWalk, args);
    return;
  }

  let result: PageResult;
  try {
    // The bare adapter: the walk must see which bytes are still plain.
    const bare = storeForBinding(credential, undefined, { sealedObjects: true });
    const cipher = new ManagedCipher(String(args.workspaceId), key);
    const phase = plan.phase ?? "count";
    const page = await bare.list({ cursor: plan.cursor, limit: phase === "count" ? COUNT_PAGE : SEAL_PAGE });
    const keys: string[] = page.objects.map((object: { key: string }) => object.key);
    let done = 0;
    if (phase === "seal") {
      await inBatches(keys, async (key) => {
        await sealObject(bare, cipher, key);
        done += 1;
      });
    } else if (phase === "check") {
      await inBatches(keys, async (key) => {
        if ((await checkObject(bare, cipher, key)) === "plain") await sealObject(bare, cipher, key);
        done += 1;
      });
    }
    result = {
      ...args,
      phase,
      nextCursor: page.truncated && page.cursor ? page.cursor : null,
      counted: phase === "count" ? keys.length : 0,
      done: phase === "check" ? 0 : done,
    };
  } catch (error) {
    return await fail(error);
  }
  const more: boolean = await ctx.runMutation(internal.functions.managedEncryption.recordPage, result);
  if (more) await ctx.scheduler.runAfter(0, internal.functions.managedEncryption.runWalk, args);
}
