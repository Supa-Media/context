/**
 * Every workspace on notes by id: the count, the push and the proof
 * (owner, 2026-10-22: "make sure that new and current workspaces are all
 * notes by id").
 *
 * Run by the `Notes by id for every workspace` workflow through
 * `npx convex run`, page by page:
 *
 *  - `run` reads each workspace's id-copy state and says where it is, by fixed
 *    label. With `dryRun: false` it also starts what is owed: a first pass, a
 *    pass again after failures, a stalled page, or the flip of a finished
 *    copy. Archived workspaces are counted and pushed too: path-keyed code is
 *    to be deleted, and nothing may be left needing it.
 *  - `verify` reads the tree rows and counts live notes that are still not at
 *    their id keys, so "every workspace keyed" is checked against the rows
 *    themselves and not only against the copy rows' word.
 *
 * Both answer with counts only, never a path, an id or a name: this
 * repository is public, and so is the job's log.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { internalMutation, internalQuery } from "../_generated/server";
import { workspaceArchived } from "./lib/archivedWorkspaces";
import { owesKey } from "./lib/noteIds/flip";
import { beginCopyPass, copyRowOf, leaseHeld } from "./lib/noteIds/state";

/** Workspaces one `run` page reads. Each costs a handful of reads and at most one scheduled job. */
export const RUN_PAGE = 50;

/** Tree rows one `verify` page reads. */
export const VERIFY_PAGE = 2_000;

/** Where one workspace is on the way to keyed. Fixed labels; the workflow prints their counts. */
export type Stage =
  | "no_storage"
  | "keyed"
  | "flipping"
  | "ready_to_flip"
  | "copying"
  | "stalled"
  | "failed"
  | "incomplete"
  | "not_started"
  | "tree_not_ready";

const STAGES: Stage[] = [
  "no_storage",
  "keyed",
  "flipping",
  "ready_to_flip",
  "copying",
  "stalled",
  "failed",
  "incomplete",
  "not_started",
  "tree_not_ready",
];

const countsValidator = v.object(Object.fromEntries(STAGES.map((stage) => [stage, v.number()])) as Record<Stage, ReturnType<typeof v.number>>);

function emptyCounts(): Record<Stage, number> {
  return Object.fromEntries(STAGES.map((stage) => [stage, 0])) as Record<Stage, number>;
}

/**
 * The stage of one workspace, from its binding, tree state and copy row. Keyed
 * means the switch is at `keys` and the flip found no row left (`keyedDoneAt`).
 */
export function stageOf(input: {
  bound: boolean;
  mode: string;
  treeReady: boolean;
  row: Doc<"noteIdCopies"> | null;
  now: number;
}): Stage {
  const { bound, mode, treeReady, row, now } = input;
  if (!bound) return "no_storage";
  if (mode === "keys" && row?.keyedAt !== undefined) return row.keyedDoneAt !== undefined ? "keyed" : "flipping";
  if (!treeReady) return "tree_not_ready";
  if (row === null || row.status === "idle") return "not_started";
  if (row.status === "copying") return leaseHeld(row, now) ? "copying" : "stalled";
  if (row.status === "failed" || row.failed > 0) return "failed";
  if (row.copied !== row.files) return "incomplete";
  return "ready_to_flip";
}

/**
 * One page of workspaces: each one's stage, and with `dryRun: false` what was
 * started. `cursor` is the `cursor` of the page before; `done` once the last
 * page is read. Refuses to start anything unless the switch is at `keys` and
 * the copy is not paused, and says why. INTERNAL.
 */
