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

import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "../_generated/server";
import { requireAdmin } from "./lib/admin";
import { toConvexError } from "./lib/adminFns/errors";
import { workspaceArchived } from "./lib/archivedWorkspaces";
import { FACT_LEASE_MS, factStateRow, factsDue } from "./lib/nodes/facts";
import { treeServesNow } from "./lib/nodes/listing";
import { migrationPaused } from "./lib/nodes/pause";
import { NODE_SWEEP_LEASE_MS, nodeSweepDue, type NodeTreeState } from "./lib/nodes/table";
import { requestSmallDataSync } from "./lib/smallData/state";

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

function treeOf(ctx: QueryCtx, workspaceId: Id<"workspaces">): Promise<Doc<"nodeTrees"> | null> {
  return ctx.db
    .query("nodeTrees")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
}

function privacyOf(ctx: QueryCtx, workspaceId: Id<"workspaces">): Promise<Doc<"nodePrivacy"> | null> {
  return ctx.db
    .query("nodePrivacy")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
}

const stateOf = (row: Doc<"nodeTrees"> | null): NodeTreeState | null =>
  row === null
    ? null
    : {
        status: row.status,
        cursor: row.cursor,
        startedAt: row.startedAt,
        leaseAt: row.leaseAt,
        sweptAt: row.sweptAt,
        dirty: row.dirty,
        files: row.files,
        error: row.error,
      };

/**
 * One word for where a workspace is, the same word the console shows:
 * `waiting` (never started), `copying`, `stuck` (the last pass failed),
 * `copied` (swept, not checked against the bucket yet), `matches`,
 * `differs` (the last check found mismatches), `skipped` (a store that
 * can be listed neither in order nor by token, retried daily).
 */
export type MigrationStage = "waiting" | "copying" | "stuck" | "copied" | "matches" | "differs" | "skipped";

export function stageOf(row: Doc<"nodeTrees"> | null): MigrationStage {
  if (row === null || row.status === "empty") return row?.error ? "stuck" : "waiting";
  if (row.status === "unsupported") return "skipped";
  if (row.error !== undefined) return "stuck";
  if (row.status === "filling" || row.cursor !== undefined) return "copying";
  if (row.parity === undefined) return "copied";
  return row.parity.mismatches === 0 && row.parity.privacyMatches ? "matches" : "differs";
}

const stageValidator = v.union(
  v.literal("waiting"),
  v.literal("copying"),
  v.literal("stuck"),
  v.literal("copied"),
  v.literal("matches"),
  v.literal("differs"),
  v.literal("skipped"),
);

const rowValidator = v.object({
  workspaceId: v.id("workspaces"),
  slug: v.union(v.string(), v.null()),
  stage: stageValidator,
  files: v.number(),
  /** Only archived accounts hold it, so no round starts work on it. */
  archived: v.boolean(),
  /** A pass ran in the last few minutes. */
  running: v.boolean(),
  sweptAt: v.union(v.number(), v.null()),
  /** A change is waiting for the next sweep. */
  dirty: v.boolean(),
  /** A fixed, path-free label. */
  error: v.union(v.string(), v.null()),
  parity: v.union(
    v.null(),
    v.object({ checkedAt: v.number(), mismatches: v.number(), privacyMatches: v.boolean() }),
  ),
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
    /** The rules here are the authority, and `privacy.md` is their export. */
    privacyAuthority: v.boolean(),
    /** Workspaces whose `privacy.md` is still to be written from changed rules. */
    owedExports: v.number(),
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
    let owedExports = 0;
    for (const workspaceId of ids) {
      const workspace = await ctx.db.get(workspaceId);
      if (workspace === null) continue;
      const tree = await treeOf(ctx, workspaceId);
      if ((await privacyOf(ctx, workspaceId))?.exportOwed === true) owedExports += 1;
      rows.push({
        workspaceId,
        slug: workspace.slug ?? null,
        stage: stageOf(tree),
        files: tree?.files ?? 0,
        archived: await workspaceArchived(ctx.db, workspace),
        running: tree?.leaseAt !== undefined && now - tree.leaseAt < NODE_SWEEP_LEASE_MS,
        sweptAt: tree?.sweptAt ?? null,
        dirty: tree?.dirty ?? false,
        error: tree?.error ?? null,
        parity:
          tree?.parity === undefined
            ? null
            : { checkedAt: tree.parity.checkedAt, mismatches: tree.parity.mismatches, privacyMatches: tree.parity.privacyMatches },
        facts: factsOf(await factStateRow(ctx.db, workspaceId), now),
      });
    }
    return {
      phase: MIGRATION_PHASE,
      paused: switchRow?.paused === true,
      privacyAuthority: switchRow?.privacyAuthority === true,
      owedExports,
      changedAt: switchRow?.updatedAt ?? null,
      rows,
      truncated,
    };
  },
});

