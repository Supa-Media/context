/**
 * Where approvals live in the bucket. Apart from `approvals.js` so code that
 * only reads asks (Settings › Vault, through the control plane) does not load
 * everything that settles and replays them.
 */

export const APPROVALS_PREFIX = ".context/approvals/";
export const PENDING_PREFIX = `${APPROVALS_PREFIX}pending/`;
export const DONE_PREFIX = `${APPROVALS_PREFIX}done/`;
