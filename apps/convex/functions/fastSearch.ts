/**
 * Turning fast search on and off for one context.
 *
 * The gate itself — what "on" means and why it is two conditions — is
 * `lib/fastSearch.ts`. This file is the surface: one query the settings screen
 * reads, two owner mutations, and the internal sync that applies a paid
 * Premium selection.
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
 *
 * Every export below is a thin Convex registration whose handler delegates to
 * `lib/fastSearchFns/`, where the logic (and its comments) actually live.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "../_generated/server";
import { statusHandler } from "./lib/fastSearchFns/status";
import { disableHandler, enableHandler, releaseForStorageHandler } from "./lib/fastSearchFns/toggle";
import { syncPremiumSelectionHandler } from "./lib/fastSearchFns/premium";
import { searchableContextsForHandler, searchableContextsHandler } from "./lib/fastSearchFns/scope";
import {
  bindingForWorkspaceHandler,
  forgetIndexHandler,
  projectionTargetForWorkspaceHandler,
  recordProjectionProgressHandler,
  recordProvisionResultHandler,
  sweepStalledBackfillsHandler,
} from "./lib/fastSearchFns/internal";
import { searchableContextValidator, stateValidator } from "./lib/fastSearchFns/validators";
export type { FastSearchStatus, SearchableContext } from "./lib/fastSearchFns/validators";

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
  handler: (ctx, args) => statusHandler(ctx, args),
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
  handler: (ctx, args) => enableHandler(ctx, args),
});

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
export const releaseForStorage = internalMutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({ releasing: v.boolean() }),
  handler: (ctx, args) => releaseForStorageHandler(ctx, args),
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
  handler: (ctx, args) => disableHandler(ctx, args),
});

/**
 * Apply the paid selection after Stripe activates it, or immediately when an
 * owner changes an already-active plan.
 *
 * This is deliberately a mutation rather than an action: it never opens the
 * D1 credential. It records the consent-backed generation and schedules the
 * existing provisioner, preserving the credential boundary.
 */
export const syncPremiumSelection = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    actorUserId: v.id("users"),
  },
  returns: v.object({ state: stateValidator }),
  handler: (ctx, args) => syncPremiumSelectionHandler(ctx, args),
});

/* -------------------------------------------------------------------------- */
/*                     which contexts a blended search may ask                */
/* -------------------------------------------------------------------------- */

/**
 * The scope picker's list, and the upsell beside it: every context this viewer
 * can search, and — per context — whether it answers from a hosted index or
 * from its own bucket.
 *
 * Public, and readable by any member — it names contexts the caller belongs to
 * and nothing else. It carries no counts: how many notes a context holds is the
 * census `status` keeps owner-only, and a list of contexts with note totals
 * beside them would be that census in a different shape. `owner` is a role
 * read the caller already has everywhere else in this console (an owner sees
 * their own role on every context they belong to); it says nothing about who
 * else holds it.
 *
 * An object rather than the bare array, which is what it answered before the
 * two-list split and what it would otherwise go back to: the page reads a
 * second thing off this query every time the search model grows a field, and
 * a wrapper is the difference between adding one and rewriting every caller.
 */
export const searchableContexts = query({
  args: {},
  returns: v.object({ contexts: v.array(searchableContextValidator) }),
  handler: (ctx) => searchableContextsHandler(ctx),
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
  handler: (ctx, args) => searchableContextsForHandler(ctx, args),
});

// -- internals ------------------------------------------------------------

/** The binding, for the provisioner and for the gateway's session resolution. */
export const bindingForWorkspace = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  handler: (ctx, args) => bindingForWorkspaceHandler(ctx, args),
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
  handler: (ctx, args) => projectionTargetForWorkspaceHandler(ctx, args),
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
    generation: v.optional(v.literal("premium-v1")),
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
  handler: (ctx, args) => recordProvisionResultHandler(ctx, args),
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
  handler: (ctx, args) => recordProjectionProgressHandler(ctx, args),
});

/** The release finished: the remote database is gone, so the row goes too. */
export const forgetIndex = internalMutation({
  args: { workspaceId: v.id("workspaces") },
  handler: (ctx, args) => forgetIndexHandler(ctx, args),
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
  handler: (ctx) => sweepStalledBackfillsHandler(ctx),
});
