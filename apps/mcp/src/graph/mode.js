// P4 mode selection (OPEN-10). Conditional only when the store has *probed*
// both conditional update and conditional create (controlPlane.js documents the
// flags; storageLayout.js requires the same pair). A store with one of the two
// runs best effort and its answers are labelled possibly incomplete.

/** @returns {"conditional" | "best-effort"} */
export function graphMode(store) {
  const c = store?.capabilities;
  return c?.conditionalWrite === true && c?.conditionalCreate === true ? "conditional" : "best-effort";
}
