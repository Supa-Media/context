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
  BACKFILL_STALL_MS,
  PROJECTION_CHAIN,
  backfillPercent,
  fastSearchEntitled,
  fastSearchState,
  searchProjectionState,
  type FastSearchState,
  type SearchProjectionState,
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
  /**
   * The same census as one number, and therefore **under the same gate**.
   *
   * The two counters above are owner-only because a member may read only the
   * `team` tier, so a total that includes private notes lets them derive how
   * much they are not being shown. A percentage IS that total, divided — it
   * moves when a private note is written and it stops moving when the backfill
   * ends, which is the whole of what the counters leak. It leaks it while
   * looking like a progress bar rather than like a count, which is precisely
   * how a gate gets left off the second field.
   *
   * Both forms are returned rather than one, because the console renders a bar
   * and a "41 of 48" line from the same read and neither should be a second
   * round trip. `undefined` for anyone but an owner — the test that says so is
   * the one that matters most in `fastSearch.test.ts`.
   *
   * **Absent and `0` are different answers**, and the console reads them that
   * way: absent means "this viewer does not get this" and draws nothing, while
   * any number is a state to render. So a member gets no field rather than a
   * zero, and so does a context with no notes at all — "0 of 0" is not a
   * percentage of anything, and the console says so in words.
   *
   * **100 belongs to `ready`.** Whether a backfill is finished is `state`, which
   * this control plane owns; it is never inferred from `notesPending === 0`, and
   * a row that is not serving is capped at 99 so a completed bar cannot appear
   * beside a card that says the index is still being built.
   *
   * Always a finite integer in 0–100 when present, because the console range-
   * checks and falls back to computing the ratio itself — and a fallback that
   * fires is a second implementation of `backfillPercent` running in production.
   *
   * Derived on every read and never stored: see `backfillPercent` for why a
   * stored ratio goes stale against a corpus that moves, and for what each
   * edge case answers.
   */
  percentIndexed?: number;
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
    // Owner only for the same reason, and it is the same number: see the type.
    percentIndexed: v.optional(v.number()),
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
    const state = fastSearchState(workspace, binding);

    return {
      state,
      canChange: isOwner && fastSearchEntitled(workspace),
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

/* -------------------------------------------------------------------------- */
/*                     which contexts a blended search may ask                */
/* -------------------------------------------------------------------------- */

/**
 * Contexts one person may search at once.
 *
 * The same order of magnitude as `listMyWorkspaces`' own cap and for the same
 * reason: a bounded read rather than a scan whose cost is somebody's
 * membership count. A fan-out has a second reason — every context in this list
 * is a request to a customer's storage, so the number is also the width of the
 * widest search anybody can cause with one keystroke.
 */
const SEARCHABLE_CONTEXT_CAP = 50;

/** A context the blended search may include, and what the page renders it as. */
export interface SearchableContext {
  workspaceId: Id<"workspaces">;
  slug: string;
  displayName: string;
  kind: string;
  role: string;
}

const searchableContextValidator = v.object({
  workspaceId: v.id("workspaces"),
  slug: v.string(),
  displayName: v.string(),
  kind: v.string(),
  role: v.string(),
});

/**
 * The contexts this person may run a blended search over.
 *
 * Two conditions, and both are live:
 *
 *  1. **A membership row exists right now.** Not "existed when the page
 *     loaded" — the search page re-asks this on every page of every query, so
 *     somebody removed from a workspace between two pages stops being able to
 *     search it, rather than keeping the scope chip they already had.
 *  2. **Fast search is serving.** `searchProjectionState(...) === "ready"` is
 *     the same composed gate `projectionTargetForWorkspace` applies — owner
 *     opted in, entitled, provisioned, schema on it. A `backfilling` context
 *     is excluded on purpose: its projection answers a query about a note it
 *     has not copied yet with a silence a blended list would render as
 *     "nothing here", which is the one thing search must never say wrongly.
 *
 * ## Why the fan-out is fast-search-only, and what it costs
 *
 * A context without a projection answers from the R2 shard index in the
 * customer's own bucket: a manifest read, some shard reads, and a snippet read
 * per hit. That is fine for one context with a person watching one spinner, and
 * it does not fan out — eight contexts is eight buckets' worth of round trips
 * inside one request's deadline, most of them for contexts the word is not in.
 *
 * So the blended page searches the contexts that can answer from a database.
 * The cost is honest and has to be said on screen rather than hidden: a
 * context whose owner has not turned fast search on is **not searched and not
 * silently missing** — the page names the eligible set it searched, and a
 * person with no eligible contexts is told that rather than shown an empty
 * list. `docs/decisions/search.md` records the trade.
 *
 * A context is named here only because the caller is in it, so this list is
 * not an oracle: it enumerates the caller's own memberships, which
 * `listMyWorkspaces` already returns in full.
 */
async function searchableFor(
  ctx: QueryCtx,
  userId: Id<"users">,
): Promise<SearchableContext[]> {
  const memberships = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(SEARCHABLE_CONTEXT_CAP);

  const searchable: SearchableContext[] = [];
  for (const membership of memberships) {
    const workspace = await ctx.db.get(membership.workspaceId);
    if (workspace === null) continue;
    const binding = await bindingFor(ctx, membership.workspaceId);
    if (searchProjectionState(workspace, binding) !== "ready") continue;
    searchable.push({
      workspaceId: workspace._id,
      slug: workspace.slug,
      displayName: workspace.displayName,
      kind: workspace.kind,
      role: membership.role,
    });
  }
  return searchable.sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * The scope picker's list: every context this viewer can search.
 *
 * Public, and readable by any member — it names contexts the caller belongs to
 * and nothing else. It carries no counts: how many notes a context holds is the
 * census `status` keeps owner-only, and a list of contexts with note totals
 * beside them would be that census in a different shape.
 */
export const searchableContexts = query({
  args: {},
  returns: v.array(searchableContextValidator),
  handler: async (ctx): Promise<SearchableContext[]> => {
    const userId = await requireUserId(ctx);
    return await searchableFor(ctx, userId);
  },
});

/**
 * The same list, for the blended search action to resolve its scope from.
 *
 * INTERNAL, and `actorUserId` comes from the session in the public action that
 * calls it — the arrangement `authorizeFileAccess` documents. It exists
 * separately from the query above because an action cannot call a public query
 * with the caller's identity attached, and because the two must not drift: a
 * scope picker that offered a context the fan-out would refuse, or the reverse,
 * is a chip that does nothing.
 */
export const searchableContextsFor = internalQuery({
  args: { actorUserId: v.id("users") },
  returns: v.array(searchableContextValidator),
  handler: async (ctx, args): Promise<SearchableContext[]> =>
    await searchableFor(ctx, args.actorUserId),
});

// -- internals ------------------------------------------------------------

/** Contexts one sweep may restart. See `sweepStalledBackfills`. */
const SWEEP_BATCH = 50;

/** The binding, for the provisioner and for the gateway's session resolution. */
export const bindingForWorkspace = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args): Promise<Doc<"searchIndexes"> | null> =>
    await bindingFor(ctx, args.workspaceId),
});

