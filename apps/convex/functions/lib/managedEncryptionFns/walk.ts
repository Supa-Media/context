/**
 * The walk: one page of one workspace per run, self-scheduling, the same
 * shape as the managed hand-off copy (`runManagedStorageMigration`).
 *
 *   waiting ──key exists──▶ encrypting/count ──▶ encrypting/seal ──▶ checking ──▶ encrypted
 *                                   any failure ──▶ failed (the rollout pauses itself)
 *
 * And the way back, run per workspace from production access (`decryptWorkspace`):
 *
 *   any ──Decrypt──▶ decrypting/unseal ──▶ decrypting/confirm ──▶ decrypted
 *                  a failure stops here, still `decrypting`, rollout untouched
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
import {
  checkObject,
  checkPlainObject,
  sealObject,
  unsealObject,
} from "../../../../mcp/src/store/managedEncryptionWalk.js";
import { R2_CREDENTIAL_SETTLE_MS } from "../cloudflare";
import type { GatewayCredential } from "../storage/shapes";
import { settleInPool } from "./pool";
import { rolloutRow } from "./rollout";
import { bindingIsManaged, workspaceEncryptionRow } from "./state";

export const COUNT_PAGE = 1000;
/**
 * Objects per run. Each run pays a fixed cost (the plan, the key, the
 * credential, the page record), so pages are bigger than they were (100).
 * They stay well inside an action's time limit, because a run that times out
 * records nothing and schedules nothing: 300 objects at 24 lanes is about a
 * minute even at six seconds an object, roughly what one lane of the first
 * production walk averaged.
 */
export const SEAL_PAGE = 300;
/** Objects in flight at once. Each is three R2 calls: read, write, read back. */
export const WALK_LANES = 24;
/**
 * Declared bytes in flight at once. The walk holds each object two or three
 * times (read, sealed, read back) and actions have a small heap, so a page of
 * large attachments runs a few at a time rather than 24.
 */
export const WALK_BYTE_BUDGET = 12 * 1024 * 1024;
/** How often a walk looks again while its bucket's new credential settles. */
export const WALK_SETTLE_POLL_MS = 15 * 1000;
/**
 * How long after its binding was written a walk waits on it to be verified.
 * The verifier itself gives up at `R2_CREDENTIAL_SETTLE_MS` and records an
 * answer either way; the margin covers its last probe and the scheduler. A
 * binding still unverified past this is not settling, so the walk runs and
 * fails visibly if the bucket still refuses it.
 */
export const WALK_SETTLE_LIMIT_MS = R2_CREDENTIAL_SETTLE_MS + 3 * 60 * 1000;

type Row = Doc<"managedEncryptionWorkspaces">;
export type WalkPlan = Pick<Row, "state" | "phase" | "cursor"> & {
  /**
   * When the binding was written, while it is still `unverified`. The action
   * compares it with the clock, not this query: Convex caches a query's result
   * until what it read changes, so a clock read here could go stale.
   */
  unverifiedSince?: number;
};

/** What this run should do, or null when it should stop without writing. */
export async function walkPlanHandler(
  ctx: QueryCtx,
  args: { workspaceId: Id<"workspaces">; runId: number },
): Promise<WalkPlan | null> {
  const row = await workspaceEncryptionRow(ctx, args.workspaceId);
  if (row === null || row.runId !== args.runId) return null;
  if (row.state === "encrypted" || row.state === "failed" || row.state === "decrypted") return null;
  if (row.state === "decrypting") {
    // The way back is a rescue: it runs whatever the rollout's state, since a
    // paused or failed rollout is exactly when staff reach for it. A failure
    // stops it (`errorCode`) until Decrypt is run again.
    if (row.errorCode !== undefined) return null;
    if (!(await stillOnManagedBucket(ctx, args.workspaceId))) return null;
    if (await handOffUnderWay(ctx, args.workspaceId)) return null;
    return { state: row.state, phase: row.phase, cursor: row.cursor };
  }
  const rollout = await rolloutRow(ctx);
  if (rollout === null) return null;
  // Paused and failed stop every walk. `off` lets a started walk finish, and
  // lets nothing new start (`tick` never schedules a waiting row then).
  if (rollout.state === "paused" || rollout.state === "failed") return null;
  if (row.state === "waiting" && rollout.state !== "running") return null;
  if (!(await stillOnManagedBucket(ctx, args.workspaceId))) return null;
  if (await handOffUnderWay(ctx, args.workspaceId)) return null;
  const plan = { state: row.state, phase: row.phase, cursor: row.cursor };
  const unverifiedSince = await bindingUnverifiedSince(ctx, args.workspaceId);
  return unverifiedSince === null ? plan : { ...plan, unverifiedSince };
}

