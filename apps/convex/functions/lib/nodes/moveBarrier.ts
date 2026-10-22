/**
 * Queued moves inside the credential barrier (phase 4 of
 * `docs/decisions/app-and-console/convex-tree.md`): the few lines
 * `fileOperationBarrier.ts` needs, kept here so the barrier stays the list of
 * steps it is.
 *
 *  - `runMoveOperation` runs `nodesMoveStart` (the gateway's move tools) and
 *    `nodesMoveWork` (the scheduled worker).
 *  - `storeWithMoves` is the store every other operation reads through while
 *    moves are pending (`withPendingMoves`): a note at its new name is moved
 *    there before it is read or written, and opening one at its old name moves
 *    it on first, so the read follows the forwarding entry like any moved note.
 *  - `attachQueueMove` lets `movePath` queue a folder move (the console's move
 *    and archive), and
 *    lets `trashPath` queue a trash and `restoreTrashedPath` turn a queued one
 *    around (`trashStart.ts`).
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { promotePath, withPendingMoves } from "../../../../mcp/src/moves/queued.js";
import { clearanceOf } from "../clearance";
import { FileOpError } from "../fileOps/errors";
import { requirePath } from "../fileOps/paths";
import { assertNoNameTwin, assertNotProtectedFolder } from "../fileOps/nameTwins";
import { assertWritablePath } from "../fileOps/writing";
import type { ProjectionClient } from "../fileOps/search";
import type { FileStore } from "../fileOps/store";
import type { FileOperation, OperationResult } from "../filesFns/operationTypes";
import type { PendingMove } from "./moveOverlay";
import { startQueuedMove } from "./moveStart";
import { startRowMoveBatch } from "./rowMoveBatch";
import { restoreQueuedTrash, startQueuedTrash } from "./trashStart";
import { startRowTrash } from "./rowTrash";
import { runMoveWork } from "./moveWork";
import { rowFromObject } from "./sweep";
import { attachTreeListing } from "./treeNames";
import { attachWorkspaceKeyed } from "../noteIds/keyedStore";

type BarrierArgs = {
  workspaceId: Id<"workspaces">;
  scope: "private" | "team";
  grantedNames?: string[];
  operation: { kind: string };
};

export type MoveOperation = Extract<FileOperation, { kind: "nodesMoveStart" | "nodesMoveWork" | "nodesMoveBatch" }>;

export function isMoveOperation(operation: { kind: string }): operation is MoveOperation {
  return operation.kind === "nodesMoveStart" || operation.kind === "nodesMoveWork" || operation.kind === "nodesMoveBatch";
}

/**
 * A batch of note moves in a keyed workspace, made whole or refused whole
 * (`rowMoveBatch.ts`). A refusal answers as a single move's does.
 */
async function runMoveBatch(
  ctx: ActionCtx,
  args: BarrierArgs,
  moves: readonly { from: string; to: string; expectedEtag?: string }[],
  store: FileStore,
  projection: ProjectionClient | null,
): Promise<OperationResult> {
  try {
    const checked = moves.map((move) => {
      const from = requirePath(move.from);
      const to = requirePath(move.to);
      assertWritablePath(from);
      assertWritablePath(to);
      return { from, to, ...(move.expectedEtag === undefined ? {} : { expectedEtag: move.expectedEtag }) };
    });
    const made = await startRowMoveBatch(ctx, {
      workspaceId: args.workspaceId,
      store,
      moves: checked,
      clearance: clearanceOf(args.scope, args.grantedNames ?? []),
      now: Date.now(),
      projection,
    });
    return { kind: "moveBatch", ok: true, moves: made.map((move) => ({ from: move.from, to: move.to })) };
  } catch (error) {
    if (error instanceof FileOpError) return { kind: "moveBatch", ok: false, error: error.code, message: error.message };
    throw error;
  }
}

