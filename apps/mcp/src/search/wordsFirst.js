/**
 * The word search goes to a workspace's object before the meaning index is read into memory there.
 *
 * A workspace object answers one call at a time, and reading its meaning index into memory (`objectMeaningWarm`,
 * `workspaceStore/meaningIndex.js` `warm`) holds it for as long as the read takes: in a large workspace, longer than
 * the word search itself. Sent side by side, the word search could queue behind it and come back only when meaning
 * did, so nothing that waits on the word hits alone (the reranker on word hits) could start early. The warm-up is
 * only a head start for the meaning query, which reads the index itself when it was not warmed, so holding it until
 * the word search has answered changes no answer and costs meaning at most the word search's own time, which the
 * query's embedding call covers.
 */

const ASKED = new WeakMap();

/** Note that `store`'s word search is in flight as `asked`; returns `asked`. */
export function wordSearchAsked(store, asked) {
  // Kept as "it has settled", never as its failure, which stays the word search's own to report.
  if (store && typeof store === "object" && typeof asked?.then === "function") ASKED.set(store, asked.then(() => {}, () => {}));
  return asked;
}

/**
 * Settles once `store`'s word search in flight (if any) has answered or failed; soon when none is. Never rejects.
 * It looks one task later, so a word search started in the same tick as this call (the graph starts `words` and
 * `meaning` together) is found whichever of the two reached here first.
 */
export function afterWordSearch(store) {
  return new Promise((resolve) => setTimeout(resolve, 0)).then(() => (store && typeof store === "object" ? ASKED.get(store) : undefined));
}
