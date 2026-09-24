/**
 * The handlers for `fastSearch.enable`, `disable` and `releaseForStorage`.
 *
 * Split out of `functions/fastSearch.ts` — see that file's header for the
 * gate this surfaces and the owner-only rules around it, and see each
 * export's own doc comment there for its rules.
 */

import { ConvexError } from "convex/values";
import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { recordAudit } from "../audit";
import { requireWorkspaceRole } from "../workspaceAuth";
import {
  FAST_SEARCH_GENERATION,
  fastSearchEntitled,
  fastSearchState,
  type FastSearchState,
} from "../fastSearch";
import { bindingFor, planFor, requireUserId } from "./helpers";

export async function enableHandler(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces"> },
): Promise<{ state: FastSearchState }> {
  const userId = await requireUserId(ctx);
  const { workspace } = await requireWorkspaceRole(
    ctx,
    args.workspaceId,
    userId,
    "owner",
  );

  const plan = await planFor(ctx, args.workspaceId);
  if (!fastSearchEntitled(workspace, plan)) {
    throw new ConvexError({
      code: "NOT_ENTITLED",
      message: "Fast search is not available for this context.",
    });
  }

  const existing = await bindingFor(ctx, args.workspaceId);
  const now = Date.now();

  if (existing !== null && existing.optedIn && existing.status !== "failed") {
    // Already on or on its way. Not an error, and not a second database.
    //
    // `failed` is excluded, and that exclusion is the whole point of the
    // condition rather than a refinement of it. A failed row keeps
    // `optedIn: true` — nobody opted out, the provision fell over — so
    // without this clause every retry landed here and returned the failure
    // it was called to clear: no patch, no schedule, no write of any kind.
    // The card's "Try again" was inert for the one state that renders it,
    // and the branch immediately below, whose comment already said "a failed
    // one being retried", was unreachable from the moment it was written.
    // Shipped that way, and found only by reading `updatedAt` on a row a
    // person had pressed the button on repeatedly: it still held the
    // timestamp of the original failure, hours earlier.
    return { state: fastSearchState(workspace, plan, existing) };
  }

  if (existing !== null) {
    // A row that is `releasing`, or a failed one being retried. Re-opting in
    // reuses the row rather than racing a second one against the unique
    // lookup — and deliberately keeps `databaseId` if the release had not
    // finished, so the sweep still knows what to delete if this fails again.
    await ctx.db.patch(existing._id, {
      generation: FAST_SEARCH_GENERATION,
      optedIn: true,
      optedInBy: userId,
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
  } else {
    await ctx.db.insert("searchIndexes", {
      workspaceId: args.workspaceId,
      generation: FAST_SEARCH_GENERATION,
      optedIn: true,
      optedInBy: userId,
      optedInAt: now,
      status: "provisioning",
      createdAt: now,
      updatedAt: now,
    });
  }

  await recordAudit(ctx, {
    workspaceId: args.workspaceId,
    actorUserId: userId,
    action: "search.fast_enabled",
  });

  await ctx.scheduler.runAfter(
    0,
    internal.functions.fastSearchProvision.provisionIndex,
    { workspaceId: args.workspaceId, generation: FAST_SEARCH_GENERATION },
  );

  return { state: "preparing" };
}

/**
 * Release this context's projection because its **storage** went away.
 *
 * ## Why the opt-out is not the only door
 *
 * A row with a `databaseId` names a real, billed D1 database holding this
 * context's notes — titles, headings, tags, body chunks. `disable` releases it
 * when somebody turns the feature off and the account cascade releases it when
 * the workspace is deleted, and both of those were written down as the complete
 * set. They were not: **disconnecting storage** deletes the credential row and
 * left the projection where it was, so a customer who revoked our key still had
 * a copy of their notes on our infrastructure with nothing pointing at it.
 * That is the outcome the opt-out exists to prevent, reached by a door nobody
 * had checked, and non-negotiable #1 is what makes it a defect rather than
 * untidiness.
 *
 * A **rebind onto different storage** is the same fact arriving differently:
 * the projection describes a bucket this workspace is no longer bound to, so
 * it is stale as well as retained, and searching it answers out of somewhere
 * the person has moved away from. Its caller decides which rebinds are that —
 * a repair onto the same bucket keeps what it has, or rotating an access key
 * would cost a re-provision every time.
 *
 * ## It opts out, and that is deliberate rather than incidental
 *
 * `releaseIndex` refuses a row that is still `optedIn`, correctly: a release in
 * flight must not delete a database the provisioner is rebuilding. So a release
 * means opting out, and somebody reconnecting storage turns fast search back on
 * themselves. Keeping the switch on through a disconnect would mean either
 * re-provisioning against a bucket that is not there, or teaching the release
 * path to ignore the flag that protects it.
 *
 * Internal, and no role check of its own: both callers are owner-gated
 * mutations that have already established who is asking. The audit line is
 * theirs too — this records nothing, because "storage was disconnected" is the
 * event, and a second row saying the index went with it would be bookkeeping
 * about bookkeeping.
 */
export async function releaseForStorageHandler(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces"> },
): Promise<{ releasing: boolean }> {
  const existing = await bindingFor(ctx, args.workspaceId);
  if (existing === null) return { releasing: false };

  if (
    existing.generation !== FAST_SEARCH_GENERATION ||
    existing.databaseId === undefined
  ) {
    // Nothing was ever created, so there is nothing to delete and the row is
    // a tombstone rather than a pointer. Same branch `disable` takes.
    await ctx.db.delete(existing._id);
    return { releasing: false };
  }

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
  return { releasing: true };
}

export async function disableHandler(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces"> },
): Promise<{ state: FastSearchState }> {
  const userId = await requireUserId(ctx);
  const { workspace } = await requireWorkspaceRole(
    ctx,
    args.workspaceId,
    userId,
    "owner",
  );

  const existing = await bindingFor(ctx, args.workspaceId);
  const plan = await planFor(ctx, args.workspaceId);
  if (existing === null) return { state: fastSearchState(workspace, plan, null) };

  const now = Date.now();

  if (
    existing.generation !== FAST_SEARCH_GENERATION ||
    existing.databaseId === undefined
  ) {
    // Nothing was ever created — a failed provision, or an opt-in that was
    // reversed before it got that far. There is nothing to delete, so the
    // row goes now and the context is back to "never asked".
    await ctx.db.delete(existing._id);
  } else {
    await ctx.db.patch(existing._id, {
      optedIn: false,
      status: "releasing",
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(
      0,
      internal.functions.fastSearchProvision.releaseIndex,
      { workspaceId: args.workspaceId },
    );
  }

  await recordAudit(ctx, {
    workspaceId: args.workspaceId,
    actorUserId: userId,
    action: "search.fast_disabled",
  });

  return { state: "off" };
}
