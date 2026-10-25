/**
 * A batch of moves in a keyed workspace (`move_notes` applied, as row changes):
 * the batch lands whole or not at all. Each move is a row change (`rowMove.ts`),
 * and the batch's rows are one mutation (`nodeRowMoves.rowMoveBatch`), so a
 * refused move throws and takes every move before it back.
 *
 * In order, as `rowMoveStart.ts` does for one move:
 *  1. Each move's names are read (`plan`) and judged as a single move is: a
 *     source the caller cannot see is not found, a folder holding a note the
 *     caller cannot see is refused, and every destination must be one the
 *     caller can see. The batch's rows are capped together, before anything is carried.
 *  2. Each move's rules are carried to its new name (`carryPrivacy`), in order,
 *     and the tree's copy of the rules is refreshed once.
 *  3. The rows move in one mutation. A refusal takes the carried rules back and
 *     throws the refusal of the move that caused it, naming it by its destination.
 *  4. The old names' rules go (`releasePrivacy`), forwarding is recorded, icons
 *     follow, and the search index follows.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { recordForwarding } from "../../../../mcp/src/forwarding.js";
import { remapIcons } from "@context/shared/src/folderIcons.cjs";
import type { Clearance } from "../clearance";
import { FileOpError, notFound } from "../fileOps/errors";
import { folderVisibleAtScope } from "../fileOps/listing";
import { assertDestinationsVisible, assertMoveDestinationsVisible } from "../fileOps/moveRules";
import { hidesBeneath } from "./builtJudge";
import type { MoveResult } from "../fileOps/moving";
import { loadPrivacyState, type PrivacyState } from "../fileOps/privacyState";
import { followInProjection, type ProjectionClient } from "../fileOps/search";
import type { FileStore } from "../fileOps/store";
import { catchUpKeyedRows } from "./rowCatchUp";
import { queueLinkRepair } from "./linkRepair";
import { rowEtagFor } from "./handedVersion";
import { PRIVACY_KEY, canSee } from "../privacy";
import { type AddedRules, carryPrivacy, releasePrivacy } from "./movePrivacy";
import { ROW_MOVE_MAX, type RowMoveRefusal } from "./rowMove";
import { refusal } from "./rowMoveStart";

/** One note or folder to move in the batch, old name to new. */
export interface BatchMove {
  from: string;
  to: string;
  /** The version the caller read, for a note: refused `CONFLICT` when it has moved on. */
  expectedEtag?: string;
}

interface Planned {
  move: BatchMove;
  kind: "file" | "folder";
  files: string[];
  rows: number;
  /** A folder on built paths: its files are not listed, and the rules beneath it are judged (`hiddenBeneath`). */
  builtFolder: boolean;
}

/** The refusal a batch's throw carries (`nodeRowMoves.rowMoveBatch`): which move, and why. */
function batchRefusal(error: unknown, planned: readonly Planned[], clearance: Clearance, state: PrivacyState): unknown {
  const data = (error as { data?: unknown }).data;
  if (typeof data !== "object" || data === null || (data as { batchRefusal?: unknown }).batchRefusal !== true) return error;
  const { index, reason } = data as { index: number; reason: RowMoveRefusal };
  const entry = planned[index];
  if (entry === undefined) return error;
  const to = entry.move.to;
  const visible =
    entry.kind === "folder"
      ? folderVisibleAtScope(to, clearance, state.rules, state.overrides)
      : canSee(to, clearance.scope, state.rules, state.overrides, clearance.names);
  return refusal(reason, to, visible);
}

/**
 * Move every move in `moves` in one keyed transaction, or none. Throws the
 * refusal of the first move that cannot be made, as a single move's would be.
 */
