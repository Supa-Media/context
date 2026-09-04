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
