/**
 * Whether a context's search is served from a database we own.
 *
 * ## Two independent conditions, and they are deliberately not one flag
 *
 * A context gets the fast index only when **both** are true:
 *
 *  1. **Entitled** — may this context turn it on? Derived, never stored.
 *     `fastSearchEntitled` returns true for everyone today; it is the single
 *     line a paid tier later narrows, and it exists now so that narrowing is
 *     an edit to one function rather than a search for every place the
 *     question is asked.
 *  2. **Opted in** — has an owner turned it on? Stored per workspace, and
 *     **off by default**.
 *
 * Folding these into one boolean is the obvious simplification and it loses
 * the distinction that matters: "you are not paying for this" and "you have
 * not asked for this" are different sentences, they need different copy, and
 * one of them must never be answered by a billing state. A customer who
 * stops paying has not consented to anything being deleted or retained
 * differently; a customer who opts out has.
 *
 * ## Why opting in is a decision and not a preference
 *
 * Canonical Markdown stays in the customer's bucket either way — that is the
 * first non-negotiable and nothing here touches it. What turning this on adds
 * is a **derived copy of that context's note text, including private notes, in
 * a database Supa Media owns.** The earlier design put that copy there for
 * everyone by default, which is a choice about somebody else's private notes
 * made on their behalf. Off by default means the copy exists only where
 * somebody asked for it.
 *
 * Three consequences follow, and each is load-bearing rather than tidy:
 *
 *  - **Provisioning happens at the toggle, never at signup.** A context that
 *    never opts in has no database, so there is nothing to secure, nothing to
 *    bill for, and nothing to delete when the account closes.
 *  - **Turning it off deletes the database.** Not "stops reading it" — a
 *    switch labelled off that leaves the derived copy in place is the switch
 *    not working. See `docs/decisions/search.md`.
 *  - **Owner-only.** An editor may write every note in a context; that is not
 *    the same authority as deciding where a copy of them all is kept.
 *
 * ## Off is a working state, not a degraded one
 *
 * Either condition false means the existing R2 shard index serves the search,
 * exactly as it does today. That is what makes "off by default" shippable:
 * the fast path is an upgrade, and its absence is the product as it already
 * is, rather than a broken search waiting for a toggle.
 */

import type { Doc } from "../../_generated/dataModel";

/**
 * May this context turn the fast index on?
 *
 * True for everyone, deliberately and for now. **When this becomes a paid
 * feature, this function is the whole change** — it grows a plan lookup and
 * returns false for contexts without one. Callers already handle false,
 * because `optedIn` can be false today, so nothing downstream is written on
 * the assumption that entitlement is universal.
 *
 * Takes the workspace rather than an id so a plan lookup can be added without
 * changing a signature at every call site, and so this stays a pure function
 * that tests can drive directly.
 */
export function fastSearchEntitled(workspace: Doc<"workspaces">): boolean {
  // Referenced so the parameter is not merely decorative, and so the day this
  // grows a plan check there is already a workspace in scope to check.
  return workspace.kind === "personal" || workspace.kind === "shared";
}

/** The stored half: has an owner asked for it? Absent means no. */
export function fastSearchOptedIn(
  binding: Doc<"searchIndexes"> | null,
): boolean {
  return binding !== null && binding.optedIn === true;
}

/**
 * Both halves. The only function anything outside this module should ask.
 *
 * A caller that checks one half and not the other is the bug this exists to
 * prevent: checking only `optedIn` serves a context that is no longer
 * entitled, and checking only entitlement serves one that never asked.
 */
export function fastSearchActive(
  workspace: Doc<"workspaces">,
  binding: Doc<"searchIndexes"> | null,
): boolean {
  return fastSearchEntitled(workspace) && fastSearchOptedIn(binding);
}

/**
 * Why the fast index is not serving this context, for the settings screen.
 *
 * Four states rather than a boolean, because the copy differs and because a
 * person looking at a switch that is off deserves to know which kind of off
 * it is — "you have not turned this on" and "this is still building" are
 * different sentences, and "we cannot provision one right now" is a third that
 * is nobody's fault and should not read like a refusal.
 */
