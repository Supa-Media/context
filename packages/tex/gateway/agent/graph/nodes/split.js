/**
 * The Split job node, `split` (the rules are `packages/shared/src/jobSplit.cjs`). A big ask `plan_big_ask` splits
 * runs as one job with several parts at once, each on its named worker and all on the overview's mail: the chat's
 * list shows it as one job, and a restart of any part, or of the split's title, picks back up every unfinished part.
 * A part that ends waiting sleeps until mail wakes it, which is Part end's "sleep" (`jobPartEnd.cjs`).
 *
 * No model and no reads: pure code over the chat's jobs, logged like every node. The front door's restart and list
 * use the same rule in place (`background.js`), as the Worker uses Part end's.
 */
import { decideSplit } from "../../../../../shared/src/jobSplit.cjs";

/** @param {{ entries?: unknown[], picked?: unknown[], resumable?: string[], names?: string[] }} input */
export async function splitNode(input) {
  return decideSplit(input);
}
