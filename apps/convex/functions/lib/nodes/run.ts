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
 *  - `nodesPrivacyExport`: write `privacy.md` from the rules, where they are
 *    the authority and the last write of the file is owed (phase 3).
 *  - `nodesFactFill`: read the notes that changed and record their links and
 *    front matter (`factFill.ts`).
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
import { followPlacesAfter } from "./followPlaces";
import { runFactFill, scheduleFactFill } from "./factFill";
import { type LeftAudiences, type NodeSink, NODE_PARITY_CONFIRM_MS, NODE_SWEEP_CHAIN, type Observation, nodeSweepDue } from "./table";

export type NodesOperation = Extract<
  FileOperation,
  { kind: "nodesSweep" | "nodesTouch" | "nodesParity" | "nodesPrivacyExport" | "nodesFactFill" }
>;

export function isNodesOperation(operation: { kind: string }): operation is NodesOperation {
  return (
    operation.kind === "nodesSweep" ||
    operation.kind === "nodesTouch" ||
    operation.kind === "nodesParity" ||
    operation.kind === "nodesPrivacyExport" ||
    operation.kind === "nodesFactFill"
  );
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

  // Who sees what is not part of the copy, so a pause never holds it back.
  if (operation.kind === "nodesPrivacyExport") {
    const exportPrivacy = (store as FileStore & { exportPrivacy?: () => Promise<unknown> }).exportPrivacy;
    // Settled since it was asked for (the writer exported, or a later export did): nothing to write.
    if (!(await ctx.runQuery(internal.functions.nodesPrivacy.exportOwedNow, { workspaceId }))) {
      return { kind: "nodesKept", complete: true };
    }
    try {
      await exportPrivacy?.();
      return { kind: "nodesKept", complete: true };
    } catch {
      // The store has already marked it owed and asked for a retry.
      console.error("nodes.privacy_export_failed", { workspaceId });
      return { kind: "nodesKept", complete: false };
    }
  }

  // Paused by staff: copying work stops here, a sweep (its chain with it)
  // and a facts fill, and resuming starts what is due. A change's re-check
  // still runs, because every reader reads this tree (decided by the owner,
  // 2026-10-13: Pause no longer sends anyone to the bucket). Parity still runs.
  if (
    (operation.kind === "nodesSweep" || operation.kind === "nodesFactFill") &&
    (await ctx.runQuery(internal.functions.nodes.paused, {}))
  ) {
    return { kind: "nodesKept", complete: false };
  }

  if (operation.kind === "nodesFactFill") return await runFactFill(ctx, workspaceId, store, Math.floor(operation.passes ?? 0));

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
    // A finished sweep goes on to what the notes say.
    if (pass.complete) await scheduleFactFill(ctx, workspaceId);
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
      const { dirty } = await touchNodes(listing, sink, {
        paths: operation.paths,
        files: operation.files,
        ...(operation.left === undefined ? {} : { left: operation.left }),
      });
      if (dirty) await ctx.runMutation(internal.functions.nodes.requestSweep, { workspaceId });
      // What the changed notes now say, their links and front matter, read
      // with the bucket this re-check already opened.
      else await runFactFill(ctx, workspaceId, store, 0).catch(() => {});
      // An agent's moves: pins and recents follow them, as they follow the app's.
      await followPlacesAfter(ctx, workspaceId, store, operation.moves ?? []);
      return { kind: "nodesKept", complete: !dirty };
    } catch {
      // A re-check that failed leaves the rows behind the bucket; a sweep repairs that.
      console.error("nodes.touch_failed", { workspaceId });
      await ctx.runMutation(internal.functions.nodes.requestSweep, { workspaceId }).catch(() => {});
      return { kind: "nodesKept", complete: false };
    }
  }

  // While a queued move copies, rows and bucket change under the check; a
  // mismatch then is the copy in flight, and must not raise the alarm over
  // the move it is drawing. The check runs again at the next clearance.
  if ((await ctx.runQuery(internal.functions.nodeMoves.active, { workspaceId })).length > 0) {
    return { kind: "nodesKept", complete: false };
  }
  const rows = await readAllLive(ctx, workspaceId);
  const mirror = await ctx.runQuery(internal.functions.nodes.privacy, { workspaceId });
  const result = await checkParity(store, rows, mirror);
  // The check walks the bucket and then the tree, so a write landing between
  // the two (its re-check a second or so behind it) reads as a difference.
  // Asked once more before it raises the alarm, by when that write has
  // reached the tree: only a difference that stays is recorded.
  const differs = result.mismatches > 0 || !result.privacyMatches;
  if (differs && operation.confirm !== true) {
    const scheduled = await ctx.scheduler
      .runAfter(NODE_PARITY_CONFIRM_MS, internal.functions.files.runFileOperation, {
        workspaceId,
        scope: "private",
        operation: { kind: "nodesParity", confirm: true },
      })
      .then(() => true)
      .catch(() => false);
    if (scheduled) {
      return { kind: "nodesParity", clearances: result.clearances, mismatches: result.mismatches, privacyMatches: result.privacyMatches };
    }
  }
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
  change: { paths: string[]; files: string[]; left?: LeftAudiences[] },
): Promise<void> {
  try {
    await ctx.scheduler.runAfter(0, internal.functions.files.runFileOperation, {
      workspaceId,
      scope: "private",
      operation: {
        kind: "nodesTouch",
        paths: change.paths,
        files: change.files,
        ...(change.left === undefined || change.left.length === 0 ? {} : { left: change.left }),
      },
    });
  } catch {
    // A shadow never fails a change. The next sweep repairs what this missed.
  }
}

/**
 * After a console change, with the bucket the barrier already opened: re-check
 * what it touched **before the change answers**, so the tab that made it, and
 * every tab subscribed to the folder, reads the new tree the moment the change
 * returns (phase 2: the console reads this tree). Never throws, and a change
 * too big to re-check only marks the tree for a sweep, as the scheduled
 * re-check does. Staff's Pause does not stop it: readers read nothing else.
 *
 * `left` says who could see each key the change took away, before it: a move
 * rewrites the rules before this re-check, and the tree's gone rows narrow to
 * it (`convexTable.ts`).
 */
export async function touchNodesNow(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  store: FileStore,
  change: { paths: string[]; files: string[]; left?: LeftAudiences[] },
): Promise<void> {
  const sink = sinkFor(ctx, workspaceId);
  try {
    const { dirty } = await touchNodes(listingOf(workspaceId, store), sink, change);
    if (dirty) await ctx.runMutation(internal.functions.nodes.requestSweep, { workspaceId });
    // What the changed notes now say is read after the change answers.
    else await scheduleFactFill(ctx, workspaceId);
  } catch {
    // A shadow never fails a change. The next sweep repairs what this missed.
    console.error("nodes.touch_failed", { workspaceId });
    await ctx.runMutation(internal.functions.nodes.requestSweep, { workspaceId }).catch(() => {});
  }
}

/** Ask for a sweep of the Convex tree after a change too wide to name. Never throws. */
export async function requestNodesSweep(ctx: ActionCtx, workspaceId: Id<"workspaces">): Promise<void> {
  await ctx.runMutation(internal.functions.nodes.requestSweep, { workspaceId }).catch(() => {});
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