export type FastSearchState =
  /** Entitled, not asked for. The default for every context. */
  | "off"
  /** Asked for, and the database is being created or backfilled. */
  | "preparing"
  /** Asked for, provisioned, serving. */
  | "on"
  /** Asked for, and provisioning failed. Recoverable; the reason is stored. */
  | "failed"
  /** Not entitled. Today nothing reaches this; a paid tier is what does. */
  | "unavailable";

export function fastSearchState(
  workspace: Doc<"workspaces">,
  binding: Doc<"searchIndexes"> | null,
): FastSearchState {
  if (!fastSearchEntitled(workspace)) return "unavailable";
  if (!fastSearchOptedIn(binding)) return "off";
  // `optedIn` is true from here, so `binding` is non-null.
  switch (binding!.status) {
    case "ready":
      return "on";
    case "failed":
      return "failed";
    default:
      return "preparing";
  }
}

/**
 * How far the backfill has got, as a whole-number percentage — **or nothing**.
 *
 * ## Why it is derived and never stored
 *
 * A percentage is a ratio against a total, and the total is `indexed +
 * pending` as of the report that carried both. Storing the percentage would
 * store a ratio against the total that was true when it was written, and this
 * total moves in both directions: notes are written during a backfill, and
 * notes are deleted during one. A stored 42% survives a corpus that halved and
 * says something that was never true of the corpus it is displayed beside.
 * Derived from the two counters, the ratio cannot go stale relative to them —
 * because they are the only thing it is computed from, and they are written
 * together.
 *
 * ## The edge cases, each decided rather than fallen into
 *
 * Three of these are the console's rendering contract as much as this
 * function's arithmetic, and the console does not re-derive them: it range-
 * checks what arrives and otherwise draws exactly what is sent, treating an
 * absent field as "this viewer does not get this" and any number as a state to
 * render. So each of the three is a sentence somebody reads.
 *
 *  - **Either counter absent → `undefined`.** Nothing has reported a total, so
 *    there is no denominator. This is the important one: the row is created
 *    with `notesIndexed: 0` and no `notesPending` at all, so anything that
 *    treated an absent pending as zero would report **100%** to an owner whose
 *    backfill has not read a single note. An unknown reported as a number is
 *    the one direction that tells somebody their notes are written down when
 *    they are not — the same rule `docs/decisions/search.md` states for the
 *    manifest's `listedAt: null`.
 *  - **A total of zero → `undefined`.** Both counters present and both zero is
 *    a real report about a context with no notes in it, and "0 of 0" is not a
 *    percentage of anything: `0` renders as an accusing empty bar and `100`
 *    claims a backfill that never had work to do. Absent, the console says
 *    "no notes to index" in words, which is the true sentence.
 *  - **100 belongs to `ready`, and nothing else may claim it.** Whether a
 *    backfill is finished is the control plane's `status`, never an inference
 *    from `pending === 0` — a pass can reach zero pending with a listing still
 *    to redo, and `pending` is a floor whenever a walk was cut short. So a row
 *    that is not serving is capped at **99** however the arithmetic comes out,
 *    and the state carries "done". Without the cap, `48 of 48` on a
 *    `backfilling` row draws a completed bar beside a card that says the index
 *    is still being built.
 *  - **A total that shrank → a larger percentage, never one above 100.** The
 *    denominator is computed from the same report as the numerator, so notes
 *    deleted mid-backfill leave both smaller together and the ratio simply
 *    moves up. That, the clamp on each counter and `Math.floor` are why the
 *    result is always a finite integer in 0–100: the console range-checks and
 *    falls back to its own arithmetic on anything else, and a fallback that
 *    fires is a second implementation of this function running in production.
 *  - **A negative counter is clamped to zero**, not trusted and not refused:
 *    the counters arrive from the gateway and this function's job is to render
 *    a number, not to police the wire. `recordProjectionProgress` is where a
 *    malformed report is refused.
 *
 * **It inherits the counters' owner-only gate wherever it is served.** This
 * function is pure and knows nothing about roles; `fastSearch.status` is the
 * caller that must apply it, for the reason written there: a percentage is the
 * census, in one number instead of two, and a member who may read only the
 * `team` tier must not be handed a figure computed over private notes.
 */