/**
 * May the gateway write a projection into this context's database, and where?
 *
 * The narrowest possible answer: a database id and a state, or `null`. Not the
 * row — `openStorageBinding` has no business with `optedInBy`, an error
 * sentence or a schema version, and a caller that receives a whole row is a
 * caller that will one day forward one.
 *
 * **This is where the policy lives, not at the route.** `searchProjectionState`
 * composes entitlement, the owner's opt-in, a recorded database id and a status
 * that means the schema is on it. Every reason to say no returns the same
 * `null`, which matters here more than usual: this answer decides whether a D1
 * write credential leaves the deployment, and the difference between "that
 * context opted out" and "that context does not exist" is not something the
 * gateway needs or should be able to observe.
 *
 * `workspaceId` is not the caller's to choose. Its one caller derives it from
 * the grant a presented access token resolved to and passes the id off that
 * row — the same two-factor property `openStorageBinding`'s header is about,
 * and the reason this query is internal and reachable from exactly one place.
 */
export const projectionTargetForWorkspace = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.union(
    v.null(),
    v.object({
      databaseId: v.string(),
      state: v.union(v.literal("backfilling"), v.literal("ready")),
    }),
  ),
  handler: async (
    ctx,
    args,
  ): Promise<{ databaseId: string; state: SearchProjectionState } | null> => {
    const workspace = await ctx.db.get(args.workspaceId);
    if (workspace === null) return null;
    const binding = await bindingFor(ctx, args.workspaceId);
    const state = searchProjectionState(workspace, binding);
    if (state === null) return null;
    return { databaseId: binding!.databaseId as string, state };
  },
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

/**
 * The gateway reporting how far its projection has got.
 *
 * `/gateway/search-index/progress` is the wire; this is the policy, and the
 * split is the point. **The control plane owns this row.** The gateway knows
 * how many notes it has written and nothing else — not whether the owner has
 * since turned the feature off, not whether a release is in flight, not whether
 * the row it is reporting about is the row it was handed a credential for ten
 * minutes ago. So the report is data, and every question about whether it may
 * be applied is answered here.
 *
 * Three refusals, and each is a way somebody's decision could be undone by a
 * job that outlived it:
 *
 *  - **Not opted in.** `searchProjectionState` is the same composed gate the
 *    binding response uses, so a context that never asked, one whose owner
 *    opted out, and one that is not entitled are refused by the function that
 *    decided the credential should never have been handed over either. Two
 *    call sites, one rule; a second copy of it is a second place for them to
 *    disagree about what "on" means.
 *  - **Never resurrect a `releasing` row.** That row is `optedIn: false` and
 *    exists only so the delete can find its database. A progress report is the
 *    late arrival of exactly the shape `recordProvisionResult` already refuses:
 *    a success for something somebody asked us to destroy. Writing counters
 *    onto it would be harmless; moving it to `ready` would put a database
 *    mid-delete back into service, so both are refused together rather than
 *    the interesting one alone.
 *  - **`ready` is a transition, not an assignment.** It is reached only from
 *    `backfilling` — a `failed` or `provisioning` row is not something a
 *    backfill report may declare finished, and neither is a row that is not
 *    serving. Idempotent from `ready`, because a gateway that finishes twice
 *    must not be an error.
 *
 * The counters are stored raw and the percentage is derived on read
 * (`backfillPercent`), so a total that shrinks mid-backfill cannot leave a
 * ratio behind that was true of a corpus that no longer exists.
 *
 * `applied` is for tests and for this deployment's own logs. The route answers
 * identically either way, because a caller holding the gateway secret must not
 * be able to use this as an oracle for which contexts have opted in.
 */