/** The operations that take keyed rows to the trash where a path's bytes would be deleted. */
const TRASHING_KEYED_ROWS = new Set(["removeNewFolder", "pluginDelete", "contextMoveDelete", "contextMoveFinish"]);

/** The operations that may queue a folder move: everything else moves in one go. */
const QUEUEING = new Set(["move", "archive", "archiveTidy"]);

/** The moves a request reads through. Started early, beside the barrier's other lookups. */
export function pendingMovesLookup(ctx: ActionCtx, workspaceId: Id<"workspaces">): Promise<PendingMove[]> {
  const lookup = ctx.runQuery(internal.functions.nodeMoves.active, { workspaceId });
  // Awaited later; a rejection before then must not surface as an unhandled one.
  lookup.catch(() => {});
  return lookup;
}

export async function runMoveOperation(
  ctx: ActionCtx,
  args: BarrierArgs & { operation: MoveOperation },
  store: FileStore,
  projection: ProjectionClient | null = null,
): Promise<OperationResult> {
  if (args.operation.kind === "nodesMoveBatch") return await runMoveBatch(ctx, args, args.operation.moves, store, projection);
  if (args.operation.kind === "nodesMoveWork") {
    // The finishing link rewrite lists the tree's notes, not the bucket's.
    attachTreeListing(ctx, args.workspaceId, store);
    attachWorkspaceKeyed(ctx, args.workspaceId, store);
    return await runMoveWork(ctx, args.workspaceId, store, projection);
  }
  let moved;
  try {
    // The checks `movePath` makes before it would queue: the gateway's paths arrive unchecked here.
    const from = requirePath(args.operation.from);
    const to = requirePath(args.operation.to);
    assertWritablePath(from);
    assertWritablePath(to);
    // Asked of the tree, on a store of its own so the move's walks below are unchanged.
    const named = Object.create(store) as FileStore;
    attachTreeListing(ctx, args.workspaceId, named);
    attachWorkspaceKeyed(ctx, args.workspaceId, named);
    const clearance = clearanceOf(args.scope, args.grantedNames ?? []);
    await assertNotProtectedFolder(named, from, clearance, "move");
    if (from === to || to.startsWith(`${from}/`) || from.startsWith(`${to}/`)) {
      throw new FileOpError("PATH_INVALID", "A folder cannot be moved into, onto or over itself.");
    }
    await assertNoNameTwin(named, to, clearance, "folder", from);
    moved = await startQueuedMove(ctx, {
      workspaceId: args.workspaceId,
      store,
      from,
      to,
      clearance,
      now: Date.now(),
      projection,
      ...(args.operation.expectedEtag === undefined ? {} : { expectedEtag: args.operation.expectedEtag }),
    });
  } catch (error) {
    // A refusal goes back to the agent as the console would word it; anything else fails the call.
    if (error instanceof FileOpError) return { kind: "moveQueued", queued: false, error: error.code, message: error.message };
    throw error;
  }
  if (moved === null) return { kind: "moveQueued", queued: false };
  return {
    kind: "moveQueued",
    queued: true,
    count: moved.queued ?? 0,
    ...(moved.rowed === true ? { rowed: true } : {}),
    ...(moved.historyCarried === true ? { historyCarried: true } : {}),
    ...(moved.moved === undefined ? {} : { moved: moved.moved }),
  };
}

/** What an object moved early does to the tree: seen at its new name, gone from its old one, and counted. */
function onMovedFor(ctx: ActionCtx, workspaceId: Id<"workspaces">) {
  return async (moved: { from: string; to: string; etag?: string; size?: number }) => {
    const at = Date.now();
    const row = rowFromObject({ key: moved.to, etag: moved.etag, size: moved.size });
    await ctx.runMutation(internal.functions.nodes.observe, {
      workspaceId,
      at,
      rows: row === null ? [] : [row],
      gone: rowFromObject({ key: moved.from }) === null ? [] : [moved.from],
      vanishedUnder: [],
    });
    await ctx.runMutation(internal.functions.nodeMoves.promoted, { workspaceId, from: moved.from, now: at });
  };
}

