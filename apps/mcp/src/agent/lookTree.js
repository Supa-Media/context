/**
 * What a check-in lists to tell what changed: the workspace's tree, asked of
 * the control plane (`../tree/served.js`).
 *
 * Nobody is waiting on a check-in, so it gives the tree far longer than an
 * interactive tool's 6 seconds and asks twice. On 2026-10-28 a large
 * workspace's tree, built from parents since 2026-10-25, took longer than 6
 * seconds at most check-ins, and every one of them read nothing.
 */
import { servedListingStore } from "../tree/served.js";

/** How long one page of the tree may take for a check-in. */
export const LOOK_TREE_TIMEOUT_MS = 25_000;
/** Listings a look tries before it gives up until its retry. */
export const LOOK_TREE_TRIES = 2;

/**
 * Every key the tree holds for this grant, as listed objects, or why not as a
 * log code (`not_served`, `timed_out`, `failed`, `malformed`, `endless`).
 *
 * @returns {Promise<{entries: object[], tries: number} | {code: string, tries: number}>}
 */
export async function lookTreeEntries(store, { tries = LOOK_TREE_TRIES, timeoutMs = LOOK_TREE_TIMEOUT_MS } = {}) {
  let code = "failed";
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      // A fresh listing each time: one remembers its first refusal for the rest of a call.
      return { entries: await servedListingStore(store, { timeoutMs }).treeEntries(), tries: attempt };
    } catch (error) {
      code = typeof error?.code === "string" ? error.code : "failed";
    }
  }
  return { code, tries };
}
