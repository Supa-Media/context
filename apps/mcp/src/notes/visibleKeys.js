/** The notes a caller can see: every note key, filtered through `canSee`. */

import { noteUnderPrefix } from "../moves/jobs.js";
import { canSee, isPlumbing } from "../privacy/engine.js";
import { listAllKeys, listImmediateLayout, mapInBatches } from "./storage.js";

/** List note objects without traversing dot-prefixed history/audit/ACL plumbing. */
export async function listAllNoteKeys(store) {
  // A recursive delimiter walk made one or more list requests for every
  // contact/conversation directory. Large communication trees have thousands
  // of those directories, so a reference rewrite timed out before its first
  // note. Partition at the workspace root, then page each root in parallel:
  // the number of requests follows object pages rather than folder count.
  const layout = await listImmediateLayout(store);
  const branches = await mapInBatches(layout.prefixes, 8, (prefix) => listAllKeys(store, prefix));
  return [...layout.objects, ...branches.flat()].filter(
    ({ key }) => key.endsWith(".md") && !isPlumbing(key)
  );
}

/**
 * The notes under `prefix` (every note, without one) a caller can see. On the
 * listing tools `store` lists the Convex tree (`tree/served.js`), which
 * already draws a queued folder move at its new names; nothing here reads the
 * old-style move jobs under `.context/moves/` any more (2026-10-13).
 */
export async function listVisibleNoteKeys(store, scope, rules, overrides, prefix) {
  const keys = prefix ? await listAllKeys(store, prefix) : await listAllNoteKeys(store);
  return keys.filter(
    ({ key }) =>
      (!prefix || noteUnderPrefix(key, prefix)) &&
      key.endsWith(".md") &&
      !isPlumbing(key) &&
      canSee(key, scope, rules, overrides)
  );
}