/** A path an operation opens a single note by, for promotion: a read that follows moves. */
function openedPath(operation: { kind: string; path?: unknown; forward?: unknown }): string | null {
  if (operation.kind !== "read" || operation.forward === "never") return null;
  return typeof operation.path === "string" ? operation.path : null;
}

/** The store an operation reads through while moves are pending; the store itself when none are. */
export async function storeWithMoves(
  ctx: ActionCtx,
  args: BarrierArgs,
  store: FileStore,
  moves: readonly PendingMove[],
): Promise<FileStore> {
  if (moves.length === 0) return store;
  const onMoved = onMovedFor(ctx, args.workspaceId);
  const opened = openedPath(args.operation as { kind: string; path?: unknown; forward?: unknown });
  if (opened !== null) await promotePath(store, [...moves], opened, onMoved);
  return withPendingMoves(store, [...moves], { onMoved }) as FileStore;
}

/**
 * Let `movePath` queue a folder move through this store. Non-enumerable, as
 * the barrier's other seams are, so nothing that walks the store carries it.
 */
export function attachQueueMove(
  ctx: ActionCtx,
  args: BarrierArgs,
  store: FileStore,
  bucket: FileStore,
  /** How Restore waits on a queued trash; tests run the worker in it. */
  wait?: (ms: number) => Promise<void>,
  /** The search index a keyed row move follows (`rowMoveStart.ts`). */
  projection: ProjectionClient | null = null,
): void {
  if (args.operation.kind === "trash") {
    Object.defineProperty(store, "queueTrash", {
      value: (trash: { path: string; clearance: ReturnType<typeof clearanceOf>; now: number }) =>
        startQueuedTrash(ctx, { workspaceId: args.workspaceId, store: bucket, projection, ...trash }),
      enumerable: false,
      configurable: true,
    });
  }
  if (args.operation.kind === "restoreTrash") {
    Object.defineProperty(store, "restoreQueuedTrash", {
      value: async (restore: { trash: string; path: string }): Promise<boolean | FileStore> => {
        const answer = await restoreQueuedTrash(ctx, { workspaceId: args.workspaceId, store: bucket, ...restore, ...(wait === undefined ? {} : { wait }) });
        if (answer !== "landed") return answer === "undone";
        // The trash landed while Restore waited: the moves this request read through are over, and a
        // store still folding them would refuse to write the note back at a name they carried away.
        return await storeWithMoves(ctx, args, bucket, await ctx.runQuery(internal.functions.nodeMoves.active, { workspaceId: args.workspaceId }));
      },
      enumerable: false,
      configurable: true,
    });
  }
  // A keyed workspace refuses a permanent delete of a path (`deletePath`); these two operations trash the
  // rows instead, which keeps the note restorable (`trashKeyedRows` in `fileOps/deleting.ts`).
  // A move into another workspace takes its notes out of a keyed one the same way (`contextMoveImport.ts`).
  if (TRASHING_KEYED_ROWS.has(args.operation.kind)) {
    Object.defineProperty(store, "trashKeyedRows", {
      value: (trash: { path: string; clearance: ReturnType<typeof clearanceOf>; now: number; expectedEtag?: string }) =>
        startRowTrash(ctx, { workspaceId: args.workspaceId, store: bucket, projection, ...trash }),
      enumerable: false,
      configurable: true,
    });
  }
  if (!QUEUEING.has(args.operation.kind)) return;
  Object.defineProperty(store, "queueMove", {
    value: (move: { from: string; to: string; clearance: ReturnType<typeof clearanceOf>; now: number; expectedEtag?: string }) =>
      startQueuedMove(ctx, { workspaceId: args.workspaceId, store: bucket, projection, ...move }),
    enumerable: false,
    configurable: true,
  });
}
