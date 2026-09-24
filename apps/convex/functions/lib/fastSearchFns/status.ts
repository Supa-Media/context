/**
 * The handler for `fastSearch.status`.
 *
 * Split out of `functions/fastSearch.ts` — see that file's header for the
 * gate this surfaces and the owner-only rules around it, and see `status`'s
 * own doc comment there for why the backfill counters are owner-only.
 */

import type { Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import { requireWorkspaceAccess } from "../workspaceAuth";
import { backfillPercent, fastSearchEntitled, fastSearchState } from "../fastSearch";
import { bindingFor, planFor, requireUserId } from "./helpers";
import type { FastSearchStatus } from "./validators";

export async function statusHandler(
  ctx: QueryCtx,
  args: { workspaceId: Id<"workspaces"> },
): Promise<FastSearchStatus> {
  const userId = await requireUserId(ctx);
  const { workspace, membership } = await requireWorkspaceAccess(
    ctx,
    args.workspaceId,
    userId,
  );
  const binding = await bindingFor(ctx, args.workspaceId);
  const plan = await planFor(ctx, args.workspaceId);

  const isOwner = membership.role === "owner";
  const state = fastSearchState(workspace, plan, binding);

  return {
    state,
    canChange: isOwner && fastSearchEntitled(workspace, plan),
    notesIndexed: isOwner ? binding?.notesIndexed : undefined,
    notesPending: isOwner ? binding?.notesPending : undefined,
    // `isOwner &&` rather than a ternary over the computed value, so the
    // percentage is not even computed for a member — there is no expression
    // here that could survive a refactor that dropped the gate on the line
    // above and be returned by accident.
    // `state === "on"` and not `binding.status === "ready"`: an opted-out or
    // unentitled row must never read 100 either, and `fastSearchState` is
    // where "is this actually serving" is decided once.
    percentIndexed: isOwner
      ? backfillPercent(binding?.notesIndexed, binding?.notesPending, state === "on")
      : undefined,
    error: binding?.error,
    optedInAt: binding?.optedInAt,
  };
}
