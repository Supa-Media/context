/**
 * Search by meaning in a workspace's settings: what the card shows, and the
 * owner's switch.
 *
 * Owner-only to change, for fast search's reason (`functions/fastSearch.ts`,
 * "Owner-only, and why that is not the same as write access"): deciding that
 * fingerprints of every note are kept on our infrastructure is the owner's
 * call, not an editor's. Readable by any member, but the progress counts are
 * the owner's alone: they are a census of notes, private ones included.
 */

import type { Id } from "../../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import { recordAudit } from "../audit";
import { requireWorkspaceAccess, requireWorkspaceRole } from "../workspaceAuth";
import { requireUserId } from "../fastSearchFns/helpers";
import { disableMeaningHandler, enableMeaningHandler, meaningRowFor } from "./rows";

/**
 * The card's word for the row. `waiting` is a workspace "on for everyone" has
 * not reached yet: on by default, so the switch reads On, with nothing built.
 */
export type MeaningSearchState = "on" | "preparing" | "waiting" | "failed" | "off";

export interface MeaningSearchStatus {
  state: MeaningSearchState;
  canChange: boolean;
  /** Owner only: a count of notes, private ones included. */
  notesIndexed?: number;
  notesPending?: number;
}

function stateOf(row: Awaited<ReturnType<typeof meaningRowFor>>): MeaningSearchState {
  if (row === null) return "waiting";
  if (!row.enabled) return "off";
  switch (row.status) {
    case "ready":
      return "on";
    case "backfilling":
    case "provisioning":
      return "preparing";
    case "failed":
      return "failed";
    default:
      return "off";
  }
}

export async function meaningStatusHandler(
  ctx: QueryCtx,
  args: { workspaceId: Id<"workspaces"> },
): Promise<MeaningSearchStatus> {
  const userId = await requireUserId(ctx);
  const { membership } = await requireWorkspaceAccess(ctx, args.workspaceId, userId);
  const row = await meaningRowFor(ctx, args.workspaceId);
  const isOwner = membership.role === "owner";
  return {
    state: stateOf(row),
    canChange: isOwner,
    notesIndexed: isOwner ? row?.notesIndexed : undefined,
    notesPending: isOwner ? row?.notesPending : undefined,
  };
}

/** The owner's switch. On re-enables even an `off` row; off sticks. */
export async function setMeaningSearchHandler(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces">; on: boolean },
): Promise<MeaningSearchStatus> {
  const userId = await requireUserId(ctx);
  await requireWorkspaceRole(ctx, args.workspaceId, userId, "owner");
  if (args.on) {
    await enableMeaningHandler(ctx, { workspaceId: args.workspaceId, by: userId });
  } else {
    await disableMeaningHandler(ctx, { workspaceId: args.workspaceId, reason: "owner" });
  }
  await recordAudit(ctx, {
    workspaceId: args.workspaceId,
    actorUserId: userId,
    action: args.on ? "search.meaning_enabled" : "search.meaning_disabled",
  });
  return await meaningStatusHandler(ctx, args);
}
