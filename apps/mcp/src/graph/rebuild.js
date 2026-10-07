// Rebuild generations (arch 9.6; controller rulings OPEN-16 and OPEN-22).
//
// A manifest naming an older parser, resolver or URL-key version than the
// running code is rebuilt into generation `active + 1`, recorded in
// `building`. Newer versions are left alone (arch 9.6: an older client must
// not clear state it does not understand), so during a rolling deploy older
// code neither rebuilds nor writes into a generation labelled newer, and
// only code whose versions equal a `building` generation's builds into it or
// cuts it over. Older code still reconciles the active generation during a
// newer build but publishes it "behind" (reconcile.js). A build started by
// older code is restarted at the next generation, the abandoned one named in
// `collect` when that is free. Reconciliation sweeps the census into that
// generation while
// writes and readers stay pinned to the active one. Cutover (OPEN-16) is one
// conditional manifest write after two consecutive clean wraps of the
// building generation on a complete census: the second wrap is the re-check,
// re-reading every source whose census version differs from the building
// generation's observedSourceVersion. It also waits for one full audit
// listing begun since the first clean wrap, so a note deleted during the
// build with no removal hint is gone before the swap. Cutover clears
// `rebuildHint`: the fresh generation owes nothing the old one flagged. A write pinned to the old generation
// after that is caught by the new generation's next census diff.
//
// Retention (OPEN-22): the previous generation is kept until the next
// cutover, then named in `collect` and deleted in bounded listing pages, only
// on a store with conditionalDelete and only under that generation's own
// prefix, never the serving, building or retained one. Deletes are
// unconditional: nothing reads or writes a collected generation, and a late
// writer pinned two generations back only leaves garbage. A cutover that
// lands while an earlier `collect` is unfinished replaces it and leaks that
// generation (accepted: a build takes far more passes than a GC). A GC page
// ends on its first failed delete and never throws; after
// GC_FAILURE_LIMIT consecutive failed passes the generation is left in
// place, `collect` is cleared and the abandonment is logged.
//
// A newer manifest format never parses (records.js), so it is never rebuilt,
// cut over or collected. No older format exists at formatVersion 1.
import { generationPrefix } from "./keys.js";
import { codeVersions, publishHealth, readGraphManifest } from "./manifest.js";

const isGen = (v) => typeof v === "string" && /^[0-9]+$/.test(v);
const GC_LIST_LIMIT = 100;
export const GC_FAILURE_LIMIT = 3;

/** Per-field `stored - running`; a missing or malformed field counts as older. */
const versionDiffs = (record) =>
  Object.entries(codeVersions()).map(([k, v]) => (Number.isInteger(record[k]) ? record[k] : 0) - v);

/** Some version older than the running code's and none newer. */
export const needsRebuild = (record) => versionDiffs(record).some((d) => d < 0) && !isNewer(record);
/** Some version newer than the running code's: written by newer code. */
export const isNewer = (record) => versionDiffs(record).some((d) => d > 0);
export const matchesCode = (record) => versionDiffs(record).every((d) => d === 0);

/**
 * Record `building` one past the active generation (or past an older code's
 * build, which it replaces) with the versions it is built for. The active
 * generation is no longer reconciled until cutover, so its health says
 * "behind" (never `complete`). Returns true when written.
 */
export function startRebuild(store, budget, manifest, etag, now) {
  const stale = manifest.building;
  // BigInt: any digit string parses, and Number would round past 2^53.
  const from = stale && BigInt(stale.generation) > BigInt(manifest.generation) ? stale.generation : manifest.generation;
  const generation = (BigInt(from) + 1n).toString();
  return publishHealth(store, budget, manifest, etag, {
    building: { generation, startedAt: new Date(now).toISOString(), ...codeVersions() },
    ...(stale && (manifest.collect === undefined || manifest.collect === null) && { collect: stale.generation }),
    health: { state: "behind" },
  });
}

/** Swap to the building generation in one conditional write. True when written. */
export function cutover(store, budget, { manifest, etag }, health) {
  const { generation, parserVersion, resolverVersion, urlKeyVersion } = manifest.building;
  return publishHealth(store, budget, manifest, etag, {
    generation,
    building: null,
    previous: manifest.generation,
    collect: manifest.previous ?? null,
    parserVersion,
    resolverVersion,
    urlKeyVersion,
    health: { ...health, rebuildHint: null },
  });
}

/**
 * One bounded GC page of `manifest.collect` on whatever `budget` has left
 * (reconcile.js decides how much that is). Clears `collect` once its prefix
 * lists empty.
 * Returns "failed" (a list or delete failed; the page ended there), "done"
 * (progress or cleared) or undefined (nothing to do, or no budget). Never
 * throws for a store failure.
 */
export async function collectGarbage(store, budget, manifest) {
  const gen = manifest.collect;
  if (gen === undefined || gen === null || store.capabilities?.conditionalDelete !== true) return;
  if (!isGen(gen) || gen === manifest.generation || gen === manifest.building?.generation || gen === manifest.previous) return;
  const prefix = generationPrefix(gen);
  const limit = Math.min(GC_LIST_LIMIT, budget.remaining - 1);
  if (limit < 1 || !budget.take()) return;
  let listed;
  try {
    listed = await store.list({ prefix, limit });
  } catch {
    return "failed";
  }
  const keys = (listed.objects || []).map((o) => o?.key).filter((k) => typeof k === "string" && k.startsWith(prefix));
  if (keys.length === 0 && !listed.truncated) {
    const fresh = await readGraphManifest(store, budget);
    if (fresh.manifest?.collect === gen) await publishHealth(store, budget, fresh.manifest, fresh.etag, { collect: null });
    return "done";
  }
  for (const key of keys.slice(0, limit)) {
    if (!budget.take()) return "done";
    try {
      await store.delete(key);
    } catch {
      return "failed";
    }
  }
  return "done";
}

/** Stop collecting `gen`: leave its objects, clear `collect`, log identifiers only. */
export async function abandonCollect(store, budget, gen) {
  const fresh = await readGraphManifest(store, budget);
  if (fresh.manifest?.collect !== gen) return;
  await publishHealth(store, budget, fresh.manifest, fresh.etag, { collect: null });
  try {
    console.error(JSON.stringify({ event: "graph-gc-abandoned", workspace: store.actor?.workspaceId, generation: gen }));
  } catch {
    // Reporting cannot fail the pass.
  }
}
