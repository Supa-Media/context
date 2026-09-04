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
  /** Present while backfilling, so the screen can be honest rather than spin. */
  notesIndexed?: number;
  notesPending?: number;
  /** Set only in `failed`. Our sentence, never a provider's. */
  error?: string;
  optedInAt?: number;
}

/**
 * What the settings screen draws.
 *
 * Readable by any member — knowing how a context's search is served is not
 * privileged — but `canChange` is false for anyone but an owner, and the
 * mutations below re-derive that server-side rather than trusting it.
 */
export const status = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args): Promise<FastSearchStatus> => {
    const userId = await requireUserId(ctx);
    const { workspace, membership } = await requireWorkspaceAccess(
      ctx,
      args.workspaceId,
      userId,
    );
    const binding = await bindingFor(ctx, args.workspaceId);

    return {
      state: fastSearchState(workspace, binding),
      canChange: membership.role === "owner" && fastSearchEntitled(workspace),
      notesIndexed: binding?.notesIndexed,
      notesPending: binding?.notesPending,
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

    if (existing !== null && existing.optedIn) {
      // Already on or on its way. Not an error, and not a second database.
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
