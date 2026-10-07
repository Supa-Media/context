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
