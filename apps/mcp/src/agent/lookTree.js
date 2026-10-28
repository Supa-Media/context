/**
 * What a check-in lists to tell what changed: the workspace's tree, asked of
 * the control plane (`../tree/served.js`).
 *
 * A look asks first for only the notes written since its last one
 * (`changedSince`, read from the tree's change index), which costs what
 * changed, not the size of the workspace. Only when the control plane will
 * not answer that (too much changed, moves being drawn) does it walk the
 * whole tree, and then, since nobody is waiting on a check-in, it waits far
 * longer than an interactive tool's 6 seconds and asks twice. On 2026-10-28 a
 * large workspace's whole tree, built from parents since 2026-10-25, took
 * longer than 6 seconds at most check-ins, and every one of them read nothing.
 */
import { objectOf, servedListingStore } from "../tree/served.js";

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

/**
 * The notes written since `since`, from the tree's change index when it
 * answers, else from the whole tree (`lookTreeEntries`). Either way only
 * listed objects come back; which notes changed is still the caller's to say.
 *
 * @returns {Promise<{entries: object[], tries: number, changedOnly?: true} | {code: string, tries: number}>}
 */
export async function lookChangedEntries(store, since, options = {}) {
  const timeoutMs = options.timeoutMs ?? LOOK_TREE_TIMEOUT_MS;
  if (typeof store?.treeManifest === "function" && Number.isFinite(since)) {
    try {
      const answer = await store.treeManifest({ changedSince: since }, { timeoutMs });
      if (answer?.served === true && Array.isArray(answer.entries) && answer.cursor === null) {
        const entries = answer.entries.filter((entry) => typeof entry?.path === "string" && entry.path !== "");
        return { entries: entries.map(objectOf), tries: 1, changedOnly: true };
      }
    } catch {
      // The index could not be asked: the whole tree may still answer.
    }
  }
  return await lookTreeEntries(store, options);
}
