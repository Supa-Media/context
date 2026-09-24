/**
 * The handler for `fastSearch.syncPremiumSelection`.
 *
 * Split out of `functions/fastSearch.ts` — see that file's header for the
 * gate this surfaces and the owner-only rules around it, and see
 * `syncPremiumSelection`'s own doc comment there for why it is a mutation
 * rather than an action.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { recordAudit } from "../audit";
import { FAST_SEARCH_GENERATION, fastSearchEntitled, fastSearchState, type FastSearchState } from "../fastSearch";
import { bindingFor, planFor } from "./helpers";

export async function syncPremiumSelectionHandler(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces">; actorUserId: Id<"users"> },
): Promise<{ state: FastSearchState }> {
  const workspace = await ctx.db.get(args.workspaceId);
  if (workspace === null) return { state: "unavailable" };
  const membership = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_workspace_user", (q) =>
      q.eq("workspaceId", args.workspaceId).eq("userId", args.actorUserId),
    )
    .unique();
  if (membership?.role !== "owner") return { state: "unavailable" };

  const plan = await planFor(ctx, args.workspaceId);
  const existing = await bindingFor(ctx, args.workspaceId);
  const entitled = fastSearchEntitled(workspace, plan);

  if (!entitled) {
    if (existing === null) return { state: "unavailable" };
    if (existing.generation !== FAST_SEARCH_GENERATION) {
      // Legacy coordinates belong to the retired generation and account.
      // They are intentionally not sent to the current account's delete API.
      await ctx.db.delete(existing._id);
      return { state: "unavailable" };
    }
    if (existing.databaseId === undefined) {
      await ctx.db.delete(existing._id);
    } else {
      await ctx.db.patch(existing._id, {
        optedIn: false,
        status: "releasing",
        updatedAt: Date.now(),
      });
      await ctx.scheduler.runAfter(
        0,
        internal.functions.fastSearchProvision.releaseIndex,
        { workspaceId: args.workspaceId },
      );
    }
    await recordAudit(ctx, {
      workspaceId: args.workspaceId,
      actorUserId: args.actorUserId,
      action: "search.fast_disabled",
    });
    return { state: "unavailable" };
  }

  if (
    existing?.generation === FAST_SEARCH_GENERATION &&
    existing.optedIn &&
    existing.status !== "failed"
  ) {
    return { state: fastSearchState(workspace, plan, existing) };
  }

  const now = Date.now();
  if (existing === null) {
    await ctx.db.insert("searchIndexes", {
      workspaceId: args.workspaceId,
      generation: FAST_SEARCH_GENERATION,
      optedIn: true,
      optedInBy: args.actorUserId,
      optedInAt: now,
      status: "provisioning",
      createdAt: now,
      updatedAt: now,
    });
  } else {
    /*
      A LEGACY row starts clean; a failed or releasing one keeps its handle.

      Letting go of `databaseId` is right for legacy coordinates — they name a
      database in the retired account, which is never served and must never be
      mistaken for one here. It is wrong for every row on the current
      generation, and both of the states that reach this branch on it hold a
      live database: a `failed` row records `databaseId` before applying the
      schema, precisely so a schema failure knows what it created, and a
      `releasing` row exists for no other purpose than to be deleted.

      Clearing there strands them. `releaseIndex` reaches a database only
      through `binding.databaseId`; without it, it calls `forgetIndex` and
      reports `released: true` having deleted nothing — so "off actually
      deletes it" quietly stops being true and a derived copy of somebody's
      notes outlives the context that asked for it.

      Which is the same condition `enable` already applies for the same
      reason. This is that decision reached from billing instead of from the
      owner's switch, so it had better be the same decision.
    */
    await ctx.db.patch(existing._id, {
      generation: FAST_SEARCH_GENERATION,
      optedIn: true,
      optedInBy: args.actorUserId,
      optedInAt: now,
      status: "provisioning",
      errorCode: undefined,
      error: undefined,
      ...(existing.generation === FAST_SEARCH_GENERATION
        ? {}
        : {
            databaseId: undefined,
            databaseName: undefined,
            schemaVersion: undefined,
            notesIndexed: undefined,
            notesPending: undefined,
          }),
      updatedAt: now,
    });
  }
  await recordAudit(ctx, {
    workspaceId: args.workspaceId,
    actorUserId: args.actorUserId,
    action: "search.fast_enabled",
    details: { generation: FAST_SEARCH_GENERATION },
  });
  await ctx.scheduler.runAfter(
    0,
    internal.functions.fastSearchProvision.provisionIndex,
    { workspaceId: args.workspaceId, generation: FAST_SEARCH_GENERATION },
  );
  return { state: "preparing" };
}
