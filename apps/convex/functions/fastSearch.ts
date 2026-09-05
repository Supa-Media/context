/**
 * Turning fast search on and off for one context.
 *
 * The gate itself — what "on" means and why it is two conditions — is
 * `lib/fastSearch.ts`. This file is the surface: one query the settings screen
 * reads, and two mutations an **owner** calls.
 *
 * ## Owner-only, and why that is not the same as write access
 *
 * `requireWorkspaceRole(..., "owner")` on both mutations. An editor may write
 * every note in a context; deciding that a derived copy of all of them is kept
 * in a database Supa Media owns is a different authority, and the role list
 * exists so those can be different (CLAUDE.md, "Membership carries an explicit
 * role. Write access to someone else's context is never implied by read.").
 *
 * ## Opting out deletes, and the row survives the delete
 *
 * `disable` does not remove the row. It marks it `releasing` and schedules the
 * remote delete, because a row deleted before its database is a database
 * nothing will ever clean up — a derived copy of somebody's private notes,
 * orphaned on our infrastructure, that no code path can now find. The row is
 * removed by the release once Cloudflare confirms the database is gone.
 *
 * A `releasing` row serves nothing: `fastSearchOptedIn` reads `optedIn`, which
 * is already false. So the moment somebody switches off, search returns to the
 * R2 index — the delete finishing is bookkeeping, not the switch.
 */

import { ConvexError, v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type QueryCtx,
} from "../_generated/server";
import { recordAudit } from "./lib/audit";
import { requireWorkspaceAccess, requireWorkspaceRole } from "./lib/workspaceAuth";
import {
  fastSearchEntitled,
  fastSearchState,
  type FastSearchState,
} from "./lib/fastSearch";

async function requireUserId(ctx: QueryCtx): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) {
    throw new ConvexError({
      code: "NOT_AUTHENTICATED",
      message: "Sign in first.",
    });
  }
  return userId;
}

async function bindingFor(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
): Promise<Doc<"searchIndexes"> | null> {
  return await ctx.db
    .query("searchIndexes")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
}

export interface FastSearchStatus {
  state: FastSearchState;
  /** Whether the viewer may change it. Rendering only; the mutation re-checks. */
  canChange: boolean;
  /**
   * Backfill progress — present while backfilling, **and absent to everyone
   * but the owner.**
   *
   * The index counts every note the context has, private ones included, while
   * a member may read only the `team` tier. Handing them the total would let
   * them derive how much they are not being shown, and watch it move. Same
   * rule, same shape, as `getStorageBinding`'s `noteCount`.
   */
  notesIndexed?: number;
  notesPending?: number;
  /** Set only in `failed`. Our sentence, never a provider's. */
  error?: string;
  optedInAt?: number;
}

/**
 * The wire form of `FastSearchState`.
 *
 * Declared once so the three functions returning it cannot disagree with each
 * other. It does **not** tie itself to the union in `lib/fastSearch.ts` — that
 * is a type and this is a value, and nothing checks them against one another.
 * A sixth state added there would leave this stale.
 *
 * The direction that failure takes is why it is acceptable rather than merely
 * noted: Convex validates a return against this at runtime, so the new state
 * would be **refused** and every test covering it would fail loudly. A stale
 * validator here breaks the feature; it cannot widen what a caller sees.
 *
 * `structure.test.ts` requires the `returns:` itself: without one, a public
 * function hands the credential guard a return schema of `"null"`, which it
 * reads and passes whatever the function actually returns.
 */
const stateValidator = v.union(
  v.literal("off"),
  v.literal("preparing"),
  v.literal("on"),
  v.literal("failed"),
  v.literal("unavailable"),
);

/**
 * What the settings screen draws.
 *
 * Readable by any member — knowing how a context's search is served is not
 * privileged — but `canChange` is false for anyone but an owner, and the
 * mutations below re-derive that server-side rather than trusting it.
 *
 * THE BACKFILL COUNTERS ARE OWNER-ONLY, and they are the exception that shows
 * why the sentence above needs a limit. "How search is served" covers `state`
 * and `canChange`; it does not cover `notesIndexed` and `notesPending`, which
 * are not a property of the search at all but a CENSUS OF THE NOTES — and the
 * index they count holds private notes, as `fastSearch.test.ts` says in its
 * first paragraph. A member who cannot read a private note has no business
 * reading a total that includes it, still less watching that total move as
 * private notes are written and deleted; SECURITY.md counts inferring that a
 * private note exists as a bug in its own right.
 *
 * Gated on `role === "owner"` and deliberately NOT on `canChange`, which is
 * ownership AND entitlement: an owner whose context is not entitled still owns
 * the notes and still gets their own progress figures. Today the two cannot
 * come apart — `fastSearchEntitled` is true for both workspace kinds and the
 * schema refuses a third — so that choice is unpinnable by any test, which
 * `fastSearch.test.ts` records rather than pretending otherwise.
 *
 * `error` is served to every member and that is fine, though the schema calls
 * it owner-facing: it is always `messageFor(code)` from a closed set of our own
 * sentences, never a provider's text and never a path or a credential.
 */