export function backfillPercent(
  notesIndexed: number | undefined,
  notesPending: number | undefined,
  /** Is the index actually serving? Only a `ready` one may read 100. */
  finished: boolean,
): number | undefined {
  if (typeof notesIndexed !== "number" || typeof notesPending !== "number") {
    return undefined;
  }
  if (!Number.isFinite(notesIndexed) || !Number.isFinite(notesPending)) {
    return undefined;
  }
  const indexed = Math.max(0, notesIndexed);
  const pending = Math.max(0, notesPending);
  const total = indexed + pending;
  if (total === 0) return undefined;
  const percent = Math.floor((indexed * 100) / total);
  return finished ? percent : Math.min(99, percent);
}

/**
 * Whether the gateway may write a projection into this context's database, and
 * what it should be told the state is.
 *
 * `null` is every reason not to, and the caller cannot tell them apart —
 * unentitled, never opted in, opted out and releasing, still provisioning,
 * failed, or provisioned with no database id recorded yet. That is the same
 * "every negative is the same negative" the binding route already holds, and
 * it matters more here than usual: the answer decides whether a D1 write
 * credential leaves this deployment.
 *
 * The two states it does report are the two in which a database exists with a
 * schema on it. `provisioning` is excluded because the schema may not be
 * applied yet, and `failed` because a projection into a half-built database is
 * how a failure becomes data.
 */
export type SearchProjectionState = "backfilling" | "ready";

export function searchProjectionState(
  workspace: Doc<"workspaces">,
  binding: Doc<"searchIndexes"> | null,
): SearchProjectionState | null {
  if (!fastSearchActive(workspace, binding)) return null;
  // `fastSearchActive` is true, so `binding` is non-null and `optedIn`.
  if (typeof binding!.databaseId !== "string" || binding!.databaseId.length === 0) {
    return null;
  }
  switch (binding!.status) {
    case "backfilling":
      return "backfilling";
    case "ready":
      return "ready";
    default:
      return null;
  }
}


/**
 * Projection passes one trigger may chain behind itself.
 *
 * A backstop, not the thing that ends the chain. What ends it is a pass that
 * moved nothing, a row that stopped being `backfilling`, and a projection that
 * reached `ready` — each with a test. This bound exists for the case all three
 * miss: a bucket that changes faster than a pass can copy it must not schedule
 * itself forever on somebody else's request quota.
 *
 * Larger than the R2 index's twelve because a link copies at most a window's
 * worth of notes and a real brain is thousands of them, and because what the
 * bound cuts short is picked up by the sweep rather than lost.
 *
 * Here rather than in `functions/files.ts` so the two schedulers and the pass
 * share one number without `fastSearch.ts` having to import the module that
 * holds the credential barrier.
 */
export const PROJECTION_CHAIN = 24;

/**
 * How quiet a `backfilling` row must be before the sweep restarts its chain.
 *
 * Every link that moves anything writes counters onto the row, so `updatedAt`
 * is a heartbeat: a chain that is working looks recent, and a chain that died
 * — a deploy that lost the job, an eviction, a failure while recording one —
 * looks stale. Using the row rather than the scheduler's own table is what
 * lets this notice the case it was written for, which is a context that has
 * nothing scheduled *and never did*.
 *
 * Long enough that a slow link cannot be overtaken by a second chain: two
 * passes on one database is not a correctness failure, but it is the one thing
 * that leaves a note with duplicate chunk rows, so it is worth not causing on
 * purpose.
 */
export const BACKFILL_STALL_MS = 15 * 60 * 1_000;
