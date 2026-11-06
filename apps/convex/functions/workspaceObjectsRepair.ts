/**
 * Settling, key by key, what a workspace read from its object disagrees with
 * its bucket about (owner, 2026-11-01;
 * `docs/decisions/storage-and-credentials/workspace-objects.md`). The rules
 * are in `lib/workspaceObjects/repair.ts`: a lost copy is restored into the
 * object, an erase the bucket missed is applied to it, a bucket behind the
 * object is brought up to date, and anything unplaced is left alone.
 *
 * Only workspaces whose home is `object`, and by default only those whose
 * last parity check found their bodies differing. Without `apply` it reads
 * and counts and changes nothing. The answer is counts and closed words only:
 * the job's log is public.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction, type ActionCtx } from "../_generated/server";
import { failureOf, withRetries } from "./lib/workspaceObjects/failures";
import { consoleWorkspaceClient } from "./lib/workspaceObjects/door";
import { emptyRepairCounts, Facts, repairPage, settleKey, type LiveNotes, type RepairCounts } from "./lib/workspaceObjects/repair";
import type { BodyStore } from "./lib/workspaceObjects/bodies";
import { nextWorkspace, openBucket, sleep, startState } from "./workspaceObjects";

/** How long one page of a run may work before it hands back its cursor. */
const PAGE_BUDGET_MS = 2 * 60 * 1000;
const KEYS_PER_PAGE = 100;

const repairCountsValidator = v.object({
  listed: v.number(),
  same: v.number(),
  objectNewer: v.number(),
  bucketNewer: v.number(),
  eraseNotApplied: v.number(),
  olderRevision: v.number(),
  unsure: v.number(),
  restored: v.number(),
  erased: v.number(),
  backedUp: v.number(),
  raced: v.number(),
  failed: v.number(),
});

/** Every live note of a workspace, by path and note id: what an erase is checked against before the bucket loses a key. */
async function liveNotesOf(ctx: ActionCtx, workspaceId: Id<"workspaces">): Promise<LiveNotes> {
  const live: LiveNotes = { paths: new Set(), noteIds: new Set() };
  let after: string | undefined;
  for (;;) {
    const page: { rows: Array<{ path: string; kind: string; noteId?: string }>; next: string | null } = await ctx.runQuery(
      internal.functions.workspaceObjectsRows.rowsPage,
      { workspaceId, ...(after === undefined ? {} : { after }) },
    );
    for (const row of page.rows) {
      if (row.kind !== "file") continue;
      live.paths.add(row.path);
      if (row.noteId !== undefined) live.noteIds.add(row.noteId);
    }
    if (page.next === null) return live;
    after = page.next;
  }
}

/** Whether a workspace's last recorded parity check found its bodies differing (no check recorded counts as differing). */
function bodiesDiffered(record: unknown): boolean {
  const bodies = (record as { parity?: { bodies?: { missingInObject?: number; extraInObject?: number; differ?: number } } } | null)?.parity?.bodies;
  if (!bodies) return true;
  return (bodies.missingInObject ?? 0) + (bodies.extraInObject ?? 0) + (bodies.differ ?? 0) > 0;
}

