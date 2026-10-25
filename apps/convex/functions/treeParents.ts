/**
 * The check that every keyed workspace's rows say their paths through their
 * parents (`lib/nodes/parentCheck.ts`; `paths-on-read.md`, "Every row's parent
 * and name are its path"): the backfill stage 4 rests on, before any path is
 * built from parents when read.
 *
 * A cron (`checkDue`) starts each keyed workspace not yet done; a page
 * (`checkWorkspace`) checks the next rows in path order, sets right what it can,
 * records where it got, and schedules the next page. A walk that reaches the
 * end having set something right is walked again from the next cron tick,
 * since a move during it can carry a row past the position; a walk that sets
 * nothing right finishes the check. `report` gives the totals as counts for the `Tree parents` workflow.
 * Nothing here reaches a bucket.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx } from "../_generated/server";
import { checkParents } from "./lib/nodes/parentCheck";
import { pathsBuilt } from "./lib/nodes/paths";

/** Rows one page reads. */
export const PARENT_PAGE = 300;
/** A page this recent holds its workspace; a chain that stopped is taken over after it. */
export const PARENTS_LEASE_MS = 10 * 60 * 1000;
/** Workspaces one cron tick looks at. */
const WORKSPACE_PAGE = 50;

async function stateOf(ctx: MutationCtx, workspaceId: Id<"workspaces">): Promise<Doc<"treeParents"> | null> {
  return await ctx.db
    .query("treeParents")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
}

const held = (state: Doc<"treeParents">, now: number) => state.leaseAt !== undefined && now - state.leaseAt < PARENTS_LEASE_MS;

/** Every keyed workspace not done, and not held by a running chain, gets one. */
export const checkDue = internalMutation({
  args: { cursor: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { cursor }) => {
    const now = Date.now();
    const page = await ctx.db.query("noteIdCopies").paginate({ cursor: cursor ?? null, numItems: WORKSPACE_PAGE });
    for (const copies of page.page) {
      if (copies.keyedAt === undefined) continue;
      const state = await stateOf(ctx, copies.workspaceId);
      if (state !== null && (state.done || held(state, now))) continue;
      await ctx.scheduler.runAfter(0, internal.functions.treeParents.checkWorkspace, { workspaceId: copies.workspaceId, now });
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.functions.treeParents.checkDue, { cursor: page.continueCursor });
    return null;
  },
});

/**
 * One page, then the next is scheduled. `now` is the lease the scheduler handed this page: a page whose lease
 * another chain has since taken stops, so two chains never walk one workspace.
 */
export const checkWorkspace = internalMutation({
  args: { workspaceId: v.id("workspaces"), now: v.number() },
  returns: v.null(),
  handler: async (ctx, { workspaceId, now }) => {
    let state = await stateOf(ctx, workspaceId);
    if (state === null) {
      const id = await ctx.db.insert("treeParents", {
        workspaceId,
        walks: 0,
        walkRepaired: 0,
        repairedNames: 0,
        repairedParents: 0,
        orphans: 0,
        duplicates: 0,
        walkOrphans: 0,
        walkHiddenOrphans: 0,
        walkDuplicates: 0,
        rows: 0,
        walkRows: 0,
        done: false,
        leaseAt: now,
        updatedAt: now,
      });
      state = (await ctx.db.get(id))!;
    }
    if (state.done) return null;
    // Another chain holds it: its lease is newer than the one this page was handed.
    if (state.leaseAt !== undefined && state.leaseAt !== now && held(state, now)) return null;
    const at = Date.now();
    // Built paths read parents as the truth, and a moved folder's rows keep the path they had: set from that, they
    // would point every row beneath it back at where the folder was. There is nothing left for this check to do.
    if (await pathsBuilt(ctx.db, workspaceId)) {
      await ctx.db.patch(state._id, {
        done: true,
        after: undefined,
        leaseAt: undefined,
        updatedAt: at,
      });
      return null;
    }
    const page = await checkParents(ctx, workspaceId, state.after, PARENT_PAGE);
    const repaired = page.repairedNames + page.repairedParents;
    const walk = {
      walkRepaired: state.walkRepaired + repaired,
      walkOrphans: state.walkOrphans + page.orphans,
      walkHiddenOrphans: (state.walkHiddenOrphans ?? 0) + page.hiddenOrphans,
      walkDuplicates: state.walkDuplicates + page.duplicates,
      walkRows: state.walkRows + page.rows,
    };
    const totals = { repairedNames: state.repairedNames + page.repairedNames, repairedParents: state.repairedParents + page.repairedParents };
    if (page.last !== null) {
      await ctx.db.patch(state._id, { ...walk, ...totals, after: page.last, leaseAt: at, updatedAt: at });
      await ctx.scheduler.runAfter(0, internal.functions.treeParents.checkWorkspace, { workspaceId, now: at });
      return null;
    }
    // The walk reached the end: what it found is the workspace's answer, and it is done only if it set nothing right.
    const done = walk.walkRepaired === 0;
    await ctx.db.patch(state._id, {
      ...totals,
      walks: state.walks + 1,
      orphans: walk.walkOrphans,
      hiddenOrphans: walk.walkHiddenOrphans,
      duplicates: walk.walkDuplicates,
      rows: walk.walkRows,
      after: undefined,
      walkRepaired: 0,
      walkOrphans: 0,
      walkHiddenOrphans: 0,
      walkDuplicates: 0,
      walkRows: 0,
      done,
      leaseAt: undefined,
      updatedAt: at,
    });
    return null;
  },
});

/**
 * Totals for the `Tree parents` workflow, whose log is public: counts only, never a workspace, a path or a time.
 * `orphans` and `duplicates` are the done workspaces' last walks: rows a path built from parents could not reach.
 */
export const report = internalQuery({
  args: {},
  returns: v.object({
    keyedWorkspaces: v.number(),
    done: v.number(),
    running: v.number(),
    notStarted: v.number(),
    rows: v.number(),
    repairedNames: v.number(),
    repairedParents: v.number(),
    orphans: v.number(),
    hiddenOrphans: v.number(),
    duplicates: v.number(),
    doneWithOrphans: v.number(),
  }),
  handler: async (ctx) => {
    const now = Date.now();
    const answer = {
      keyedWorkspaces: 0,
      done: 0,
      running: 0,
      notStarted: 0,
      rows: 0,
      repairedNames: 0,
      repairedParents: 0,
      orphans: 0,
      hiddenOrphans: 0,
      duplicates: 0,
      doneWithOrphans: 0,
    };
    for await (const copies of ctx.db.query("noteIdCopies")) {
      if (copies.keyedAt === undefined) continue;
      answer.keyedWorkspaces += 1;
      const state = await ctx.db
        .query("treeParents")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", copies.workspaceId))
        .unique();
      if (state === null) {
        answer.notStarted += 1;
        continue;
      }
      answer.repairedNames += state.repairedNames;
      answer.repairedParents += state.repairedParents;
      if (state.done) {
        answer.done += 1;
        answer.rows += state.rows;
        answer.orphans += state.orphans;
        answer.hiddenOrphans += state.hiddenOrphans ?? 0;
        answer.duplicates += state.duplicates;
        if (state.orphans + state.duplicates > 0) answer.doneWithOrphans += 1;
      } else if (held(state, now)) answer.running += 1;
      else answer.notStarted += 1;
    }
    return answer;
  },
});