export const recordProjectionProgress = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    notesIndexed: v.number(),
    notesPending: v.number(),
    /** The gateway saying the backfill is finished. */
    ready: v.boolean(),
  },
  returns: v.object({ applied: v.boolean() }),
  handler: async (ctx, args): Promise<{ applied: boolean }> => {
    // Re-checked here and not only at the door. The door is one caller; this is
    // the invariant, and a count that is not a non-negative integer would be
    // rendered as a percentage of something.
    if (
      !Number.isInteger(args.notesIndexed) ||
      !Number.isInteger(args.notesPending) ||
      args.notesIndexed < 0 ||
      args.notesPending < 0
    ) {
      return { applied: false };
    }

    const workspace = await ctx.db.get(args.workspaceId);
    if (workspace === null) return { applied: false };
    const binding = await bindingFor(ctx, args.workspaceId);
    // The same gate that decided the credential could be handed over. A row
    // that is `releasing`, `failed`, `provisioning`, opted out or unentitled is
    // refused here, by the one function that knows what "serving" means.
    const state = searchProjectionState(workspace, binding);
    if (state === null) return { applied: false };

    await ctx.db.patch(binding!._id, {
      notesIndexed: args.notesIndexed,
      notesPending: args.notesPending,
      // Only `backfilling` → `ready`. `state` is one of two values here, so a
      // report of `ready` against an already-ready row keeps it ready and a
      // report without `ready` never demotes one — a gateway that reports
      // progress after finishing must not restart the spinner.
      status: args.ready ? "ready" : binding!.status,
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

/**
 * Restart the copy for every context whose backfill has stopped moving.
 *
 * **This is what picks up a context that was left behind rather than one
 * enabled from now on.** `provisionIndex` schedules the first chain, and a
 * chain schedules its own next link — but neither reaches a row that reached
 * `backfilling` before any of that existed. Those rows are not reachable
 * through `enable` either: it returns early for a row that is already opted in
 * and not `failed`, so pressing the switch again does nothing at all. Without
 * a sweep they would wait forever for a search that may never come, which is
 * the state three production contexts were in when this was written.
 *
 * It is also the retry. A chain can be lost the way any scheduled job can —
 * a deploy, an eviction, a failure while recording a failure — and the row it
 * left behind looks exactly like the ones above.
 *
 * ## How it knows not to start a second chain
 *
 * `updatedAt` is a heartbeat: every link that moves anything writes counters
 * onto the row, so a working chain looks recent and a dead one looks stale.
 * Reading the row rather than the scheduler's own table is deliberate — the
 * case this exists for is a context with nothing scheduled *and no record that
 * anything ever was*, which a scheduler-table check cannot see.
 *
 * Two passes on one database is not a correctness failure (the census is a
 * `COUNT(*)` over a keyed table, and every projection deletes before it
 * inserts), but it is the one thing that can leave a note duplicate chunk
 * rows, so the quiet window exists to avoid causing it on purpose.
 *
 * ## What it does not do
 *
 * It holds no decision, which is the rule for everything a cron reaches. It
 * does not decide whether a context may have a projection — that is
 * `searchProjectionState`, re-asked by the pass itself before it opens
 * anything — and it does not retry a `failed` row, because a failure is a
 * sentence somebody is being shown and "Try again" is theirs to press.
 */
export const sweepStalledBackfills = internalMutation({
  args: {},
  returns: v.object({ started: v.number() }),
  handler: async (ctx): Promise<{ started: number }> => {
    const now = Date.now();
    const rows = await ctx.db
      .query("searchIndexes")
      .withIndex("by_status", (q) => q.eq("status", "backfilling"))
      // Bounded, like every other sweep here: a backlog drains over several
      // runs rather than in one transaction big enough to hit a limit.
      .take(SWEEP_BATCH);

    let started = 0;
    for (const row of rows) {
      // A `backfilling` row that is not opted in should not exist — `disable`
      // moves it to `releasing` — but a status index is a poor place to trust
      // an invariant that lives on another field.
      if (!row.optedIn) continue;
      if (now - row.updatedAt < BACKFILL_STALL_MS) continue;
      await ctx.scheduler.runAfter(0, internal.functions.files.runFileOperation, {
        workspaceId: row.workspaceId,
        scope: "private",
        operation: { kind: "projectIndex", passes: PROJECTION_CHAIN },
      });
      started += 1;
    }
    return { started };
  },
});
