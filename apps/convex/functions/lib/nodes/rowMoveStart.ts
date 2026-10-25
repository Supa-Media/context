/**
 * Moving or renaming a file or folder in a keyed workspace as a row change
 * (`rowMove.ts`): the one path a keyed move takes, with no byte walk.
 *
 * Answers `null` when the workspace is not keyed, so the caller takes the
 * path it always has. Once keyed, it never answers `null`: a refusal is
 * thrown, because the old way would move the frozen path copies the bucket
 * still holds, and those are not the notes (`keyed-design.md`).
 *
 * In order:
 *  1. The names the caller may see (`canSee`), and the notes under a folder
 *     it may not see in full are refused (a row move cannot leave them behind).
 *  2. The rules are carried to the new name (`carryPrivacy`), so the moved
 *     notes are never judged without the narrowing they carry.
 *  3. The rows move (`nodeRowMoves.rowMove`), which re-checks everything. A
 *     folder over the cap moves its root there and the rest in pages, driven
 *     here until the last (`rowMoveChunks.ts`, `rowMoveDrive.ts`).
 *  4. The old name's rules go, and the bucket-side records follow it:
 *     forwarding, folder icons, and the search index.
 *
 * Asking again for a chunked move that is still recorded (`rowMoveFor`) resumes
 * it from step 3, for whoever may see both names: a request that stopped
 * mid-move left the rows to the watchdog and the bucket's steps undone.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { recordForwarding } from "../../../../mcp/src/forwarding.js";
import { remapFolderIcons, remapIcons } from "@context/shared/src/folderIcons.cjs";
import type { Clearance } from "../clearance";
import { FileOpError, notFound } from "../fileOps/errors";
import { folderVisibleAtScope } from "../fileOps/listing";
import { assertDestinationsVisible, assertMoveDestinationsVisible } from "../fileOps/moveRules";
import { loadPrivacyState } from "../fileOps/privacyState";
import type { FileStore } from "../fileOps/store";
import { followInProjection, type ProjectionClient } from "../fileOps/search";
import type { MoveResult } from "../fileOps/moving";
import { PRIVACY_KEY, canSee, isPlumbing } from "../privacy";
import { carryPrivacy, releasePrivacy } from "./movePrivacy";
import { catchUpKeyedRows } from "./rowCatchUp";
import type { RowMoveRefusal } from "./rowMove";
import { driveRowMove, plannedFiles, recordedMove } from "./rowMoveDrive";
import { afterArchiveMove, archivePlanFor, type ArchivePlan } from "./archiveFollow";
import { clearanceOf } from "../clearance";
import { handedEtagAt, rowEtagFor } from "./handedVersion";
import { queueLinkRepair } from "./linkRepair";

/** The refusal a row move answers with, in the words the console and agents already get for each case. */
export function refusal(reason: RowMoveRefusal, to: string, visibleTarget: boolean): Error {
  switch (reason) {
    case "not_found":
      return notFound();
    case "taken":
      if (!visibleTarget) return notFound();
      return new FileOpError("DESTINATION_EXISTS", `Something already exists at ${to}.`);
    case "too_large":
      return new FileOpError("FOLDER_TOO_LARGE", "That folder holds too many notes to move in one step. Move it in smaller parts.");
    case "busy":
      return new FileOpError("CONFLICT", "Something there is still moving. Try again once it has finished.");
    case "changed":
      return new FileOpError("CONFLICT", "That note changed somewhere else after this was asked for.");
    case "invalid":
      return new FileOpError("PATH_INVALID", "That move is not possible.");
    case "archive_stays":
      return new FileOpError("PATH_INVALID", "Archive stays at the top level. You can rename it, but it can't go inside another folder.");
    case "built_in_archived":
      return new FileOpError("PATH_INVALID", "Built-in folders can't go into Archive. Archive the things inside them instead.");
    case "unkeyed":
    case "not_served":
    case "not_keyed":
    case "rules_changed":
      return new FileOpError("CONFLICT", "The tree is still getting ready for this move. Try again in a moment.");
  }
}

/**
 * The refusal for names a move already under way is carrying. "Something there is still moving" is itself
 * something to know: answered before the caller's clearance is read, it tells a `team` caller that a private
 * folder exists and is being moved, where a free name answers not-found. So the names are judged first, and
 * a caller who may not see either of them gets the refusal a free name gives.
 */
async function busyOrHidden(args: RowMoveArgs): Promise<Error> {
  const { store, from, to, clearance } = args;
  const state = await loadPrivacyState(store);
  if (state.invalid) return new FileOpError("PRIVACY_MANIFEST_INVALID", "The privacy rules could not be read; the move was not made.");
  if (!canSee(from, clearance.scope, state.rules, state.overrides, clearance.names)) return notFound();
  try {
    assertDestinationsVisible([to], clearance, state.rules, state.overrides);
  } catch (error) {
    return error as Error;
  }
  return refusal("busy", to, true);
}