/** One page of the repair. Counts only. */
export const repair = internalAction({
  args: { cursor: v.optional(v.string()), only: v.optional(v.string()), apply: v.optional(v.boolean()), everyObject: v.optional(v.boolean()) },
  returns: v.object({
    workspaces: v.number(),
    skipped: v.number(),
    unreachable: v.number(),
    counts: repairCountsValidator,
    shapes: v.record(v.string(), v.number()),
    why: v.record(v.string(), v.number()),
    refused: v.optional(v.string()),
    cursor: v.string(),
    done: v.boolean(),
  }),
  handler: async (ctx, { cursor, only, apply, everyObject }) => {
    const answer = {
      workspaces: 0,
      skipped: 0,
      unreachable: 0,
      counts: emptyRepairCounts() as RepairCounts,
      shapes: {} as Record<string, number>,
      why: {} as Record<string, number>,
    };
    const state = await startState(ctx, cursor, only);
    if (state === "NO_WORKSPACE") return { ...answer, refused: "NO_WORKSPACE", cursor: "", done: true };
    const started = Date.now();
    const finishWorkspace = () => {
      state.queue.shift();
      state.at = undefined;
    };
    while (Date.now() - started < PAGE_BUDGET_MS) {
      const workspaceId = await nextWorkspace(ctx, state);
      if (workspaceId === null) return { ...answer, cursor: "", done: true };
      if (state.at === undefined) {
        const record = await ctx.runQuery(internal.functions.workspaceObjectsRows.recordFor, { workspaceId });
        const home = (record as { home?: string } | null)?.home ?? "bucket";
        if (home !== "object" || (everyObject !== true && !bodiesDiffered(record))) {
          if (home === "object") answer.skipped += 1;
          finishWorkspace();
          continue;
        }
        answer.workspaces += 1;
      }
      try {
        const bucket = await openBucket(ctx, workspaceId);
        const client = consoleWorkspaceClient(ctx, workspaceId, { caller: "workspaceObjectsRepair" });
        if (bucket === null || client === null) {
          answer.unreachable += 1;
          const label = `open:${bucket === null ? "no_bucket" : "no_object"}`;
          answer.why[label] = (answer.why[label] ?? 0) + 1;
          finishWorkspace();
          continue;
        }
        const object = withRetries(client.bodies as unknown as BodyStore, sleep);
        // One set of facts per call: a document settled by an earlier call is read again, as it now is.
        const facts = new Facts(object, async (key) => await ctx.runQuery(internal.functions.workspaceObjectsRows.rowReadsKey, { workspaceId, key }), {
          bucket,
          liveNotes: () => liveNotesOf(ctx, workspaceId),
        });
        let at = state.at ?? { prefix: 0 };
        let finished = false;
        while (Date.now() - started < PAGE_BUDGET_MS) {
          const page = await repairPage(bucket, object, {
            at,
            limit: KEYS_PER_PAGE,
            apply: apply === true,
            facts,
            onFailure: (error) => {
              const failure = failureOf(error);
              const why = `key:${failure.error}:${failure.reason}${failure.shape ? `#${failure.shape}` : ""}`;
              answer.why[why] = (answer.why[why] ?? 0) + 1;
            },
          });
          for (const [name, n] of Object.entries(page.counts)) answer.counts[name as keyof RepairCounts] += n;
          for (const [label, n] of Object.entries(page.shapes)) answer.shapes[label] = (answer.shapes[label] ?? 0) + n;
          if (page.next === null) {
            finished = true;
            break;
          }
          at = page.next;
        }
        if (!finished) {
          state.at = at;
          continue;
        }
      } catch (error) {
        answer.unreachable += 1;
        const failure = failureOf(error);
        const why = `${failure.error}:${failure.reason}${failure.shape ? `#${failure.shape}` : ""}`;
        answer.why[why] = (answer.why[why] ?? 0) + 1;
      }
      finishWorkspace();
    }
    return { ...answer, cursor: JSON.stringify(state), done: false };
  },
});

/** Keys a recent-writes repair settles in one call, at most. */
const RECENT_KEYS = 2000;

/**
 * The same rules over only the notes one workspace wrote after `since` (ms), read from the tree's `observedAt`
 * index rather than by walking the bucket: a run that finishes in seconds where the whole walk takes many minutes.
 * Written for 2026-11-02, when the app's writes in an object-home workspace reached its bucket alone; the whole walk
 * remains the check that nothing else differs. Counts only.
 */
export const repairRecent = internalAction({
  args: { only: v.string(), since: v.number(), apply: v.optional(v.boolean()) },
  returns: v.object({
    keys: v.number(),
    complete: v.boolean(),
    counts: repairCountsValidator,
    why: v.record(v.string(), v.number()),
    refused: v.optional(v.string()),
  }),
  handler: async (ctx, { only, since, apply }): Promise<{ keys: number; complete: boolean; counts: RepairCounts; why: Record<string, number>; refused?: string }> => {
    const counts = emptyRepairCounts() as RepairCounts;
    const why: Record<string, number> = {};
    const workspaceId: Id<"workspaces"> | null = await ctx.runQuery(internal.functions.workspaceObjectsRows.workspaceBySlug, { slug: only });
    if (workspaceId === null) return { keys: 0, complete: true, counts, why, refused: "NO_WORKSPACE" };
    const record = await ctx.runQuery(internal.functions.workspaceObjectsRows.recordFor, { workspaceId });
    if ((record as { home?: string } | null)?.home !== "object") return { keys: 0, complete: true, counts, why, refused: "NOT_OBJECT_HOME" };
    const bucket = await openBucket(ctx, workspaceId);
    const client = consoleWorkspaceClient(ctx, workspaceId, { caller: "workspaceObjectsRepair" });
    if (bucket === null || client === null) return { keys: 0, complete: true, counts, why, refused: "UNREACHABLE" };
    const object = withRetries(client.bodies as unknown as BodyStore, sleep);
    const { keys, complete }: { keys: string[]; complete: boolean } = await ctx.runQuery(internal.functions.workspaceObjectsRows.keysWrittenSince, { workspaceId, since, limit: RECENT_KEYS });
    const facts = new Facts(object, async (key: string): Promise<boolean> => await ctx.runQuery(internal.functions.workspaceObjectsRows.rowReadsKey, { workspaceId, key }), {
      bucket,
      liveNotes: () => liveNotesOf(ctx, workspaceId),
    });
    for (let start = 0; start < keys.length; start += 8) {
      await Promise.all(
        keys.slice(start, start + 8).map(async (key) => {
          counts.listed += 1;
          try {
            const { verdict, done } = await settleKey(bucket, object, key, facts, apply === true);
            counts[verdict] += 1;
            if (done !== null) counts[done] += 1;
          } catch (error) {
            counts.failed += 1;
            const failure = failureOf(error);
            const label = `key:${failure.error}:${failure.reason}`;
            why[label] = (why[label] ?? 0) + 1;
          }
        }),
      );
    }
    return { keys: keys.length, complete, counts, why };
  },
});
