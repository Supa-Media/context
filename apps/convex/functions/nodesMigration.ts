/**
 * The staff view of the backend migration (`docs/decisions/app-and-console/
 * convex-tree.md`): where every workspace's Convex tree is, and the switch
 * that starts and stops it. Shown in admin › Search › Indexes.
 *
 * Asked for by the owner, 2026-10-12 ("visibility into the migration status
 * for the current users … being able to start and stop"). Counts, times and
 * fixed labels only: never a path, never a note's name.
 *
 * Every public function here checks staff first. Starting work only schedules
 * the credential barrier (`files.runFileOperation`), which the structure
 * tests allow a public function to trigger and never to read from.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { query, type MutationCtx, type QueryCtx } from "../_generated/server";
import { internalMutation, mutation } from "./lib/rowWatch/mutations";
import { requireAdmin } from "./lib/admin";
import { toConvexError } from "./lib/adminFns/errors";
import { workspaceArchived } from "./lib/archivedWorkspaces";
import { FACT_LEASE_MS, factStateRow, factsDue } from "./lib/nodes/facts";
import { treeServesNow } from "./lib/nodes/listing";
import { migrationPaused } from "./lib/nodes/pause";
import { requestSmallDataSync } from "./lib/smallData/state";
import { startIfDue } from "./pinnedAccounts";

/**
 * Which migration phase this deployment runs. Phase 3: the privacy rules held
 * here can be made the authority, with `privacy.md` written from them.
 */
export const MIGRATION_PHASE = 3;
/** Workspaces one report or one start reads: a bound on a loop, not on any deployment we have. */
export const MIGRATION_ROWS = 500;

export async function staffOnly(ctx: QueryCtx): Promise<Id<"users">> {
  try {
    return (await requireAdmin(ctx)).userId;
  } catch (error) {
    throw toConvexError(error);
  }
}

/** Every workspace with storage, a workspace once however many bindings it has. */
export async function boundWorkspaces(ctx: QueryCtx): Promise<{ ids: Id<"workspaces">[]; truncated: boolean }> {
  const ids: Id<"workspaces">[] = [];
  const seen = new Set<string>();
  let truncated = false;
  for await (const binding of ctx.db.query("storageBindings")) {
    if (seen.has(binding.workspaceId)) continue;
    if (ids.length === MIGRATION_ROWS) {
      truncated = true;
      break;
    }
    seen.add(binding.workspaceId);
    ids.push(binding.workspaceId);
  }
  return { ids, truncated };
}

/**
 * The bound workspaces the rounds and the all-workspaces buttons start work
 * on: every one but those only archived accounts hold (`lib/archivedWorkspaces.ts`).
 * One workspace's own button still reaches an archived one.
 */
export async function liveBoundWorkspaces(ctx: QueryCtx): Promise<Id<"workspaces">[]> {
  const live: Id<"workspaces">[] = [];
  for (const workspaceId of (await boundWorkspaces(ctx)).ids) {
    if (!(await workspaceArchived(ctx.db, workspaceId))) live.push(workspaceId);
  }
  return live;
}

const rowValidator = v.object({
  workspaceId: v.id("workspaces"),
  slug: v.union(v.string(), v.null()),
  /** Only archived accounts hold it, so no round starts work on it. */
  archived: v.boolean(),
  /**
   * The facts fill (`lib/nodes/facts.ts`): the links, front matter and chaos
   * details Lists, Boards, the map and the chaos score read. `null` before
   * its first pass. `ready` once it has read every note; `retrying` counts
   * notes whose read failed and is tried again; `retryKind` says why most
   * failed (`readFailure.js`) and `retryPasses` how many passes in a row did.
   */
  facts: v.union(
    v.null(),
    v.object({
      ready: v.boolean(),
      running: v.boolean(),
      retrying: v.number(),
      retryKind: v.union(v.string(), v.null()),
      retryPasses: v.number(),
    }),
  ),
});

function factsOf(row: Doc<"nodeFactState"> | null, now: number) {
  if (row === null) return null;
  return {
    ready: row.ready,
    running: row.leaseAt !== undefined && now - row.leaseAt < FACT_LEASE_MS,
    retrying: row.retry?.length ?? 0,
    retryKind: row.retryKind ?? null,
    retryPasses: row.retryPasses ?? 0,
  };
}

/** Where the migration is, for every workspace with storage. */
export const report = query({
  args: {},
  returns: v.object({
    phase: v.number(),
    paused: v.boolean(),
    changedAt: v.union(v.number(), v.null()),
    rows: v.array(rowValidator),
    truncated: v.boolean(),
  }),
  handler: async (ctx) => {
    await staffOnly(ctx);
    const switchRow = await ctx.db.query("nodeMigration").first();
    const { ids, truncated } = await boundWorkspaces(ctx);
    const now = Date.now();
    const rows = [];
    for (const workspaceId of ids) {
      const workspace = await ctx.db.get(workspaceId);
      if (workspace === null) continue;
      rows.push({
        workspaceId,
        slug: workspace.slug ?? null,
        archived: await workspaceArchived(ctx.db, workspace),
        facts: factsOf(await factStateRow(ctx.db, workspaceId), now),
      });
    }
    return {
      phase: MIGRATION_PHASE,
      paused: switchRow?.paused === true,
      changedAt: switchRow?.updatedAt ?? null,
      rows,
      truncated,
    };
  },
});

/**
 * Stop or resume the migration: while paused, the facts fill (`lib/nodes/run.ts`)
 * holds. Resuming starts nothing: each fill is scheduled by the change or read
 * that needs it, and the cron's backstop (`keepCurrent`) finds what is owed.
 */
export const setPaused = mutation({
  args: { paused: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { paused }) => {
    const userId = await staffOnly(ctx);
    const existing = await ctx.db.query("nodeMigration").first();
    const fields = { paused, updatedAt: Date.now(), updatedBy: userId };
    if (existing === null) await ctx.db.insert("nodeMigration", fields);
    else await ctx.db.patch(existing._id, fields);
    return null;
  },
});


/**
 * The cron that keeps each workspace's icons, emoji and forwarding current
 * (`crons.ts`), and starts the facts fill a served tree is owed. Does nothing
 * for the facts while paused.
 */
export const keepCurrent = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    // Each workspace's icons, emoji and forwarding: imported once, and their files written where owed.
    for (const workspaceId of await liveBoundWorkspaces(ctx)) await requestSmallDataSync(ctx, workspaceId);
    if (await migrationPaused(ctx.db)) return null;
    // The pinned workspace's one-off move to "team means members", started here after a deploy (`pinnedAccounts.ts`).
    await startIfDue(ctx);
    await startDueFactFills(ctx);
    return null;
  },
});

/**
 * Start the facts fill (`lib/nodes/facts.ts`) wherever a served tree's links
 * and front matter are behind it and no pass holds them: a backstop for the
 * fills each change schedules, and the first fill of every tree
 * served before the facts existed.
 */
async function startDueFactFills(ctx: MutationCtx): Promise<void> {
  const ids = await liveBoundWorkspaces(ctx);
  const now = Date.now();
  for (const workspaceId of ids) {
    if (!(await treeServesNow(ctx.db, workspaceId))) continue;
    if (!(await factsDue(ctx.db, workspaceId, now))) continue;
    await ctx.scheduler.runAfter(0, internal.functions.files.runFileOperation, {
      workspaceId,
      scope: "private",
      operation: { kind: "nodesFactFill" },
    });
  }
}
