/**
 * One page of the id copy, run by its action (`functions/noteIdsCopy.ts`):
 * claim the pass, find the next stale files, copy them (on the gateway's mover
 * when one is configured, here otherwise), record what happened, and schedule
 * whatever comes next. Every step is a short mutation or query, so a page that
 * dies in the middle leaves the pass where its last record put it.
 *
 * The bytes never pass through a Convex action when the mover is set: the
 * action only hands over ids, paths and etags. Here they do, which is the
 * self-hosted brake the mover's own header describes.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import type { GatewayCredential } from "../storage/shapes";
import { COPY_PAGE, COPY_RETRY_MS, COPY_REASONS, ID_BYTE_BUDGET, ID_LANES, type NoteIdItem } from "../nodes/noteIds";
import { runNoteIdPageOnMover } from "../storageMover";
import type { CopyResult } from "./copyRecord";

/** A page whose scan found a live file with no id yet waits this long for the backfill. */
export const UNIDENTIFIED_RETRY_MS = 10_000;

export interface ChainArgs {
  workspaceId: Id<"workspaces">;
  runId: number;
  found?: boolean;
  streak?: number;
}

export type CopyPageRequest = {
  kind: "idCopy";
  workspaceId: string;
  source: GatewayCredential & { workspaceId: string };
  items: NoteIdItem[];
  limits: { lanes: number; byteBudget: number };
};

/**
 * Where the page runs. Production: the mover when `origin` is set, the bucket
 * from `getBindingForGateway` here otherwise. Tests replace the copy with the
 * memory store.
 */
export interface CopyDeps {
  origin: string | null;
  credential(ctx: ActionCtx, workspaceId: Id<"workspaces">): Promise<GatewayCredential | null>;
  copyHere(page: CopyPageRequest): Promise<{ results: unknown[] }>;
}

/** The answers for each item, in item order: a path the page did not answer for is a failure. */
export function normalizeCopy(items: readonly NoteIdItem[], answers: readonly unknown[]): CopyResult[] {
  const byPath = new Map<string, Record<string, unknown>>();
  for (const answer of answers) {
    if (answer !== null && typeof answer === "object" && typeof (answer as { path?: unknown }).path === "string") {
      byPath.set((answer as { path: string }).path, answer as Record<string, unknown>);
    }
  }
  return items.map((item): CopyResult => {
    const answer = byPath.get(item.path);
    if (answer === undefined) return { path: item.path, ok: false, reason: "no_answer" };
    if (answer.ok === true) {
      return answer.etag === item.etag
        ? { path: item.path, ok: true, etag: item.etag }
        : { path: item.path, ok: false, reason: "changed" };
    }
    const reason = typeof answer.reason === "string" && COPY_REASONS.has(answer.reason) ? answer.reason : "copy_failed";
    return { path: item.path, ok: false, reason };
  });
}

async function copyItems(ctx: ActionCtx, args: ChainArgs, items: NoteIdItem[], deps: CopyDeps): Promise<CopyResult[]> {
  if (deps.origin !== null) {
    const outcome = await runNoteIdPageOnMover(ctx, args.workspaceId, { runId: args.runId, phase: "id_copy", items }, deps.origin);
    // A page the mover did not do is a failed page: the chain retries it after a back-off.
    if (outcome.kind !== "done") throw new Error(outcome.kind);
    return normalizeCopy(items, outcome.results);
  }
  const credential = await deps.credential(ctx, args.workspaceId);
  if (credential === null) throw new Error("SOURCE_UNAVAILABLE");
  const page = await deps.copyHere({
    kind: "idCopy",
    workspaceId: String(args.workspaceId),
    source: { ...credential, workspaceId: String(args.workspaceId) },
    items,
    limits: { lanes: ID_LANES, byteBudget: ID_BYTE_BUDGET },
  });
  return normalizeCopy(items, page.results);
}

/** Run one page of the pass. Never throws: a failure is recorded and retried or shown as failed. */
export async function runCopyChain(ctx: ActionCtx, args: ChainArgs, deps: CopyDeps): Promise<void> {
  const { workspaceId, runId } = args;
  const found = args.found === true;
  const streak = args.streak ?? 0;
  const claimed = await ctx.runMutation(internal.functions.noteIdsCopy.claimCopy, { workspaceId, runId, now: Date.now() });
  if (claimed === null) return;
  try {
    const page = await ctx.runQuery(internal.functions.noteIdsCopy.copyPage, {
      workspaceId,
      after: claimed.cursor,
      limit: COPY_PAGE,
    });
    if (page.unidentified > 0) {
      // Rows the backfill has not reached cannot be keyed yet: let it finish, then come back.
      await ctx.runMutation(internal.functions.noteIdsCopy.releaseCopy, { workspaceId, runId });
      await ctx.scheduler.runAfter(0, internal.functions.noteIdsCopy.backfill, { workspaceId });
      await ctx.scheduler.runAfter(UNIDENTIFIED_RETRY_MS, internal.functions.noteIdsCopy.run, { workspaceId, runId, found, streak });
      return;
    }
    const results = page.items.length === 0 ? [] : await copyItems(ctx, args, page.items, deps);
    const step = await ctx.runMutation(internal.functions.noteIdsCopy.recordCopy, {
      workspaceId,
      runId,
      ...(claimed.cursor === undefined ? {} : { expectedCursor: claimed.cursor }),
      ...(page.next === undefined ? {} : { next: page.next }),
      done: page.done,
      found,
      files: page.files,
      fresh: page.fresh,
      refused: page.refused,
      results,
    });
    if (step.next === "more") {
      await ctx.scheduler.runAfter(0, internal.functions.noteIdsCopy.run, { workspaceId, runId, found: step.found, streak: 0 });
    } else if (step.next === "restart") {
      await ctx.scheduler.runAfter(0, internal.functions.noteIdsCopy.run, { workspaceId, runId, found: false, streak: 0 });
    }
  } catch {
    // The workspace and the run only: a path or a provider's text never reaches a log.
    console.error("noteIds.copy_page_failed", { workspaceId, runId });
    const outcome = await ctx.runMutation(internal.functions.noteIdsCopy.failCopy, { workspaceId, runId, streak });
    if (outcome === "retry") {
      await ctx.scheduler.runAfter(COPY_RETRY_MS, internal.functions.noteIdsCopy.run, { workspaceId, runId, found, streak: streak + 1 });
    }
  }
}
