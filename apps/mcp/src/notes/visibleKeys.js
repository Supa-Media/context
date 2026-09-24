/**
 * The notes a caller can see, with in-flight logical moves applied: listing
 * every note key, filtering it through `canSee`, and reading a note that may
 * still sit at its pre-move key.
 */

import {
  applyMoveOverlay,
  loadMoveJobs,
  movedSourceFor,
  noteUnderPrefix,
} from "../moves/jobs.js";
import { canSee, isPlumbing } from "../privacy/engine.js";
import { getWithLegacyFallback } from "../storageLayout.js";
import { listAllKeys, listImmediateLayout } from "./storage.js";

/** List note objects without traversing dot-prefixed history/audit/ACL plumbing. */
export async function listAllNoteKeys(store) {
  const root = await listImmediateLayout(store);
  const nested = await Promise.all(root.prefixes.map((prefix) => listAllKeys(store, prefix)));
  return [...root.objects, ...nested.flat()].filter(
    ({ key }) => key.endsWith(".md") && !isPlumbing(key)
  );
}

export async function listVisibleNoteKeysWithMoves(store, scope, rules, overrides, prefix) {
  const jobs = await loadMoveJobs(store);
  const raw = prefix ? await listAllKeys(store, prefix) : await listAllNoteKeys(store);
  let keys = raw;
  if (prefix && jobs.some((job) => noteUnderPrefix(job.destination, prefix) || noteUnderPrefix(prefix, job.destination))) {
    const movedSources = await Promise.all(
      jobs
        .filter((job) => noteUnderPrefix(job.destination, prefix) || noteUnderPrefix(prefix, job.destination))
        .map((job) => listAllKeys(store, `${job.source}/`).catch(() => []))
    );
    keys = [...keys, ...movedSources.flat()];
  }
  return applyMoveOverlay(keys, jobs).filter(
    ({ key, logicalSource }) =>
      (!prefix || noteUnderPrefix(key, prefix)) &&
      key.endsWith(".md") &&
      !isPlumbing(key) &&
      canSee(key, scope, rules, overrides) &&
      (!logicalSource || canSee(logicalSource, scope, rules, overrides))
  );
}

/**
 * @param fetchOne how deep to look: the default fetches the object, and
 *   `probeWithLegacyFallback` answers the same question out of metadata. One
 *   function either way, because the ORDER these keys are tried in is the part
 *   that must not exist twice — see the rows about second implementations.
 */
export async function getVisibleMovedNote(store, scope, rules, overrides, path, fetchOne = getWithLegacyFallback) {
  const jobs = await loadMoveJobs(store);
  if (jobs.some((job) => path.startsWith(`${job.source}/`))) {
    return { object: null, physicalPath: path };
  }
  for (let index = jobs.length - 1; index >= 0; index -= 1) {
    const job = jobs[index];
    const source = movedSourceFor(job, path);
    if (!source) continue;
    if (!canSee(source, scope, rules, overrides)) return { object: null, physicalPath: path };
    const destinationObject = await fetchOne(store, path);
    if (destinationObject) return { object: destinationObject, physicalPath: path, logicalMove: true };
    const sourceObject = await fetchOne(store, source);
    if (sourceObject) return { object: sourceObject, physicalPath: source, logicalMove: true };
  }
  return { object: await fetchOne(store, path), physicalPath: path };
}
