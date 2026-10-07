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
import { BUDGET_EXHAUSTED } from "../search/budget.js";
import { codeVersions, publishHealth, readGraphManifest } from "./manifest.js";

// Version comparisons live beside codeVersions (graphHealth needs isNewer).
export { isNewer, matchesCode, needsRebuild } from "./manifest.js";

const isGen = (v) => typeof v === "string" && /^[0-9]+$/.test(v);
const GC_LIST_LIMIT = 100;
export const GC_FAILURE_LIMIT = 3;

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
 * `gcCursor` is "" or JSON `[collectGeneration, listToken | null, found]`:
 * where the listing of the collected prefix resumes, and whether this
 * traversal (begun at the top) has listed any object. A cursor naming another
 * generation, or garbage, starts over.
 */
function parseGcCursor(text, gen) {
  try {
    const [g, token, found] = JSON.parse(text);
    if (g === gen && (token === null || (typeof token === "string" && token)) && typeof found === "boolean") return { token, found };
  } catch {
    // "" or garbage.
  }
  return { token: null, found: false };
}

/**
 * One bounded GC page of `manifest.collect` on whatever `budget` has left
 * (reconcile.js decides how much that is), resuming from `cursor.gcCursor`.
 *
 * The listing follows its cursor because a logical-delete store (every
 * gateway store) turns each delete into a hidden marker that keeps its place
 * in the provider's listing: re-listing from the top would re-read the same
 * page of markers forever. The token advances only once every key on the
 * page is deleted. `collect` is cleared only after a whole traversal from the
 * top lists nothing, so a provider whose cursor shifts under deletes still
 * empties the prefix. Bound: two traversals of ceil(objects / page) pages.
 * Deletes keep one op of headroom for the wrapper's marker write.
 *
 * Returns "failed" (a list or delete failed; the page ended there), "done"
 * (progress or cleared) or undefined (nothing to do, or no budget). Never
 * throws for a store failure.
 */
export async function collectGarbage(store, budget, manifest, cursor = {}) {
  const gen = manifest.collect;
  if (gen === undefined || gen === null || store.capabilities?.conditionalDelete !== true) return;
  if (!isGen(gen) || gen === manifest.generation || gen === manifest.building?.generation || gen === manifest.previous) return;
  const prefix = generationPrefix(gen);
  const at = parseGcCursor(cursor.gcCursor ?? "", gen);
  const save = (token, found) => {
    cursor.gcCursor = JSON.stringify([gen, token, found]);
  };
  // The list, then one delete per key, each leaving one op of headroom.
  const limit = Math.min(GC_LIST_LIMIT, budget.remaining - 2);
  if (limit < 1 || !budget.take()) return;
  let listed;
  try {
    listed = await store.list({ prefix, limit, ...(at.token && { cursor: at.token }) });
  } catch (error) {
    if (error?.[BUDGET_EXHAUSTED]) return;
    save(null, at.found); // an expired or refused token: start the listing over
    return "failed";
  }
  const keys = (listed.objects || []).map((o) => o?.key).filter((k) => typeof k === "string" && k.startsWith(prefix));
  const found = at.found || keys.length > 0;
  for (const key of keys) {
    if (!budget.take(1)) {
      save(at.token, true);
      return "done";
    }
    try {
      await store.delete(key);
    } catch (error) {
      save(at.token, true);
      return error?.[BUDGET_EXHAUSTED] ? "done" : "failed";
    }
  }
  const next = listed.truncated && typeof listed.cursor === "string" && listed.cursor ? listed.cursor : null;
  // A truncated page with no usable cursor restarts the listing; it never clears.
  if (listed.truncated) {
    save(next, found);
    return "done";
  }
  // End of the listing. Objects were found this traversal: confirm from the top.
  save(null, false);
  if (found) return "done";
  const fresh = await readGraphManifest(store, budget);
  if (fresh.manifest?.collect === gen) await publishHealth(store, budget, fresh.manifest, fresh.etag, { collect: null });
  cursor.gcCursor = "";
  return "done";
}

/** Stop collecting `gen`: leave its objects, clear `collect`, log identifiers only. */
export async function abandonCollect(store, budget, gen) {
  const fresh = await readGraphManifest(store, budget);
  if (fresh.manifest?.collect !== gen) return;
  // Logged only once the publish lands; a refused one is retried later.
  if (!(await publishHealth(store, budget, fresh.manifest, fresh.etag, { collect: null }))) return;
  try {
    console.error(JSON.stringify({ event: "graph-gc-abandoned", workspace: store.actor?.workspaceId, generation: gen }));
  } catch {
    // Reporting cannot fail the pass.
  }
}
