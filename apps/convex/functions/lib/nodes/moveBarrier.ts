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
 *    and archive, and the organizer, which moves through `movePath` too).
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { promotePath, withPendingMoves } from "../../../../mcp/src/moves/queued.js";
import { clearanceOf } from "../clearance";
import { FileOpError } from "../fileOps/errors";
import { assertNotMainFolder, requirePath } from "../fileOps/paths";
import { assertWritablePath } from "../fileOps/writing";
import type { FileStore } from "../fileOps/store";
import type { FileOperation, OperationResult } from "../filesFns/operationTypes";
import type { PendingMove } from "./moveOverlay";
import { startQueuedMove } from "./moveStart";
import { runMoveWork } from "./moveWork";
import { rowFromObject } from "./sweep";
import { attachTreeListing } from "./treeNames";

type BarrierArgs = {
  workspaceId: Id<"workspaces">;
  scope: "private" | "team";
  grantedNames?: string[];
  operation: { kind: string };
};

export type MoveOperation = Extract<FileOperation, { kind: "nodesMoveStart" | "nodesMoveWork" }>;

export function isMoveOperation(operation: { kind: string }): operation is MoveOperation {
  return operation.kind === "nodesMoveStart" || operation.kind === "nodesMoveWork";
}

/** The operations that may queue a folder move: everything else moves in one go. */
const QUEUEING = new Set(["move", "archive", "organizer"]);

/** The moves a request reads through. Started early, beside the barrier's other lookups. */
export function pendingMovesLookup(ctx: ActionCtx, workspaceId: Id<"workspaces">): Promise<PendingMove[]> {
  const lookup = ctx.runQuery(internal.functions.nodeMoves.active, { workspaceId });
  // Awaited later; a rejection before then must not surface as an unhandled one.
  lookup.catch(() => {});
  return lookup;
}

export async function runMoveOperation(ctx: ActionCtx, args: BarrierArgs & { operation: MoveOperation }, store: FileStore): Promise<OperationResult> {
  if (args.operation.kind === "nodesMoveWork") {
    // The finishing link rewrite lists the tree's notes, not the bucket's.
    attachTreeListing(ctx, args.workspaceId, store);
    return await runMoveWork(ctx, args.workspaceId, store);
  }
  let moved;
  try {
    // The checks `movePath` makes before it would queue: the gateway's paths arrive unchecked here.
    const from = requirePath(args.operation.from);
    const to = requirePath(args.operation.to);
    assertWritablePath(from);
    assertWritablePath(to);
    assertNotMainFolder(from);
    if (from === to || to.startsWith(`${from}/`) || from.startsWith(`${to}/`)) {
      throw new FileOpError("PATH_INVALID", "A folder cannot be moved into, onto or over itself.");
    }
    moved = await startQueuedMove(ctx, {
      workspaceId: args.workspaceId,
      store,
      from,
      to,
      clearance: clearanceOf(args.scope, args.grantedNames ?? []),
      now: Date.now(),
    });
  } catch (error) {
    // A refusal goes back to the agent as the console would word it; anything else fails the call.
    if (error instanceof FileOpError) return { kind: "moveQueued", queued: false, error: error.code, message: error.message };
    throw error;
  }
  return moved === null ? { kind: "moveQueued", queued: false } : { kind: "moveQueued", queued: true, count: moved.queued ?? 0 };
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
export function attachQueueMove(ctx: ActionCtx, args: BarrierArgs, store: FileStore, bucket: FileStore): void {
  if (!QUEUEING.has(args.operation.kind)) return;
  Object.defineProperty(store, "queueMove", {
    value: (move: { from: string; to: string; clearance: ReturnType<typeof clearanceOf>; now: number }) =>
      startQueuedMove(ctx, { workspaceId: args.workspaceId, store: bucket, ...move }),
    enumerable: false,
    configurable: true,
  });
}
