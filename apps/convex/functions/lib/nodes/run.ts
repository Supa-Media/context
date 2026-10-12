/**
 * The Convex tree's bucket-side work, run inside the credential barrier
 * (`lib/filesFns/fileOperationBarrier.ts`) because each piece needs the
 * bucket:
 *
 *  - `nodesSweep`: one bounded pass of listing the bucket into `nodes`
 *    (`sweep.ts`), chained until it finishes.
 *  - `nodesTouch`: re-check the paths a change named (`touch.ts`). A change too
 *    big to re-check asks for a sweep instead.
 *  - `nodesParity`: compare the rows with the bucket at every clearance
 *    (`parity.ts`) and keep the answer on the workspace's `nodeTrees` row.
 *
 * Phase 1 of `docs/decisions/app-and-console/convex-tree.md` is a shadow: the
 * scheduling helpers here swallow every error, because a shadow must never
 * fail a person's change.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import type { FileStore } from "../fileOps";
import type { FileOperation, OperationResult } from "../filesFns/operationTypes";
import { checkParity } from "./parity";
import { type NodeListingStore, sweepNodesPass } from "./sweep";
import { touchNodes } from "./touch";
import { type NodeSink, NODE_SWEEP_CHAIN, type Observation, nodeSweepDue } from "./table";

export type NodesOperation = Extract<FileOperation, { kind: "nodesSweep" | "nodesTouch" | "nodesParity" }>;

export function isNodesOperation(operation: { kind: string }): operation is NodesOperation {
  return operation.kind === "nodesSweep" || operation.kind === "nodesTouch" || operation.kind === "nodesParity";
}

/** Live rows one `listLive` page reads. */
const LIVE_PAGE = 2000;
/** Rounds one observation's vanish scan may take (`VANISH_SCAN` rows each). A bound on a loop, not on a workspace. */
const OBSERVE_ROUNDS = 5_000;

/** The sweep's `NodeSink`: each method is one call of `functions/nodes.ts`, for this workspace. */
function sinkFor(ctx: ActionCtx, workspaceId: Id<"workspaces">): NodeSink {
  return {
    state: () => ctx.runQuery(internal.functions.nodes.state, { workspaceId }),
    begin: (at) => ctx.runMutation(internal.functions.nodes.begin, { workspaceId, at }),
    // `observe` answers `more` when its vanish scan ran out of budget, with
    // where it stopped: the scan resumes there until the prefixes are done.
    observe: async (observation: Observation) => {
      let vanishCursor: { index: number; after?: string } | undefined;
      for (let round = 0; round < OBSERVE_ROUNDS; round += 1) {
        const answer = await ctx.runMutation(internal.functions.nodes.observe, { workspaceId, ...observation, vanishCursor });
        if (!answer.more) return;
        vanishCursor = answer.vanishCursor;
      }
      throw new Error("observe did not settle");
    },
    progress: async (cursor, at) => {
      await ctx.runMutation(internal.functions.nodes.progress, { workspaceId, cursor, at });
    },
    prune: (startedAt) => ctx.runMutation(internal.functions.nodes.prune, { workspaceId, startedAt }),
    finish: async (at) => {
      let files = 0;
      let after: string | undefined;
      for (;;) {
        const counted = await ctx.runQuery(internal.functions.nodes.countLive, { workspaceId, after });
        files += counted.count;
        if (!counted.cursor || counted.cursor === after) break;
        after = counted.cursor;
      }
      await ctx.runMutation(internal.functions.nodes.finish, { workspaceId, at, files });
    },
    unsupported: async () => {
      await ctx.runMutation(internal.functions.nodes.unsupported, { workspaceId });
    },
    dirty: async () => {
      await ctx.runMutation(internal.functions.nodes.dirty, { workspaceId });
    },
    fail: async (label) => {
      await ctx.runMutation(internal.functions.nodes.fail, { workspaceId, label });
    },
    privacy: () => ctx.runQuery(internal.functions.nodes.privacy, { workspaceId }),
    savePrivacy: async (mirror, at) => {
      await ctx.runMutation(internal.functions.nodes.savePrivacy, { workspaceId, mirror, at });
    },
  };
}

/**
 * The bucket reads a sweep or a re-check makes, with a path-free log line when
 * a listing fails. A method wrapper rather than a spread: a store may be a
 * class instance, whose methods a spread would not carry.
 */
function listingOf(workspaceId: Id<"workspaces">, store: FileStore): NodeListingStore {
  return {
    list: async (options: Parameters<FileStore["list"]>[0]) => {
      try {
        return await store.list(options);
      } catch (error) {
        // Storage errors may contain bucket names or note paths.
        console.error("nodes.list_failed", { workspaceId });
        throw error;
      }
    },
    get: (...args: Parameters<FileStore["get"]>) => store.get(...args),
  };
}