interface RowMoveArgs {
  workspaceId: Id<"workspaces">;
  store: FileStore;
  from: string;
  to: string;
  clearance: Clearance;
  now: number;
  expectedEtag?: string;
  projection?: ProjectionClient | null;
}

export async function startRowMove(ctx: ActionCtx, args: RowMoveArgs): Promise<MoveResult | null> {
  const { workspaceId, store, from, to, clearance, now } = args;
  const plan = await ctx.runQuery(internal.functions.nodeRowMoves.plan, { workspaceId, from });
  if (!plan.keyed) return null;
  const recorded = await recordedMove(ctx, workspaceId, from, (move) => !move.trash && move.to === to);
  if (recorded !== null && !recorded.trash) {
    if (recorded.to !== to) throw await busyOrHidden(args);
    return await resumeRowMove(ctx, args, recorded);
  }
  // One move per subtree at a time; asked before either name is read, since one may be half-moved.
  if (await ctx.runQuery(internal.functions.nodeRowMoves.rowMoveOverlaps, { workspaceId, from, to })) throw await busyOrHidden(args);

  if (plan.kind === null) throw notFound();
  const planned = await plannedFiles(ctx, workspaceId, from, plan);
  // Read before the move lands: the twins in Archive are found at the built-in folders' old paths.
  const archive = await archivePlanFor(ctx, workspaceId, from, to);
  if (planned.unkeyed) throw refusal("unkeyed", to, true);

  const state = await loadPrivacyState(store);
  if (state.invalid) throw new FileOpError("PRIVACY_MANIFEST_INVALID", "The privacy rules could not be read; the move was not made.");
  if (!canSee(from, clearance.scope, state.rules, state.overrides, clearance.names)) throw notFound();
  // A folder with something in it this caller cannot see cannot move as one: the row move takes all of it.
  // The refusal says nothing of what is hidden, so it does not show that anything is. Plumbing (a dot
  // segment, such as a mail pass's attachment list) is hidden from every caller alike, so it hides nothing
  // from this one and goes with its folder.
  const seen = planned.files.filter((key) => !isPlumbing(key));
  if (seen.some((key) => !canSee(key, clearance.scope, state.rules, state.overrides, clearance.names))) {
    throw new FileOpError("CONFLICT", "That folder cannot move in one step.");
  }
  const pairs = planned.files.map((key) => ({ source: key, destination: `${to}${key.slice(from.length)}` }));
  assertMoveDestinationsVisible(pairs.filter((pair) => !isPlumbing(pair.source)), clearance, state);

  // In rows mode the rows are the truth and the rules are not carried: a folder that would widen keeps its
  // narrowing on its own row, which the move then carries (`narrowMove`). The file's own rules are left alone.
  const rowsTruth = await ctx.runQuery(internal.functions.nodesAccess.rowsMode, {});
  if (rowsTruth) await ctx.runMutation(internal.functions.nodesAccess.narrowMove, { workspaceId, from, to });
  const carried = rowsTruth
    ? { etag: state.etag, added: { folders: [], notes: [] } }
    : await carryPrivacy(store, from, to);
  if (carried === null) throw new FileOpError("PRIVACY_MANIFEST_INVALID", "The privacy rules could not be read; the move was not made.");
  // Rows mode hands out the rows' version, taken after this move's own narrowing: only a change that lands
  // between here and the move refuses it.
  if (rowsTruth) carried.etag = await ctx.runQuery(internal.functions.nodesAccess.privacyEtagNow, { workspaceId });
  // The caller's version as the row carries it (`handedVersion.ts`), read only once the caller may see the note.
  const expectedEtag = await rowEtagFor(store, from, args.expectedEtag);
  // The caller's version is the key's (`idLayout.js`); a row the key moved on from without telling it catches up first.
  await catchUpKeyedRows(ctx, workspaceId, store, [{ path: from, expectedEtag }]);

  const answer = await ctx.runMutation(internal.functions.nodeRowMoves.rowMove, {
    workspaceId,
    from,
    to,
    privacyEtag: carried.etag,
    // A chunked move judges each page's rows itself; within the cap the mutation checks the very files judged here.
    ...(plan.tooLarge ? {} : { plannedFiles: planned.files }),
    chunk: { scope: clearance.scope, grantedNames: [...clearance.names] },
    now,
    ...(expectedEtag === undefined ? {} : { expectedEtag }),
  });
  if (!answer.ok) {
    // Nothing moved: take the carried rules back, as a move that never drew does.
    if (!rowsTruth) await releasePrivacy(store, { from: to, undone: true, added: carried.added }).catch(() => {});
    // A taken name the caller cannot see is "not found", never "exists": that is the disclosure the guards prevent.
    const visibleTarget =
      plan.kind === "folder"
        ? folderVisibleAtScope(to, clearance, state.rules, state.overrides)
        : canSee(to, clearance.scope, state.rules, state.overrides, clearance.names);
    if (answer.reason === "changed") {
      throw new FileOpError("CONFLICT", "That note changed somewhere else after this was asked for.", answer.currentEtag);
    }
    throw refusal(answer.reason, to, visibleTarget);
  }
  if (answer.chunked === undefined) {
    const settled = await settleRowMove(ctx, args, { kind: answer.kind, files: answer.files, left: 0, rowsTruth, ...(answer.etag === undefined ? {} : { etag: answer.etag }) });
    return await withArchive(ctx, args, archive, settled);
  }
  const driven = await driveRowMove(ctx, { workspaceId, id: answer.chunked, from, to, store });
  await settleRowMove(ctx, args, { kind: "folder", files: driven.files, left: driven.left, rowsTruth });
  await ctx.runMutation(internal.functions.nodeRowMoves.rowMoveSettled, { id: answer.chunked });
  return await withArchive(ctx, args, archive, { from, to, paths: [to], queued: driven.files.length, rowed: true, moved: driven.files });
}

