/**
 * The per-invocation store-operation budget a search spends, and the store
 * wrapper that enforces it. Moved verbatim out of `src/index.js`.
 */

import { getWithLegacyFallback } from "../storageLayout.js";
import { SEARCH_SUBREQUEST_BUDGET } from "./visible.js";

/*
 * `SEARCH_SUBREQUEST_BUDGET` (everything one search may spend on storage: the
 * index sync, its conditional write, and the fresh read behind every snippet)
 * and `SEARCH_RESULT_LIMIT` are imported from `search/visible.js`, which is
 * where the search they bound now lives. They replaced `SEARCH_FILE_CAP = 400`,
 * which was not a budget at all: 400 reads is eight times the free tier's
 * per-invocation limit, so a real context — measured live at 154 notes —
 * answered every unprefixed search with "Too many subrequests".
 */
/**
 * Bounds for the `SEARCH_SUBREQUEST_BUDGET` deployment override.
 *
 * The default above assumes the free tier's 50. A paid-plan deployment gets
 * 1000 per invocation, and holding it to 40 there makes a real workspace's first
 * index dozens of searches long: measured live, a bucket in the low thousands
 * of notes backfills ~26 per pass, so a person's search for a name their notes
 * definitely contain answers "(no matches)" for days of ordinary use. The floor
 * keeps a typo'd var from configuring a budget too small to ever sync (listing
 * + write + one fetch + the snippet reserve); the cap leaves the rest of the
 * invocation's own spend (session, binding, privacy.md) under the paid limit.
 * Anything unparseable is the default, never a throw — a bad var must not take
 * down search.
 */
const SEARCH_BUDGET_MIN = 15;
const SEARCH_BUDGET_MAX = 900;

/** The per-deployment search budget: `env.SEARCH_SUBREQUEST_BUDGET` or the default. */
export function searchBudgetFor(env) {
  const raw = env?.SEARCH_SUBREQUEST_BUDGET;
  const parsed = typeof raw === "string" || typeof raw === "number" ? Number(raw) : NaN;
  if (!Number.isFinite(parsed)) return SEARCH_SUBREQUEST_BUDGET;
  return Math.min(SEARCH_BUDGET_MAX, Math.max(SEARCH_BUDGET_MIN, Math.floor(parsed)));
}

/**
 * Budget exhaustion inside the fallback, as a thrown sentinel the scan's own
 * callers catch and report as truncation — never as a dead request.
 */
export const BUDGET_EXHAUSTED = Symbol("search budget exhausted");

/**
 * The fallback's storage calls go through the same counter the indexed path
 * used. Its listing helpers (`listImmediateLayout`, `listBoundedKeys`) predate
 * the budget and page freely, and un-counted listings are how the recovery
 * route re-creates the very "Too many subrequests" failure it exists to
 * survive: a bucket with enough top-level folders spends two pages on each of
 * them before the first note is read.
 */
export function budgetedStore(store, budget, reserve = 0) {
  const spend = () => {
    if (budget.take(reserve)) return;
    const error = new Error("search budget exhausted");
    error[BUDGET_EXHAUSTED] = true;
    throw error;
  };
  return {
    get(key) {
      spend();
      return getWithLegacyFallback(store, key, {
        beforeFallback: () => {
          spend();
          return true;
        },
      });
    },
    list(options) {
      spend();
      return store.list(options);
    },
  };
}
