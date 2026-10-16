/**
 * Moving or renaming a file or folder in a keyed workspace as a row change
 * (`rowMove.ts`): the one path a keyed move takes, with no byte walk.
 *
 * Answers `null` when the workspace is not keyed, so the caller takes the
 * path it always has. Once keyed, it never answers `null`: a refusal is
 * thrown, because the old way would move the frozen path copies the bucket
 * still holds, and those are not the notes (`keyed-design.md`).
 *
 * In order, as `moveStart.ts` does for a queued move:
 *  1. The names the caller may see (`canSee`), and the notes under a folder
 *     it may not see in full are refused (a row move cannot leave them behind).
 *  2. The rules are carried to the new name (`carryPrivacy`), so the moved
 *     notes are never judged without the narrowing they carry.
 *  3. The rows move (`nodeRowMoves.rowMove`), which re-checks everything.
 *  4. The old name's rules go, and the bucket-side records follow it:
 *     forwarding, folder icons, and the search index.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { recordForwarding } from "../../../../mcp/src/forwarding.js";
import { remapFolderIcons, remapIcons } from "@context/shared/src/folderIcons.cjs";
import type { Clearance } from "../clearance";
import { FileOpError, notFound } from "../fileOps/errors";
import { folderVisibleAtScope } from "../fileOps/listing";
import { assertMoveDestinationsVisible } from "../fileOps/moveRules";
import { loadPrivacyState } from "../fileOps/privacyState";
import type { FileStore } from "../fileOps/store";
import { followInProjection, type ProjectionClient } from "../fileOps/search";
import type { MoveResult } from "../fileOps/moving";
import { PRIVACY_KEY, canSee } from "../privacy";
import { carryPrivacy, releasePrivacy } from "./movePrivacy";
import { touchNodesNow } from "./run";
import type { RowMoveRefusal } from "./rowMove";

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
    case "unkeyed":
    case "not_served":
    case "not_keyed":
    case "rules_changed":
      return new FileOpError("CONFLICT", "The tree is still getting ready for this move. Try again in a moment.");
  }
}

export async function startRowMove(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
    store: FileStore;
    from: string;
    to: string;
    clearance: Clearance;
    now: number;
    expectedEtag?: string;
    projection?: ProjectionClient | null;
  },
): Promise<MoveResult | null> {
  const { workspaceId, store, from, to, clearance, now } = args;
  const plan = await ctx.runQuery(internal.functions.nodeRowMoves.plan, { workspaceId, from });
  if (!plan.keyed) return null;

  if (plan.kind === null) throw notFound();
  if (plan.tooLarge) throw refusal("too_large", to, true);
  if (plan.unkeyed) throw refusal("unkeyed", to, true);

  const state = await loadPrivacyState(store);
  if (state.invalid) throw new FileOpError("PRIVACY_MANIFEST_INVALID", "The privacy rules could not be read; the move was not made.");
  if (!canSee(from, clearance.scope, state.rules, state.overrides, clearance.names)) throw notFound();
  // A folder with something in it this caller cannot see cannot move as one: the row move takes all of it.
  // The refusal says nothing of what is hidden, so it does not show that anything is.
  if (plan.files.some((key) => !canSee(key, clearance.scope, state.rules, state.overrides, clearance.names))) {
    throw new FileOpError("CONFLICT", "That folder cannot move in one step.");
  }
  const pairs = plan.files.map((key) => ({ source: key, destination: `${to}${key.slice(from.length)}` }));
  assertMoveDestinationsVisible(pairs, clearance, state);

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
  await touchNodesNow(ctx, workspaceId, store, { paths: [], files: [PRIVACY_KEY] });

  const answer = await ctx.runMutation(internal.functions.nodeRowMoves.rowMove, {
    workspaceId,
    from,
    to,
    privacyEtag: carried.etag,
    plannedFiles: plan.files,
    now,
    ...(args.expectedEtag === undefined ? {} : { expectedEtag: args.expectedEtag }),
  });
  if (!answer.ok) {
    // Nothing moved: take the carried rules back, as a move that never drew does.
    if (!rowsTruth) await releasePrivacy(store, { from: to, undone: true, added: carried.added }).catch(() => {});
    await touchNodesNow(ctx, workspaceId, store, { paths: [], files: [PRIVACY_KEY] }).catch(() => {});
    // A taken name the caller cannot see is "not found", never "exists": that is the disclosure the guards prevent.
    const visibleTarget =
      plan.kind === "folder"
        ? folderVisibleAtScope(to, clearance, state.rules, state.overrides)
        : canSee(to, clearance.scope, state.rules, state.overrides, clearance.names);
    throw refusal(answer.reason, to, visibleTarget);
  }

  if (!rowsTruth) await releasePrivacy(store, { from, undone: false, added: carried.added });
  await touchNodesNow(ctx, workspaceId, store, { paths: [], files: [PRIVACY_KEY] });
  await recordForwarding(store, [{ from, to, kind: answer.kind === "folder" ? ("folder" as const) : ("note" as const) }], { now });
  if (answer.kind === "folder") await remapFolderIcons(store, from, to);
  else await remapIcons(store, [{ from, to }]);
  if (args.projection) {
    await followInProjection(store, { written: [], gone: [], moved: [[from, to]] }, args.projection);
  }
  return {
    from,
    to,
    paths: [to],
    queued: answer.files.length,
    rowed: true,
    moved: answer.files,
    ...(answer.etag === undefined ? {} : { etag: answer.etag }),
  };
}