/**
 * Whether the bucket was bound moments ago and its credential has not
 * answered yet: `bindingUnverifiedSince` reads the row, `bucketSettling`
 * decides.
 *
 * Provisioning mints the bucket and a key scoped to it, binds them and joins
 * the rollout in one transaction, but R2 makes a new key usable at the S3
 * endpoint only eventually (`R2_CREDENTIAL_SETTLE_MS`). The binding stays
 * `unverified` until the verifier's probe, retried across that window, has
 * got through. A walk started before then met the refusal on its first
 * listing and failed the workspace, which paused the rollout, and staff's
 * Retry minutes later worked with nothing changed: every new workspace read
 * "Failed check". So the walk waits for the same answer the plan waits for.
 *
 * `error` is an answer, and the walk runs into it as before. An `unverified`
 * binding older than `WALK_SETTLE_LIMIT_MS` is not settling either, so a walk
 * never waits on one forever.
 */
async function bindingUnverifiedSince(ctx: QueryCtx, workspaceId: Id<"workspaces">): Promise<number | null> {
  const binding = await ctx.db
    .query("storageBindings")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
  return binding !== null && binding.status === "unverified" ? binding.updatedAt : null;
}

export function bucketSettling(plan: WalkPlan, now: number): boolean {
  return plan.unverifiedSince !== undefined && now - plan.unverifiedSince < WALK_SETTLE_LIMIT_MS;
}

export async function stillOnManagedBucket(ctx: QueryCtx, workspaceId: Id<"workspaces">): Promise<boolean> {
  const binding = await ctx.db
    .query("storageBindings")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
  return bindingIsManaged(binding);
}

/**
 * The walk stands down while the workspace is leaving for its own bucket.
 *
 * The hand-off reads the mode once per copy page. A walk sealing objects
 * after that read would put ciphertext into the customer's bucket, so no
 * walk runs while a copy (or a failed one that can be resumed) exists. The
 * row keeps its state: `encrypting` still reads both kinds, a switch back
 * restarts it (`managedBucketBound`), and Resume picks up an abandoned one.
 */
export async function handOffUnderWay(ctx: QueryCtx, workspaceId: Id<"workspaces">): Promise<boolean> {
  const migrations = await ctx.db
    .query("managedStorageMigrations")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  return migrations.some((migration) => migration.direction === "to_customer");
}

export async function beginWalkHandler(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces">; runId: number },
): Promise<boolean> {
  const row = await workspaceEncryptionRow(ctx, args.workspaceId);
  if (row === null || row.runId !== args.runId || row.state !== "waiting") return false;
  if (await handOffUnderWay(ctx, args.workspaceId)) return false;
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
  phase: "count" | "seal" | "check" | "unseal" | "confirm";
  nextCursor: string | null;
  counted: number;
  done: number;
};

