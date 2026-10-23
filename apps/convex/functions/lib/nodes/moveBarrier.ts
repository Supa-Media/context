/**
 * Keyed moves inside the credential barrier (phase 4 of
 * `docs/decisions/app-and-console/convex-tree.md`): the few lines
 * `fileOperationBarrier.ts` needs, kept here so the barrier stays the list of
 * steps it is.
 *
 *  - `runMoveOperation` runs `nodesMoveStart` (a folder or note move: a row move
 *    in `rowMoveStart.ts`) and `nodesMoveBatch` (`rowMoveBatch.ts`).
 *  - `pendingMovesLookup` is the keyed moves the tree still draws, which a prune
 *    pass waits for.
 *  - `attachQueueMove` lets `movePath` move rows (`queueMove`), lets
 *    `trashPath` trash rows (`trashKeyedRows`), and lets `restoreTrashedPath`
 *    move them back (`restoreKeyedTrash`).
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { clearanceOf } from "../clearance";
import { FileOpError } from "../fileOps/errors";
import { requirePath } from "../fileOps/paths";
import { assertNoNameTwin, assertNotProtectedFolder } from "../fileOps/nameTwins";
import { assertWritablePath } from "../fileOps/writing";
import type { ProjectionClient } from "../fileOps/search";
import type { FileStore } from "../fileOps/store";
import type { FileOperation, OperationResult } from "../filesFns/operationTypes";
import type { PendingMove } from "./moveOverlay";
import { startRowMove } from "./rowMoveStart";
import { startRowMoveBatch } from "./rowMoveBatch";
import { restoreRowTrash, startRowTrash } from "./rowTrash";
import { attachTreeListing } from "./treeNames";
import { attachWorkspaceKeyed } from "../noteIds/keyedStore";

type BarrierArgs = {
  workspaceId: Id<"workspaces">;
  scope: "private" | "team";
  grantedNames?: string[];
  operation: { kind: string };
};

export type MoveOperation = Extract<FileOperation, { kind: "nodesMoveStart" | "nodesMoveBatch" }>;

export function isMoveOperation(operation: { kind: string }): operation is MoveOperation {
  return operation.kind === "nodesMoveStart" || operation.kind === "nodesMoveBatch";
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

/** The operations that take keyed rows to the trash: a trash, and where a path would be deleted permanently. */
const TRASHING_KEYED_ROWS = new Set(["trash", "removeNewFolder", "pluginDelete", "contextMoveDelete", "contextMoveFinish"]);

/** The operations that may move a folder: everything else moves in one go. */
const QUEUEING = new Set(["move", "archive", "archiveTidy", "pluginRename"]);

/** The keyed moves a request reads through: those the tree still draws. Started early, beside the barrier's other lookups. */
export function pendingMovesLookup(ctx: ActionCtx, workspaceId: Id<"workspaces">): Promise<PendingMove[]> {
  const lookup = ctx.runQuery(internal.functions.nodeRowMoves.drawn, { workspaceId });
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
  let moved;
  try {
    // The checks `movePath` makes before it would move: the gateway's paths arrive unchecked here.
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
    moved = await startRowMove(ctx, {
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

/**
 * Let `movePath` move rows through this store. Non-enumerable, as the
 * barrier's other seams are, so nothing that walks the store carries it.
 */
export function attachQueueMove(
  ctx: ActionCtx,
  args: BarrierArgs,
  store: FileStore,
  bucket: FileStore,
  /** The search index a keyed row move follows (`rowMoveStart.ts`). */
  projection: ProjectionClient | null = null,
): void {
  if (args.operation.kind === "restoreTrash") {
    Object.defineProperty(store, "restoreKeyedTrash", {
      value: async (restore: { trash: string; path: string }): Promise<boolean> => {
        await restoreRowTrash(ctx, { workspaceId: args.workspaceId, store: bucket, trash: restore.trash, path: restore.path, now: Date.now() });
        return true;
      },
      enumerable: false,
      configurable: true,
    });
  }
  // A keyed workspace refuses a permanent delete of a path (`deletePath`); these operations trash the
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
      startRowMove(ctx, { workspaceId: args.workspaceId, store: bucket, projection, ...move }),
    enumerable: false,
    configurable: true,
  });
}
