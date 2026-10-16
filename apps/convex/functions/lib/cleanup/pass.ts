/**
 * The old-copy cleanup's two chains (`functions/noteIdsCleanupRun.ts` schedules them):
 *
 * - Count: pages the bucket's keys through the gateway (`cleanupList`), counts
 *   what a Delete would remove and how many of those no row names, then pages
 *   the tree for `readingPaths`, and records the finished count.
 * - Delete: pages the bucket through the gateway, keeps only the keys
 *   `rows.ts` says may go, hands them to the gateway's delete page, and records
 *   each page. The cursor is stored on the row, so a page that dies is repeated
 *   and deleting an absent key is a no-op.
 *
 * Every page is one short query or mutation plus one mover call, the same
 * shape as the id copy (`lib/noteIds/copyPass.ts`). A page of a run that is no
 * longer current records nothing and schedules nothing.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import type { GatewayCredential } from "../storage/shapes";
import { COPY_RETRY_MS, COPY_STREAK_MAX } from "../nodes/noteIds";
import { runCleanupDeleteOnMover, runCleanupListOnMover } from "../storageMover";
import { CLEANUP_FAILED_LABEL, COUNT_FAILED_LABEL, GATE_CLOSED_LABEL } from "./gate";

export { CLEANUP_FAILED_LABEL, COUNT_FAILED_LABEL } from "./gate";

/** Keys one page of the bucket lists, and so one delete page names at most. */
export const CLEANUP_PAGE = 200;


export interface CleanupListPage {
  workspaceId: string;
  source: GatewayCredential & { workspaceId: string };
  cursor?: string;
  limit: number;
}

export interface CleanupDeletePage {
  workspaceId: string;
  source: GatewayCredential & { workspaceId: string };
  keys: string[];
}

export interface CleanupDeleteResult {
  key: string;
  ok: boolean;
  reason?: string;
}

/**
 * Where the pages run. Production: the mover when `origin` is set, the bucket
 * through its own credential here otherwise. Tests replace the two `*Here` seams.
 */
export interface CleanupDeps {
  origin: string | null;
  credential(ctx: ActionCtx, workspaceId: Id<"workspaces">): Promise<GatewayCredential | null>;
  listHere(page: CleanupListPage): Promise<{ keys: string[]; nextCursor: string | null }>;
  deleteHere(page: CleanupDeletePage): Promise<{ results: CleanupDeleteResult[] }>;
}

export interface CountArgs {
  workspaceId: Id<"workspaces">;
  runId: number;
  phase: "bucket" | "rows";
  cursor?: string;
  toDelete: number;
  unclaimed: number;
  readingPaths: number;
  streak?: number;
}

export interface DeleteArgs {
  workspaceId: Id<"workspaces">;
  runId: number;
  cursor?: string;
  streak?: number;
}

/** Ran a page, or the run was no longer current (`null`): a stale page stops its chain without retrying. */
type Outcome<T> = T | null;

async function sourceOf(ctx: ActionCtx, workspaceId: Id<"workspaces">, deps: CleanupDeps): Promise<GatewayCredential & { workspaceId: string }> {
  const credential = await deps.credential(ctx, workspaceId);
  if (credential === null) throw new Error("SOURCE_UNAVAILABLE");
  return { ...credential, workspaceId: String(workspaceId) };
}

/** One page of the bucket's keys, from `cursor`. `null` when the mover says the page is stale. */
async function listKeys(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  runId: number,
  cursor: string | undefined,
  deps: CleanupDeps,
): Promise<Outcome<{ keys: string[]; nextCursor: string | null }>> {
  if (deps.origin !== null) {
    const outcome = await runCleanupListOnMover(ctx, workspaceId, { runId, cursor }, deps.origin);
    if (outcome.kind === "stale") return null;
    if (outcome.kind !== "done") throw new Error(outcome.kind === "failed" ? outcome.code : "CLEANUP_FAILED");
    return { keys: outcome.keys, nextCursor: outcome.nextCursor };
  }
  const source = await sourceOf(ctx, workspaceId, deps);
  return await deps.listHere({ workspaceId: String(workspaceId), source, ...(cursor === undefined ? {} : { cursor }), limit: CLEANUP_PAGE });
}

/** Delete the approved keys of one page. `null` when the mover says the page is stale. */
async function deleteKeys(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  runId: number,
  keys: string[],
  deps: CleanupDeps,
): Promise<Outcome<CleanupDeleteResult[]>> {
  if (deps.origin !== null) {
    const outcome = await runCleanupDeleteOnMover(ctx, workspaceId, { runId, keys }, deps.origin);
    if (outcome.kind === "stale") return null;
    if (outcome.kind !== "done") throw new Error(outcome.kind === "failed" ? outcome.code : "CLEANUP_FAILED");
    return outcome.results;
  }
  const source = await sourceOf(ctx, workspaceId, deps);
  return (await deps.deleteHere({ workspaceId: String(workspaceId), source, keys })).results;
}