/** Every live row of the workspace, read in pages. */
async function readAllLive(ctx: ActionCtx, workspaceId: Id<"workspaces">) {
  let page = await ctx.runQuery(internal.functions.nodes.listLive, { workspaceId, limit: LIVE_PAGE });
  const rows = [...page.rows];
  while (page.cursor && page.rows.length > 0) {
    const after = page.cursor;
    page = await ctx.runQuery(internal.functions.nodes.listLive, { workspaceId, after, limit: LIVE_PAGE });
    rows.push(...page.rows);
    if (page.cursor === after) break;
  }
  return rows;
}

/** Run one `nodesSweep`, `nodesTouch` or `nodesParity` with the bucket the barrier opened. */
export async function runNodesOperation(
  ctx: ActionCtx,
  args: { workspaceId: Id<"workspaces">; scope: "private" | "team"; operation: NodesOperation },
  store: FileStore,
): Promise<OperationResult> {
  const { workspaceId, operation } = args;
  const sink = sinkFor(ctx, workspaceId);
  const listing = listingOf(workspaceId, store);

  // Paused by staff: a sweep stops here (its chain with it) and a re-check
  // only marks the tree dirty, so resuming catches up. Parity still runs.
  if (operation.kind !== "nodesParity" && (await ctx.runQuery(internal.functions.nodes.paused, {}))) {
    if (operation.kind === "nodesTouch") await sink.dirty().catch(() => {});
    return { kind: "nodesKept", complete: false };
  }

  if (operation.kind === "nodesSweep") {
    const passes = Math.floor(operation.passes ?? 0);
    let pass: Awaited<ReturnType<typeof sweepNodesPass>>;
    try {
      pass = await sweepNodesPass(listing, sink, {});
    } catch {
      console.error("nodes.sweep_failed", { workspaceId });
      await sink.fail("Tree sweep failed; inspect service logs").catch(() => {});
      return { kind: "nodesKept", complete: false };
    }
    if (!pass.complete && !pass.unsupported && pass.rows + pass.pages > 0 && passes + 1 < NODE_SWEEP_CHAIN) {
      await ctx.scheduler
        .runAfter(0, internal.functions.files.runFileOperation, {
          workspaceId,
          scope: "private",
          operation: { kind: "nodesSweep", passes: passes + 1 },
        })
        .catch(() => {});
    }
    return { kind: "nodesKept", complete: pass.complete };
  }

  if (operation.kind === "nodesTouch") {
    try {
      const { dirty } = await touchNodes(listing, sink, { paths: operation.paths, files: operation.files });
      if (dirty) await ctx.runMutation(internal.functions.nodes.requestSweep, { workspaceId });
      return { kind: "nodesKept", complete: !dirty };
    } catch {
      // A re-check that failed leaves the rows behind the bucket; a sweep repairs that.
      console.error("nodes.touch_failed", { workspaceId });
      await ctx.runMutation(internal.functions.nodes.requestSweep, { workspaceId }).catch(() => {});
      return { kind: "nodesKept", complete: false };
    }
  }

  const rows = await readAllLive(ctx, workspaceId);
  const mirror = await ctx.runQuery(internal.functions.nodes.privacy, { workspaceId });
  const result = await checkParity(store, rows, mirror);
  const parity = {
    checkedAt: Date.now(),
    clearances: result.clearances,
    mismatches: result.mismatches,
    privacyMatches: result.privacyMatches,
  };
  await ctx.runMutation(internal.functions.nodes.saveParity, { workspaceId, parity });
  return {
    kind: "nodesParity",
    clearances: parity.clearances,
    mismatches: parity.mismatches,
    privacyMatches: parity.privacyMatches,
  };
}

/**
 * After a change the barrier made: re-check the paths and files it named.
 * Scheduled, so the change never waits for it; errors are swallowed.
 */
export async function scheduleNodesTouch(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  change: { paths: string[]; files: string[] },
): Promise<void> {
  try {
    await ctx.scheduler.runAfter(0, internal.functions.files.runFileOperation, {
      workspaceId,
      scope: "private",
      operation: { kind: "nodesTouch", paths: change.paths, files: change.files },
    });
  } catch {
    // A shadow never fails a change. The next sweep repairs what this missed.
  }
}

/**
 * On a walk of the tree, start a sweep if one is due. Errors are swallowed:
 * the walk goes on whether or not the shadow could be started.
 */
export async function startNodesSweepIfDue(ctx: ActionCtx, workspaceId: Id<"workspaces">): Promise<void> {
  try {
    const state = await ctx.runQuery(internal.functions.nodes.state, { workspaceId });
    if (!nodeSweepDue(state, Date.now())) return;
    if (await ctx.runQuery(internal.functions.nodes.paused, {})) return;
    await ctx.scheduler.runAfter(0, internal.functions.files.runFileOperation, {
      workspaceId,
      scope: "private",
      operation: { kind: "nodesSweep" },
    });
  } catch {
    // A shadow never fails a walk.
  }
}
