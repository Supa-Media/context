/** Move limits and the plumbing keys move jobs live under. Moved verbatim out of `src/index.js`. */

const FOLDER_MOVE_CAP = 500;
export const LOGICAL_FOLDER_MOVE_THRESHOLD = FOLDER_MOVE_CAP;
export const MOVE_JOB_PREFIX = ".context/moves/";
export const MOVE_SENTINEL_KEY = ".context/moves/active";
/**
 * Where a cross-workspace move leaves the owner's own copy.
 *
 * Plumbing, so it is out of every listing, search and privacy decision — a
 * segment beginning with "." is what `isPlumbing` tests, and `.context/` is
 * already where this product keeps its own objects.
 *
 * Only the **cross-workspace** move writes here, and the reason is the one
 * thing that move cannot promise: its destination is a different bucket. A
 * same-workspace move needs no copy, because the destination IS the copy — a
 * third one of the same bytes in the same bucket would be storage the customer
 * pays for to hold what they already have.
 */
export const TRASH_PREFIX = ".context/trash/";
export const MOVE_JOB_VERSION = 1;
export const MOVE_MATERIALIZE_BATCH = 100;
export const BATCH_MOVE_CAP = 100;