/** Schedule a sweep for each workspace that needs one and has none running. */
async function startSweeps(ctx: MutationCtx, ids: readonly Id<"workspaces">[]): Promise<number> {
  const now = Date.now();
  let started = 0;
  for (const workspaceId of ids) {
    const state = stateOf(await treeOf(ctx, workspaceId));
    // An unlistable store is tried again only once its day has passed (`nodeSweepDue`).
    if (state?.status === "unsupported" && !nodeSweepDue(state, now)) continue;
    // A pass that holds the lease is already running; a second would only double the work.
    if (state?.leaseAt !== undefined && now - state.leaseAt < NODE_SWEEP_LEASE_MS) continue;
    await ctx.scheduler.runAfter(0, internal.functions.files.runFileOperation, {
      workspaceId,
      scope: "private",
      operation: { kind: "nodesSweep" },
    });
    started += 1;
  }
  return started;
}

/**
 * Stop or resume the migration. Stopping takes effect at each sweep's next
 * pass. Resuming starts a sweep wherever one is due (never started, dirty,
 * interrupted, or stale), so nothing stopped mid-way is left behind.
 */
export const setPaused = mutation({
  args: { paused: v.boolean() },
  returns: v.object({ started: v.number() }),
  handler: async (ctx, { paused }) => {
    const userId = await staffOnly(ctx);
    const existing = await ctx.db.query("nodeMigration").first();
    const fields = { paused, updatedAt: Date.now(), updatedBy: userId };
    if (existing === null) await ctx.db.insert("nodeMigration", fields);
    else await ctx.db.patch(existing._id, fields);
    if (paused) return { started: 0 };
    return { started: await startDueSweeps(ctx) };
  },
});

/**
 * Make the rules held here the authority for `privacy.md`, or hand it back to
 * the file (phase 3). Handing it back waits until every changed rule has been
 * written to its workspace's file, so the file it hands back to is current.
 * Turning it on writes nothing: each workspace's file is already its rules'
 * export, and a file edited since is put back by the next listing that sees it.
 */
export const setPrivacyAuthority = mutation({
  args: { on: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { on }): Promise<null> => {
    const userId = await staffOnly(ctx);
    if (!on) {
      for await (const row of ctx.db.query("nodePrivacy")) {
        if (row.exportOwed === true) {
          throw new ConvexError({
            code: "EXPORTS_OWED",
            message: "Some privacy files are still being written. Try again in a minute.",
          });
        }
      }
    }
    const existing = await ctx.db.query("nodeMigration").first();
    const fields = { privacyAuthority: on, updatedAt: Date.now(), updatedBy: userId };
    if (existing === null) await ctx.db.insert("nodeMigration", { paused: false, ...fields });
    else await ctx.db.patch(existing._id, fields);
    return null;
  },
});

/** Start a sweep for every bound workspace whose copy is due: never started, dirty, interrupted, failed or stale. */
async function startDueSweeps(ctx: MutationCtx): Promise<number> {
  const ids = await liveBoundWorkspaces(ctx);
  const now = Date.now();
  const due: Id<"workspaces">[] = [];
  for (const workspaceId of ids) {
    if (nodeSweepDue(stateOf(await treeOf(ctx, workspaceId)), now)) due.push(workspaceId);
  }
  return await startSweeps(ctx, due);
}

/**
 * The cron that keeps every copy current (`crons.ts`), for workspaces nobody
 * has opened as well as new ones: a copy that is due is swept again, and one
 * whose last pass failed is retried. Does nothing while paused.
 */
export const keepCurrent = internalMutation({
  args: {},
  returns: v.object({ started: v.number() }),
  handler: async (ctx) => {
    // Each workspace's icons, emoji and forwarding: imported once, and their files written where owed.
    for (const workspaceId of await liveBoundWorkspaces(ctx)) await requestSmallDataSync(ctx, workspaceId);
    if (await migrationPaused(ctx.db)) return { started: 0 };
    const started = await startDueSweeps(ctx);
    await startDueFactFills(ctx);
    return { started };
  },
});

/**
 * Start the facts fill (`lib/nodes/facts.ts`) wherever a served tree's links
 * and front matter are behind it and no pass holds them: a backstop for the
 * fills each change and sweep schedule, and the first fill of every tree
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

/** Copy one workspace's tree again now, or every live workspace's when `workspaceId` is left out. */
export const start = mutation({
  args: { workspaceId: v.optional(v.id("workspaces")) },
  returns: v.object({ started: v.number() }),
  handler: async (ctx, { workspaceId }) => {
    await staffOnly(ctx);
    if (await migrationPaused(ctx.db)) {
      throw new ConvexError({ code: "MIGRATION_PAUSED", message: "The migration is paused. Resume it first." });
    }
    const ids = workspaceId === undefined ? await liveBoundWorkspaces(ctx) : [workspaceId];
    return { started: await startSweeps(ctx, ids) };
  },
});

/** Compare one workspace's copy with its bucket, or every live copied one's when `workspaceId` is left out. */
export const checkParity = mutation({
  args: { workspaceId: v.optional(v.id("workspaces")) },
  returns: v.object({ started: v.number() }),
  handler: async (ctx, { workspaceId }) => {
    await staffOnly(ctx);
    const ids = workspaceId === undefined ? await liveBoundWorkspaces(ctx) : [workspaceId];
    let started = 0;
    for (const id of ids) {
      const tree = await treeOf(ctx, id);
      if (tree?.status !== "ready") continue;
      await ctx.scheduler.runAfter(0, internal.functions.files.runFileOperation, {
        workspaceId: id,
        scope: "private",
        operation: { kind: "nodesParity" },
      });
      started += 1;
    }
    return { started };
  },
});