export const run = internalMutation({
  args: { dryRun: v.boolean(), cursor: v.optional(v.string()) },
  returns: v.object({
    mode: v.string(),
    paused: v.boolean(),
    read: v.number(),
    archived: v.number(),
    stages: countsValidator,
    started: v.number(),
    /** Why nothing was started on a page that owed work, or null. */
    refused: v.union(v.string(), v.null()),
    cursor: v.string(),
    done: v.boolean(),
  }),
  handler: async (ctx, { dryRun, cursor }) => {
    const layout = await ctx.db.query("noteIdLayout").first();
    const mode = layout?.mode ?? "paths";
    const paused = layout?.paused === true;
    const page = await ctx.db.query("workspaces").paginate({ numItems: RUN_PAGE, cursor: cursor ?? null });
    const stages = emptyCounts();
    const now = Date.now();
    let archived = 0;
    let started = 0;
    let owed = false;
    const refusal = mode !== "keys" ? "switch_not_at_keys" : paused ? "paused" : null;
    for (const workspace of page.page) {
      const workspaceId = workspace._id;
      const binding = await ctx.db
        .query("storageBindings")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .first();
      const tree = await ctx.db
        .query("nodeTrees")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique();
      const row = await copyRowOf(ctx.db, workspaceId);
      const stage = stageOf({ bound: binding !== null, mode, treeReady: tree?.status === "ready", row, now });
      stages[stage] += 1;
      if (await workspaceArchived(ctx.db, workspaceId)) archived += 1;
      if (stage === "keyed" || stage === "no_storage" || stage === "copying" || stage === "tree_not_ready") continue;
      owed = true;
      if (dryRun || refusal !== null) continue;
      // Start what the stage owes. Written here, not in a module-level helper: the structure tests attribute a
      // helper's scheduling to every export, and `verify` reaches no bucket.
      if (stage === "not_started" || stage === "failed" || stage === "incomplete") {
        // A pass from the beginning: every row gets an id, then every stale copy is made. Its end flips the workspace.
        await ctx.scheduler.runAfter(0, internal.functions.noteIdsCopy.backfill, { workspaceId });
        if (await beginCopyPass(ctx, workspaceId, { force: stage !== "not_started" })) started += 1;
      } else if (stage === "stalled" && row !== null) {
        await ctx.scheduler.runAfter(0, internal.functions.noteIdsCopy.run, { workspaceId, runId: row.runId });
        started += 1;
      } else if (stage === "flipping") {
        // A flip that stopped with rows left needs a fresh copy of them first: the pass's end flips again.
        if (await beginCopyPass(ctx, workspaceId, { force: false })) started += 1;
      } else if (stage === "ready_to_flip") {
        await ctx.scheduler.runAfter(0, internal.functions.noteIdsCopy.flip, { workspaceId });
        started += 1;
      }
    }
    return {
      mode,
      paused,
      read: page.page.length,
      archived,
      stages,
      started,
      refused: owed && !dryRun ? refusal : null,
      cursor: page.continueCursor,
      done: page.isDone,
    };
  },
});

/**
 * One page of tree rows, in table order: how many live notes are not at their
 * id keys (`owesKey`: a live file that is not plumbing and has no
 * `storageKey`), and how many of those sit in a workspace that says it is
 * keyed, which is the one that would be lost when path keys are deleted.
 * INTERNAL.
 */
export const verify = internalQuery({
  args: { cursor: v.optional(v.string()) },
  returns: v.object({
    read: v.number(),
    liveNotes: v.number(),
    unkeyed: v.number(),
    unkeyedInKeyed: v.number(),
    /** Distinct workspaces with an unkeyed note on this page (a workspace across two pages counts on each). */
    workspacesWithUnkeyed: v.number(),
    cursor: v.string(),
    done: v.boolean(),
  }),
  handler: async (ctx, { cursor }) => {
    const layout = await ctx.db.query("noteIdLayout").first();
    const page = await ctx.db.query("nodes").paginate({ numItems: VERIFY_PAGE, cursor: cursor ?? null });
    const keyedDone = new Map<string, boolean>();
    const withUnkeyed = new Set<string>();
    let liveNotes = 0;
    let unkeyed = 0;
    let unkeyedInKeyed = 0;
    for (const row of page.page) {
      if (row.kind !== "file" || row.goneAt !== undefined) continue;
      if (!owesKey(row)) {
        if (row.storageKey !== undefined) liveNotes += 1;
        continue;
      }
      liveNotes += 1;
      unkeyed += 1;
      withUnkeyed.add(row.workspaceId);
      let keyed = keyedDone.get(row.workspaceId);
      if (keyed === undefined) {
        const copies = await copyRowOf(ctx.db, row.workspaceId);
        keyed = layout?.mode === "keys" && copies?.keyedAt !== undefined;
        keyedDone.set(row.workspaceId, keyed);
      }
      if (keyed) unkeyedInKeyed += 1;
    }
    return {
      read: page.page.length,
      liveNotes,
      unkeyed,
      unkeyedInKeyed,
      workspacesWithUnkeyed: withUnkeyed.size,
      cursor: page.continueCursor,
      done: page.isDone,
    };
  },
});