export async function startRowMoveBatch(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
    store: FileStore;
    moves: readonly BatchMove[];
    clearance: Clearance;
    now: number;
    projection?: ProjectionClient | null;
  },
): Promise<MoveResult[]> {
  const { workspaceId, store, moves, clearance, now } = args;
  if (moves.length === 0) throw new FileOpError("PATH_INVALID", "A batch needs at least one move.");

  const planned: Planned[] = [];
  for (const move of moves) {
    const plan = await ctx.runQuery(internal.functions.nodeRowMoves.plan, { workspaceId, from: move.from });
    if (plan.kind === null) throw notFound();
    if (plan.tooLarge) throw refusal("too_large", move.to, true);
    if (plan.unkeyed) throw refusal("unkeyed", move.to, true);
    planned.push({ move, kind: plan.kind, files: plan.files, rows: plan.rows, builtFolder: plan.built && plan.kind === "folder" && !plan.listed });
  }
  if (planned.reduce((sum, entry) => sum + entry.rows, 0) > ROW_MOVE_MAX) {
    throw new FileOpError("FOLDER_TOO_LARGE", "These moves hold too many notes to make in one step. Make them in smaller batches.");
  }

  const state = await loadPrivacyState(store);
  if (state.invalid) throw new FileOpError("PRIVACY_MANIFEST_INVALID", "The privacy rules could not be read; the move was not made.");
  for (const entry of planned) {
    const { move } = entry;
    if (!canSee(move.from, clearance.scope, state.rules, state.overrides, clearance.names)) throw notFound();
    // A folder with something in it this caller cannot see cannot move as one: the row move takes all of it.
    if (
      entry.files.some((key) => !canSee(key, clearance.scope, state.rules, state.overrides, clearance.names)) ||
      (entry.builtFolder && (await hidesBeneath(ctx, workspaceId, move.from, clearance, state)))
    ) {
      throw new FileOpError("CONFLICT", "That folder cannot move in one step.");
    }
    assertMoveDestinationsVisible(
      entry.files.map((key) => ({ source: key, destination: `${move.to}${key.slice(move.from.length)}` })),
      clearance,
      state,
    );
    if (entry.builtFolder) assertDestinationsVisible([move.to], clearance, state.rules, state.overrides);
  }

  // Each move's rules go to its new name before any row moves, as one move's do; a batch that fails takes them back.
  // In rows mode the rows are the truth: nothing is carried, and each move narrows its own row where it would widen.
  const rowsTruth = await ctx.runQuery(internal.functions.nodesAccess.rowsMode, {});
  const carried: { from: string; to: string; added: AddedRules }[] = [];
  let privacyEtag: string | null = null;
  const undoCarried = async () => {
    for (const entry of [...carried].reverse()) {
      await releasePrivacy(store, { from: entry.to, undone: true, added: entry.added }).catch(() => {});
    }
  };
  try {
    for (const { move } of planned) {
      if (rowsTruth) {
        await ctx.runMutation(internal.functions.nodesAccess.narrowMove, { workspaceId, from: move.from, to: move.to });
        continue;
      }
      const carry = await carryPrivacy(store, move.from, move.to);
      if (carry === null) throw new FileOpError("PRIVACY_MANIFEST_INVALID", "The privacy rules could not be read; the move was not made.");
      carried.push({ from: move.from, to: move.to, added: carry.added });
      privacyEtag = carry.etag;
    }
    // Rows mode hands out the rows' version, taken after every move's own narrowing (see `rowMoveStart`).
    if (rowsTruth) privacyEtag = await ctx.runQuery(internal.functions.nodesAccess.privacyEtagNow, { workspaceId });
  } catch (error) {
    await undoCarried();
    throw error;
  }
  // The callers' versions are the keys' (`idLayout.js`); rows the keys moved on from without telling them catch up first.
  // Each caller's version as the row carries it (`handedVersion.ts`).
  const expectations = await Promise.all(planned.map(({ move }) => rowEtagFor(store, move.from, move.expectedEtag)));
  await catchUpKeyedRows(ctx, workspaceId, store, planned.map(({ move }, index) => ({ path: move.from, expectedEtag: expectations[index] })));

  try {
    await ctx.runMutation(internal.functions.nodeRowMoves.rowMoveBatch, {
      workspaceId,
      moves: planned.map(({ move, files, builtFolder }, index) => ({
        from: move.from,
        to: move.to,
        ...(expectations[index] === undefined ? {} : { expectedEtag: expectations[index] }),
        ...(builtFolder ? {} : { plannedFiles: files }),
      })),
      privacyEtag,
      now,
    });
  } catch (error) {
    await undoCarried();
    throw batchRefusal(error, planned, clearance, state);
  }

  if (!rowsTruth) for (const entry of carried) await releasePrivacy(store, { from: entry.from, undone: false, added: entry.added });
  await recordForwarding(
    store,
    planned.map(({ move }) => ({ from: move.from, to: move.to, kind: "note" as const })),
    { now },
  );
  await remapIcons(store, planned.map(({ move }) => ({ from: move.from, to: move.to })));
  // The links follow behind the moves (`linkRepair.ts`).
  await queueLinkRepair(
    ctx,
    workspaceId,
    planned.flatMap(({ move, files }) => files.map((file) => ({ from: file, to: move.to + file.slice(move.from.length) }))),
    now,
  );
  if (args.projection) {
    await followInProjection(
      store,
      { written: [], gone: [], moved: planned.map(({ move }) => [move.from, move.to]) },
      args.projection,
    );
  }
  return planned.map(({ move, files }) => ({ from: move.from, to: move.to, paths: [move.to], queued: files.length, rowed: true }));
}
