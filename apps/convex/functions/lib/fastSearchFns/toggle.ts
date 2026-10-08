/**
 * The handlers for `fastSearch.enable`, `disable` and `releaseForStorage`.
 *
 * Split out of `functions/fastSearch.ts` — see that file's header for the
 * gate this surfaces and the owner-only rules around it, and see each
 * export's own doc comment there for its rules.
 */

import { ConvexError } from "convex/values";
import { internal } from "../../../_generated/api";
import type { Doc, Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { recordAudit } from "../audit";
import { requireWorkspaceRole } from "../workspaceAuth";
import {
  FAST_SEARCH_GENERATION,
  fastSearchEntitled,
  fastSearchState,
  type FastSearchState,
} from "../fastSearch";
import { bindingFor, requireUserId } from "./helpers";

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

  if (!fastSearchEntitled(workspace)) {
    throw new ConvexError({
      code: "NOT_ENTITLED",
      message: "Fast search is not available for this context.",
    });
  }

  const existing = await bindingFor(ctx, args.workspaceId);
  if (
    existing !== null &&
    existing.generation === FAST_SEARCH_GENERATION &&
    existing.optedIn &&
    existing.status !== "failed"
  ) {
    // Already on or on its way. Not an error, and not a second database.
    //
    // `failed` is excluded, and that exclusion is the whole point of the
    // condition rather than a refinement of it: a failed row keeps
    // `optedIn: true`, so without this clause "Try again" returned the
    // failure it was called to clear and wrote nothing.
    return { state: fastSearchState(workspace, existing) };
  }

  await turnOn(ctx, args.workspaceId, existing, userId);
  await recordAudit(ctx, {
    workspaceId: args.workspaceId,
    actorUserId: userId,
    action: "search.fast_enabled",
  });
  return { state: "preparing" };
}

/**
 * "On for everyone" asking for one workspace (decided by the owner,
 * 2026-10-08). It only ever creates a row: any row at all, an owner's `off`
 * above all, means somebody already decided, and Context does not decide over
 * them. Returns whether it scheduled a provision.
 */
export async function autoEnableHandler(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces"> },
): Promise<{ scheduled: boolean }> {
  const workspace = await ctx.db.get(args.workspaceId);
  if (workspace === null || !fastSearchEntitled(workspace)) return { scheduled: false };
  const existing = await bindingFor(ctx, args.workspaceId);
  // A row from the retired generation never serves and is nobody's decision
  // under this one, unless it records an owner's off.
  const legacy = existing !== null && existing.generation !== FAST_SEARCH_GENERATION;
  if (existing !== null && !(legacy && existing.optedOut !== true)) return { scheduled: false };
  await turnOn(ctx, args.workspaceId, existing, undefined);
  return { scheduled: true };
}

/**
 * Switch a row on and schedule the provisioner. An existing row (`releasing`,
 * `failed` or `off`) is reused rather than racing a second one against the
 * unique lookup, and keeps `databaseId` if a release had not finished, so the
 * sweep still knows what to delete if this fails again.
 */
async function turnOn(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  existing: Doc<"searchIndexes"> | null,
  by: Id<"users"> | undefined,
): Promise<void> {
  const now = Date.now();
  if (existing !== null) {
    await ctx.db.patch(existing._id, {
      generation: FAST_SEARCH_GENERATION,
      optedIn: true,
      optedInBy: by,
      optedInAt: now,
      optedOut: undefined,
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
            priorities: undefined,
          }),
      updatedAt: now,
    });
  } else {
    await ctx.db.insert("searchIndexes", {
      workspaceId,
      generation: FAST_SEARCH_GENERATION,
      optedIn: true,
      ...(by ? { optedInBy: by } : {}),
      optedInAt: now,
      status: "provisioning",
      createdAt: now,
      updatedAt: now,
    });
  }
  await ctx.scheduler.runAfter(
    0,
    internal.functions.fastSearchProvision.provisionIndex,
    { workspaceId, generation: FAST_SEARCH_GENERATION },
  );
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
 * ## It switches off, and the rollout switches it back on
 *
 * `releaseIndex` refuses a row that is still `optedIn`, correctly: a release in
 * flight must not delete a database the provisioner is rebuilding. So a release
 * means switching off, and the row goes when the database does, so "on for
 * everyone" picks the workspace up again once it reconnects storage. An
 * owner's `off` is the exception: it is their decision, not the bucket's, and
 * it stays.
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
    // Nothing was ever created, so there is nothing to delete. The row goes,
    // unless it is the owner's `off`, which outlives a disconnect.
    if (existing.optedOut !== true) await ctx.db.delete(existing._id);
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

/**
 * The owner's off. The database is deleted and the row stays, ending at `off`,
 * so "on for everyone" never turns it back on; only the owner can. Off before
 * the rollout reached this workspace is recorded the same way.
 */
export async function disableHandler(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces"> },
): Promise<{ state: FastSearchState }> {
  const userId = await requireUserId(ctx);
  await requireWorkspaceRole(ctx, args.workspaceId, userId, "owner");

  const existing = await bindingFor(ctx, args.workspaceId);
  const now = Date.now();

  if (existing === null) {
    await ctx.db.insert("searchIndexes", {
      workspaceId: args.workspaceId,
      generation: FAST_SEARCH_GENERATION,
      optedIn: false,
      optedOut: true,
      optedInAt: now,
      status: "off",
      createdAt: now,
      updatedAt: now,
    });
  } else if (
    existing.generation !== FAST_SEARCH_GENERATION ||
    existing.databaseId === undefined
  ) {
    // Nothing was ever created: a failed provision, or one reversed before it
    // got that far. There is nothing to delete, so the row is `off` now.
    await ctx.db.patch(existing._id, {
      generation: FAST_SEARCH_GENERATION,
      optedIn: false,
      optedOut: true,
      status: "off",
      databaseId: undefined,
      databaseName: undefined,
      schemaVersion: undefined,
      errorCode: undefined,
      error: undefined,
      notesIndexed: undefined,
      notesPending: undefined,
      priorities: undefined,
      updatedAt: now,
    });
  } else {
    await ctx.db.patch(existing._id, {
      optedIn: false,
      optedOut: true,
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
