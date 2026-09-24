/**
 * Wire shapes shared by the `fastSearch.ts` Convex functions.
 *
 * Split out of `functions/fastSearch.ts` — see that file's header for the
 * gate this surfaces and the owner-only rules around it.
 */

import { v } from "convex/values";
import type { Id } from "../../../_generated/dataModel";
import type { FastSearchState } from "../fastSearch";

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
export const stateValidator = v.union(
  v.literal("off"),
  v.literal("preparing"),
  v.literal("on"),
  v.literal("failed"),
  v.literal("unavailable"),
);

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
 * A context the blended search will ask, and how it will be answered.
 *
 * **Every context the caller is a member of is in this list.** It used to hold
 * only the ones serving from a hosted index, with the rest in a second list
 * the page could do nothing with but apologise — which made the search page a
 * dead end for the ordinary account, the one paying for nothing and owning a
 * workspace in its own bucket. `lib/fastSearch.ts` has always said what the right
 * answer is: "either condition false means the existing R2 shard index serves
 * the search, exactly as it does today… the fast path is an upgrade, and its
 * absence is the product as it already is." The blended page is the one
 * surface that did not believe it.
 *
 * So `search` says which way this one will be answered, and nothing is left
 * out on account of it:
 *
 *  - `"fast"` — a projection the control plane calls `ready` answers from a
 *    database, in a round trip.
 *  - `"slow"` — the R2 shard index in the customer's own bucket answers, in
 *    several. Bounded by `SOURCE_DEADLINE_MS` in `files.searchContexts` like
 *    every other source, so a slow context costs its own row and never the
 *    page.
 *
 * `fastSearch` carries *why* a slow one is slow, in the settings card's own
 * vocabulary (`FastSearchState`), and `owner` says whether this viewer is the
 * person who could change it. Together they are what the page's upsell is
 * built from: "not paying" and "have not asked" are different sentences with
 * different presses behind them, and that distinction is the reason
 * `lib/fastSearch.ts` keeps entitlement and opt-in apart in the first place.
 */
export interface SearchableContext {
  workspaceId: Id<"workspaces">;
  slug: string;
  displayName: string;
  kind: string;
  role: string;
  /** Which index answers this context — see above. */
  search: "fast" | "slow";
  /** Why it is not fast, in the settings card's words. `"on"` when it is. */
  fastSearch: FastSearchState;
  /** Whether this viewer may change that — an owner, and only an owner. */
  owner: boolean;
}

export const searchableContextValidator = v.object({
  workspaceId: v.id("workspaces"),
  slug: v.string(),
  displayName: v.string(),
  kind: v.string(),
  role: v.string(),
  search: v.union(v.literal("fast"), v.literal("slow")),
  fastSearch: v.union(
    v.literal("off"),
    v.literal("preparing"),
    v.literal("on"),
    v.literal("failed"),
    v.literal("unavailable"),
  ),
  owner: v.boolean(),
});