export const status = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({
    state: stateValidator,
    canChange: v.boolean(),
    // Owner only — a census of notes a member may not read. See the type above.
    notesIndexed: v.optional(v.number()),
    notesPending: v.optional(v.number()),
    error: v.optional(v.string()),
    optedInAt: v.optional(v.number()),
  }),
  handler: async (ctx, args): Promise<FastSearchStatus> => {
    const userId = await requireUserId(ctx);
    const { workspace, membership } = await requireWorkspaceAccess(
      ctx,
      args.workspaceId,
      userId,
    );
    const binding = await bindingFor(ctx, args.workspaceId);

    const isOwner = membership.role === "owner";

    return {
      state: fastSearchState(workspace, binding),
      canChange: isOwner && fastSearchEntitled(workspace),
      notesIndexed: isOwner ? binding?.notesIndexed : undefined,
      notesPending: isOwner ? binding?.notesPending : undefined,
      error: binding?.error,
      optedInAt: binding?.optedInAt,
    };
  },
});

/**
 * Turn it on.
 *
 * Idempotent: calling it on a context that is already on, or already
 * provisioning, changes nothing and reports the current state. That matters
 * because the screen's switch can be pressed twice, and because the second
 * press must not provision a second database.
 *
 * The provisioning itself is **scheduled**, not called: it needs the
 * Cloudflare token, which only an action may open, and scheduling is not
 * calling — the scheduler discards the result, so no credential can flow back
 * into this mutation. Same shape `bindStorage` uses.
 */
export const enable = mutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({ state: stateValidator }),
  handler: async (ctx, args): Promise<{ state: FastSearchState }> => {
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
      return { state: fastSearchState(workspace, existing) };
    }

    if (existing !== null) {
      // A row that is `releasing`, or a failed one being retried. Re-opting in
      // reuses the row rather than racing a second one against the unique
      // lookup — and deliberately keeps `databaseId` if the release had not
      // finished, so the sweep still knows what to delete if this fails again.
      await ctx.db.patch(existing._id, {
        optedIn: true,
        optedInBy: userId,
        optedInAt: now,
        status: "provisioning",
        errorCode: undefined,
        error: undefined,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("searchIndexes", {
        workspaceId: args.workspaceId,
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
      { workspaceId: args.workspaceId },
    );

    return { state: "preparing" };
  },
});

/**
 * Turn it off, and delete what it built.
 *
 * The row is marked rather than removed — see the header. Search falls back to
 * the R2 index the instant `optedIn` goes false, so nothing here is on a
 * person's critical path.
 */
export const disable = mutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({ state: stateValidator }),
  handler: async (ctx, args): Promise<{ state: FastSearchState }> => {
    const userId = await requireUserId(ctx);
    const { workspace } = await requireWorkspaceRole(
      ctx,
      args.workspaceId,
      userId,
      "owner",
    );

    const existing = await bindingFor(ctx, args.workspaceId);
    if (existing === null) return { state: fastSearchState(workspace, null) };

    const now = Date.now();

    if (existing.databaseId === undefined) {
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
  },
});

// -- internals ------------------------------------------------------------

/** The binding, for the provisioner and for the gateway's session resolution. */
export const bindingForWorkspace = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args): Promise<Doc<"searchIndexes"> | null> =>
    await bindingFor(ctx, args.workspaceId),
});

/**
 * Record what provisioning did.
 *
 * Every field the provisioner may move, in one mutation, so a half-applied
 * outcome is not a thing that can happen across two of them. A patch that
 * arrives for a row whose owner has since opted out is **dropped**: the
 * release is already scheduled, and re-marking it `ready` would resurrect a
 * database somebody asked us to delete.
 */
export const recordProvisionResult = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    status: v.union(
      v.literal("provisioning"),
      v.literal("backfilling"),
      v.literal("ready"),
      v.literal("failed"),
    ),
    databaseId: v.optional(v.string()),
    databaseName: v.optional(v.string()),
    schemaVersion: v.optional(v.number()),
    errorCode: v.optional(v.string()),
    error: v.optional(v.string()),
    notesIndexed: v.optional(v.number()),
    notesPending: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await bindingFor(ctx, args.workspaceId);
    if (existing === null) return { applied: false };
    if (!existing.optedIn) {
      // Opted out while this was in flight. The database id is still recorded
      // if the provisioner learned one, because the release needs it — but the
      // status stays `releasing` and nothing starts serving.
      if (args.databaseId !== undefined && existing.databaseId === undefined) {
        await ctx.db.patch(existing._id, {
          databaseId: args.databaseId,
          databaseName: args.databaseName,
          updatedAt: Date.now(),
        });
      }
      return { applied: false };
    }

    await ctx.db.patch(existing._id, {
      status: args.status,
      databaseId: args.databaseId ?? existing.databaseId,
      databaseName: args.databaseName ?? existing.databaseName,
      schemaVersion: args.schemaVersion ?? existing.schemaVersion,
      errorCode: args.errorCode,
      error: args.error,
      notesIndexed: args.notesIndexed ?? existing.notesIndexed,
      notesPending: args.notesPending ?? existing.notesPending,
      updatedAt: Date.now(),
    });
    return { applied: true };
  },
});

/** The release finished: the remote database is gone, so the row goes too. */
export const forgetIndex = internalMutation({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args) => {
    const existing = await bindingFor(ctx, args.workspaceId);
    if (existing === null) return { forgotten: false };
    // Only a row that is actually released. A row somebody re-enabled while
    // the delete was in flight must survive — the provisioner will make it a
    // new database, and forgetting it here would strand that one instead.
    if (existing.optedIn || existing.status !== "releasing") {
      return { forgotten: false };
    }
    await ctx.db.delete(existing._id);
    return { forgotten: true };
  },
});
