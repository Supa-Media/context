// Rebuild generations (arch 9.6; controller rulings OPEN-16 and OPEN-22).
//
// A manifest naming another parser, resolver or URL-key version than the
// running code is rebuilt into generation `active + 1`, recorded in
// `building`. Reconciliation sweeps the census into that generation while
// writes and readers stay pinned to the active one. Cutover (OPEN-16) is one
// conditional manifest write after two consecutive clean wraps of the
// building generation on a complete census: the second wrap is the re-check,
// re-reading every source whose census version differs from the building
// generation's observedSourceVersion. A write pinned to the old generation
// after that is caught by the new generation's next census diff.
//
// Retention (OPEN-22): the previous generation is kept until the next
// cutover, then named in `collect` and deleted in bounded listing pages, only
// on a store with conditionalDelete and only under that generation's own
// prefix, never the serving, building or retained one. Deletes are
// unconditional: nothing reads or writes a collected generation, and a late
// writer pinned two generations back only leaves garbage. A cutover that
// lands while an earlier `collect` is unfinished replaces it and leaks that
// generation (accepted: a build takes far more passes than a GC).
//
// A newer manifest format never parses (records.js), so it is never rebuilt,
// cut over or collected. No older format exists at formatVersion 1.
import { generationPrefix } from "./keys.js";
import { codeVersions, publishHealth, readGraphManifest } from "./manifest.js";

const isGen = (v) => typeof v === "string" && /^[0-9]+$/.test(v);
const GC_LIST_LIMIT = 100;

export function needsRebuild(manifest) {
  return Object.entries(codeVersions()).some(([k, v]) => manifest[k] !== v);
}

/**
 * Record `building: active + 1` with the versions it is built for. The active
 * generation is no longer reconciled until cutover, so its health says
 * "behind" (never `complete`). Returns true when written.
 */
export function startRebuild(store, budget, manifest, etag, now) {
  // BigInt: any digit string parses, and Number would round past 2^53.
  const generation = (BigInt(manifest.generation) + 1n).toString();
  return publishHealth(store, budget, manifest, etag, {
    building: { generation, startedAt: new Date(now).toISOString(), ...codeVersions() },
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
    health,
  });
}

/**
 * One bounded GC page of `manifest.collect`, on at most half of `budget` so
 * the sweep keeps the rest. Clears `collect` once its prefix lists empty.
 */
export async function collectGarbage(store, budget, manifest) {
  const gen = manifest.collect;
  if (gen === undefined || gen === null || store.capabilities?.conditionalDelete !== true) return;
  if (!isGen(gen) || gen === manifest.generation || gen === manifest.building?.generation || gen === manifest.previous) return;
  const prefix = generationPrefix(gen);
  const limit = Math.min(GC_LIST_LIMIT, Math.floor((budget.remaining - 1) / 2));
  if (limit < 1 || !budget.take()) return;
  let listed;
  try {
    listed = await store.list({ prefix, limit });
  } catch {
    return;
  }
  const keys = (listed.objects || []).map((o) => o?.key).filter((k) => typeof k === "string" && k.startsWith(prefix));
  if (keys.length === 0 && !listed.truncated) {
    const fresh = await readGraphManifest(store, budget);
    if (fresh.manifest?.collect === gen) await publishHealth(store, budget, fresh.manifest, fresh.etag, { collect: null });
    return;
  }
  for (const key of keys.slice(0, limit)) {
    if (!budget.take()) return;
    await store.delete(key);
  }
}