/** Record one page. Returns whether the walk should schedule its next run. */
export async function recordPageHandler(ctx: MutationCtx, args: PageResult): Promise<boolean> {
  const row = await workspaceEncryptionRow(ctx, args.workspaceId);
  if (row === null || row.runId !== args.runId || row.phase !== args.phase) return false;
  const now = Date.now();
  // Every recorded page is progress, so the watchdog's count starts over.
  const moved = { updatedAt: now, stalls: undefined };
  if (args.phase === "count") {
    const total = (row.filesTotal ?? 0) + args.counted;
    await ctx.db.patch(row._id, args.nextCursor === null
      ? { phase: "seal", cursor: undefined, filesTotal: total, ...moved }
      : { cursor: args.nextCursor, filesTotal: total, ...moved });
    return true;
  }
  const sum = row.filesDone + args.done;
  // Objects written after the count can push the sum past it; the total grows
  // with them rather than the bar reading more than full.
  const filesDone = sum;
  const filesTotal = Math.max(row.filesTotal ?? 0, sum);
  if (args.nextCursor !== null) {
    await ctx.db.patch(row._id, { cursor: args.nextCursor, filesDone, filesTotal, ...moved });
    return true;
  }
  if (args.phase === "seal") {
    await ctx.db.patch(row._id, { state: "checking", phase: "check", cursor: undefined, filesDone, filesTotal, ...moved });
    return true;
  }
  if (args.phase === "unseal") {
    await ctx.db.patch(row._id, { phase: "confirm", cursor: undefined, filesDone, filesTotal, ...moved });
    return true;
  }
  if (args.phase === "confirm") {
    await ctx.db.patch(row._id, {
      state: "decrypted",
      phase: undefined,
      cursor: undefined,
      filesDone,
      filesTotal,
      completedAt: now,
      ...moved,
    });
    return false;
  }
  await ctx.db.patch(row._id, {
    state: "encrypted",
    phase: undefined,
    cursor: undefined,
    filesDone,
    filesTotal,
    completedAt: now,
    ...moved,
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
  if (row.state === "decrypting") {
    // Stays `decrypting`: reads accept both and saves stay plain. `failed`
    // would read as mid-encryption and seal new saves. The rollout is left
    // alone; this workspace was taken out of it.
    await ctx.db.patch(row._id, { errorCode: args.errorCode, updatedAt: Date.now() });
    return;
  }
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

/** Every object settles before a failure is reported; see `pool.ts`. */
function eachObject(objects: { key: string; size?: number }[], work: (key: string) => Promise<void>) {
  return settleInPool(
    objects,
    { lanes: WALK_LANES, byteBudget: WALK_BYTE_BUDGET, sizeOf: (object) => object.size ?? 0 },
    (object) => work(object.key),
  );
}

export async function runWalkHandler(
  ctx: ActionCtx,
  args: { workspaceId: Id<"workspaces">; runId: number },
): Promise<void> {
  const plan: WalkPlan | null = await ctx.runQuery(internal.functions.managedEncryption.walkPlan, args);
  if (plan === null) return;
  if (bucketSettling(plan, Date.now())) {
    // Same runId, so a pause, a retry or a restart retires this wait too. No
    // key is minted and nothing is read until the bucket has answered.
    await ctx.scheduler.runAfter(WALK_SETTLE_POLL_MS, internal.functions.managedEncryption.runWalk, args);
    return;
  }
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
      // The way back never mints a key: one that is missing is a failure.
      create: plan.state !== "decrypting",
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
    const phase = plan.phase ?? (plan.state === "decrypting" ? "unseal" : "count");
    const page = await bare.list({ cursor: plan.cursor, limit: phase === "count" ? COUNT_PAGE : SEAL_PAGE });
    const objects: { key: string; size?: number }[] = page.objects;
    let done = 0;
    if (phase === "seal") {
      await eachObject(objects, async (key) => {
        await sealObject(bare, cipher, key);
        done += 1;
      });
    } else if (phase === "check") {
      await eachObject(objects, async (key) => {
        if ((await checkObject(bare, cipher, key)) === "plain") await sealObject(bare, cipher, key);
        done += 1;
      });
    } else if (phase === "unseal") {
      await eachObject(objects, async (key) => {
        await unsealObject(bare, cipher, key);
        done += 1;
      });
    } else if (phase === "confirm") {
      // An object sealed after the unseal pass passed it (a request built
      // before the switch) is opened here rather than left behind.
      await eachObject(objects, async (key) => {
        if ((await checkPlainObject(bare, key)) === "sealed") await unsealObject(bare, cipher, key);
      });
    }
    result = {
      ...args,
      phase,
      nextCursor: page.truncated && page.cursor ? page.cursor : null,
      counted: phase === "count" ? objects.length : 0,
      done: phase === "check" || phase === "confirm" ? 0 : done,
    };
  } catch (error) {
    return await fail(error);
  }
  const more: boolean = await ctx.runMutation(internal.functions.managedEncryption.recordPage, result);
  if (more) await ctx.scheduler.runAfter(0, internal.functions.managedEncryption.runWalk, args);
  // The walk rewrote objects without naming them, so their versions reach the
  // Convex tree by one sweep once it ends rather than a sweep per page.
  else await ctx.runMutation(internal.functions.nodes.requestSweep, { workspaceId: args.workspaceId }).catch(() => {});
}