/** One page of the Count, then the next, or the finished count. Never throws. */
export async function runCountChain(ctx: ActionCtx, args: CountArgs, deps: CleanupDeps): Promise<void> {
  const { workspaceId, runId } = args;
  const streak = args.streak ?? 0;
  try {
    if (!(await ctx.runQuery(internal.functions.noteIdsCleanup.countCurrent, { workspaceId, runId }))) return;
    if (args.phase === "bucket") {
      const page = await listKeys(ctx, workspaceId, runId, args.cursor, deps);
      if (page === null) return;
      const counts = await ctx.runQuery(internal.functions.noteIdsCleanup.classifyPage, { workspaceId, keys: page.keys });
      const next = {
        toDelete: args.toDelete + counts.toDelete,
        unclaimed: args.unclaimed + counts.unclaimed,
        readingPaths: args.readingPaths,
      };
      await ctx.scheduler.runAfter(0, internal.functions.noteIdsCleanupRun.runCount, {
        workspaceId,
        runId,
        phase: page.nextCursor === null ? "rows" : "bucket",
        ...(page.nextCursor === null ? {} : { cursor: page.nextCursor }),
        ...next,
        streak: 0,
      });
      return;
    }
    const scan = await ctx.runQuery(internal.functions.noteIdsCleanup.readingPage, { workspaceId, after: args.cursor });
    const readingPaths = args.readingPaths + scan.readingPaths;
    if (scan.done) {
      await ctx.runMutation(internal.functions.noteIdsCleanup.finishCount, {
        workspaceId,
        runId,
        toDelete: args.toDelete,
        unclaimed: args.unclaimed,
        readingPaths,
      });
      return;
    }
    await ctx.scheduler.runAfter(0, internal.functions.noteIdsCleanupRun.runCount, {
      workspaceId,
      runId,
      phase: "rows",
      ...(scan.next === undefined ? {} : { cursor: scan.next }),
      toDelete: args.toDelete,
      unclaimed: args.unclaimed,
      readingPaths,
      streak: 0,
    });
  } catch {
    // The workspace and the run only: a path or a provider's text never reaches a log.
    console.error("noteIds.cleanup_count_failed", { workspaceId, runId });
    if (streak + 1 >= COPY_STREAK_MAX) {
      await ctx.runMutation(internal.functions.noteIdsCleanup.failCleanup, { workspaceId, runId, label: COUNT_FAILED_LABEL });
      return;
    }
    await ctx.scheduler.runAfter(COPY_RETRY_MS, internal.functions.noteIdsCleanupRun.runCount, { ...args, streak: streak + 1 });
  }
}

/**
 * One page of the Delete: list it, keep what may go, delete it, record it, and
 * move the stored cursor on. The last page finishes the run. Never throws.
 */
export async function runDeleteChain(ctx: ActionCtx, args: DeleteArgs, deps: CleanupDeps): Promise<void> {
  const { workspaceId, runId, cursor } = args;
  const streak = args.streak ?? 0;
  try {
    if (!(await ctx.runQuery(internal.functions.noteIdsCleanup.deleteCurrent, { workspaceId, runId, cursor }))) return;
    // The gate can close after the run started (the switch, the count's age): every page asks again.
    if (!(await ctx.runQuery(internal.functions.noteIdsCleanup.deleteGateOpen, { workspaceId }))) {
      await ctx.runMutation(internal.functions.noteIdsCleanup.failCleanup, { workspaceId, runId, label: GATE_CLOSED_LABEL });
      return;
    }
    const page = await listKeys(ctx, workspaceId, runId, cursor, deps);
    if (page === null) return;
    const candidates = await ctx.runQuery(internal.functions.noteIdsCleanup.deletableForPage, { workspaceId, keys: page.keys });
    const results = candidates.length === 0 ? [] : await deleteKeys(ctx, workspaceId, runId, candidates, deps);
    if (results === null) return;
    const recorded = await ctx.runMutation(internal.functions.noteIdsCleanup.recordDeletePage, {
      workspaceId,
      runId,
      ...(cursor === undefined ? {} : { expectedCursor: cursor }),
      ...(page.nextCursor === null ? {} : { nextCursor: page.nextCursor }),
      results,
    });
    if (!recorded) return;
    if (page.nextCursor === null) {
      await ctx.runMutation(internal.functions.noteIdsCleanup.finishDelete, { workspaceId, runId });
      return;
    }
    await ctx.scheduler.runAfter(0, internal.functions.noteIdsCleanupRun.runDelete, {
      workspaceId,
      runId,
      cursor: page.nextCursor,
      streak: 0,
    });
  } catch {
    console.error("noteIds.cleanup_delete_failed", { workspaceId, runId });
    if (streak + 1 >= COPY_STREAK_MAX) {
      await ctx.runMutation(internal.functions.noteIdsCleanup.failCleanup, { workspaceId, runId, label: CLEANUP_FAILED_LABEL });
      return;
    }
    await ctx.scheduler.runAfter(COPY_RETRY_MS, internal.functions.noteIdsCleanupRun.runDelete, {
      workspaceId,
      runId,
      ...(cursor === undefined ? {} : { cursor }),
      streak: streak + 1,
    });
  }
}