/**
 * Archive's side of a move that landed (`archiveFollow.ts`): the twins on the way into Archive marked, and
 * the twins of the built-in folders it moved carried after them, as the owner. The files they carried join
 * the answer's `moved`, so the links to them follow too.
 */
async function withArchive(ctx: ActionCtx, args: RowMoveArgs, plan: ArchivePlan, result: MoveResult): Promise<MoveResult> {
  const carried = await afterArchiveMove(ctx, args.workspaceId, args.to, plan, async (from, to) =>
    await startRowMove(ctx, { ...args, from, to, clearance: clearanceOf("private"), expectedEtag: undefined }),
  );
  if (carried.length === 0) return result;
  // The twin moved as the owner, but the answer goes to the caller: only the files they may see are named.
  const state = await loadPrivacyState(args.store);
  const { scope, names } = args.clearance;
  const seen = state.invalid ? [] : carried.filter((pair) => canSee(pair.to, scope, state.rules, state.overrides, names));
  return seen.length === 0 ? result : { ...result, moved: [...(result.moved ?? []), ...seen] };
}

/**
 * The bucket's side once the rows have moved: the old name's rules go (unless a chunked move left rows
 * there, which still need them), and forwarding, icons and the search index follow.
 */
async function settleRowMove(
  ctx: ActionCtx,
  args: RowMoveArgs,
  moved: { kind: "file" | "folder"; files: { from: string; to: string }[]; left: number; rowsTruth: boolean; etag?: string },
): Promise<MoveResult> {
  const { workspaceId, store, from, to, now } = args;
  if (!moved.rowsTruth && moved.left === 0) await releasePrivacy(store, { from, undone: false, added: { folders: [], notes: [] } });
  // A note's collaboration history is filed by its note id, so nothing follows the move: the new name finds it, and
  // the version it was handed before the move is still the one a read of the new name hands out.
  const etag = moved.kind === "file" ? ((await handedEtagAt(store, to)) ?? moved.etag) : undefined;
  await recordForwarding(store, [{ from, to, kind: moved.kind === "folder" ? ("folder" as const) : ("note" as const) }], { now });
  // The links to what moved, and inside it, follow behind the move (`linkRepair.ts`); forwarding sends them on meanwhile.
  await queueLinkRepair(ctx, workspaceId, moved.files, now);
  if (moved.kind === "folder") await remapFolderIcons(store, from, to);
  else await remapIcons(store, [{ from, to }]);
  if (args.projection) {
    await followInProjection(store, { written: [], gone: [], moved: [[from, to]] }, args.projection);
  }
  return {
    from,
    to,
    paths: [to],
    queued: moved.files.length,
    rowed: true,
    historyCarried: true,
    moved: moved.files,
    ...(etag === undefined ? {} : { etag }),
  };
}

/** Asked again for a chunked move still recorded: page what is left, then the bucket's side, for a caller who may see both names. */
async function resumeRowMove(
  ctx: ActionCtx,
  args: RowMoveArgs,
  recorded: { id: Id<"rowMoves">; state: "moving" | "moved"; left: number },
): Promise<MoveResult> {
  const { workspaceId, store, from, to, clearance } = args;
  const state = await loadPrivacyState(store);
  if (state.invalid) throw new FileOpError("PRIVACY_MANIFEST_INVALID", "The privacy rules could not be read; the move was not finished.");
  if (!canSee(from, clearance.scope, state.rules, state.overrides, clearance.names)) throw notFound();
  if (!folderVisibleAtScope(to, clearance, state.rules, state.overrides)) throw notFound();
  const rowsTruth = await ctx.runQuery(internal.functions.nodesAccess.rowsMode, {});
  const driven = recorded.state === "moving"
    ? await driveRowMove(ctx, { workspaceId, id: recorded.id, from, to, store })
    : { files: [], left: recorded.left };
  const result = await settleRowMove(ctx, args, { kind: "folder", files: driven.files, left: driven.left, rowsTruth });
  await ctx.runMutation(internal.functions.nodeRowMoves.rowMoveSettled, { id: recorded.id });
  return result;
}
