import { BUDGET_EXHAUSTED } from "../search/budget.js";

// P4 mode selection (OPEN-10). Conditional only when the store has *probed*
// both conditional update and conditional create (controlPlane.js documents the
// flags; storageLayout.js requires the same pair). A store with one of the two
// runs best effort and its answers are labelled possibly incomplete.

/** @returns {"conditional" | "best-effort"} */
export function graphMode(store) {
  const c = store?.capabilities;
  return c?.conditionalWrite === true && c?.conditionalCreate === true ? "conditional" : "best-effort";
}

/**
 * Ops of headroom one graph write needs beyond its own on a logical-delete
 * store (one exposing `setExtraOperationCharge`, as every gateway store does):
 * the wrapper reads before an unconditional or `absent` put, and before any
 * delete, and that read is charged to the same budget. A put conditional on an
 * etag skips the read for `.context/` keys (logicalDelete.js), and every graph
 * key is one. Callers pass this as `take`'s reserve so the charge always fits
 * inside the view they were given, never in a reserve kept for someone else.
 */
export function writeHeadroom(store, options, { remove = false } = {}) {
  if (typeof store?.setExtraOperationCharge !== "function") return 0;
  if (remove) return 1;
  const onlyIf = options?.onlyIf;
  return onlyIf?.etagMatches !== undefined && onlyIf?.absent !== true ? 0 : 1;
}

/**
 * The store graph work runs on, billed to `budget`. On a logical-delete store
 * (every gateway store) that is a private view of the same physical store
 * whose wrapper reads are charged to `budget` and nothing else: graph work
 * never installs a charge on the shared store, where it would bill the
 * request's other deferred work, and never inherits one left there (fix round
 * 3). Elsewhere it is `store` itself.
 */
export function graphView(store, budget) {
  if (typeof store?.forkLogicalView !== "function") return store;
  const view = store.forkLogicalView();
  view.actor = store.actor;
  view.setExtraOperationCharge(() => {
    if (budget.take(0)) return;
    const error = new Error("graph budget exhausted");
    error[BUDGET_EXHAUSTED] = true;
    throw error;
  });
  return view;
}
