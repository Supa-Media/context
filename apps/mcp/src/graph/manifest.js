// Graph manifest lifecycle and `graphHealth` (arch 6.4, 9.1, 9.6). The manifest
// changes for health and generation only, never per edit. The bucket is a trust
// boundary: nothing here trusts a manifest beyond what `parseManifest` checks,
// and a manifest that does not parse (a newer format included) is never
// overwritten, so an older client cannot clear state it does not understand.
import { graphManifestKey } from "./keys.js";
import { graphMode } from "./mode.js";
import { PARSER_VERSION, RESOLVER_VERSION } from "./facts.js";
import { URL_KEY_VERSION } from "./urlKey.js";
import { GRAPH_FORMAT_VERSION, parseManifest, serializeManifest } from "./records.js";

/**
 * `{ manifest, etag, absent }`: manifest is null when absent, unparseable or
 * newer. `absent` is true only when the store answered and holds no object, so
 * an unreadable manifest is never mistaken for a missing one.
 */
export async function readGraphManifest(store, budget) {
  if (!budget.take()) return { manifest: null, etag: null, absent: false };
  const got = await store.get(graphManifestKey());
  if (!got) return { manifest: null, etag: null, absent: true };
  return { manifest: parseManifest(await got.text()), etag: got.etag ?? null, absent: false };
}

/** The versions the running code projects with; a manifest naming others is rebuilt (arch 9.6). */
export const codeVersions = () => ({ parserVersion: PARSER_VERSION, resolverVersion: RESOLVER_VERSION, urlKeyVersion: URL_KEY_VERSION });

export async function loadGraphManifest(store, budget) {
  return (await readGraphManifest(store, budget)).manifest;
}

/**
 * Create generation "1" if no manifest exists. Returns the manifest in the
 * bucket afterwards (ours, a concurrent initializer's, or null when what is
 * there does not parse or the budget ran out).
 */
export async function initGraphManifest(store, budget, { mode, now }) {
  const manifest = {
    formatVersion: GRAPH_FORMAT_VERSION,
    generation: "1",
    building: null,
    ...codeVersions(),
    mode,
    health: { state: "partial", sweepComplete: false },
    createdAt: new Date(now).toISOString(),
  };
  const body = serializeManifest(manifest);
  if (graphMode(store) === "conditional") {
    if (!budget.take()) return null;
    if (await store.put(graphManifestKey(), body, { onlyIf: { absent: true } })) return manifest;
  } else {
    // Best effort: a read-then-put race can lose a manifest; reconciliation
    // recomputes health, so that is accepted (P4).
    const { manifest: existing, absent } = await readGraphManifest(store, budget);
    if (!absent) return existing;
    if (!budget.take()) return null;
    if (await store.put(graphManifestKey(), body)) return manifest;
  }
  return loadGraphManifest(store, budget);
}

/**
 * Conditional update of health (shallow merge) and, when given, any other
 * top-level field (generation, building, the cutover fields of rebuild.js).
 * Returns true when written. A refused write is dropped: the next
 * pass recomputes. Refuses a manifest that did not parse, and in best-effort
 * mode re-reads first so an unconditional put never replaces a manifest this
 * client cannot parse.
 */
export async function publishHealth(store, budget, manifest, etag, patch) {
  if (!manifest || parseManifest(JSON.stringify(manifest)) === null) return false;
  const { health, ...fields } = patch;
  const given = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
  const next = { ...manifest, ...given, health: { ...manifest.health, ...health } };
  if (parseManifest(JSON.stringify(next)) === null) return false;
  let options;
  if (graphMode(store) === "conditional") {
    if (!etag) return false;
    options = { onlyIf: { etagMatches: etag } };
  } else if ((await readGraphManifest(store, budget)).manifest === null) {
    return false;
  }
  if (!budget.take()) return false;
  return Boolean(await store.put(graphManifestKey(), serializeManifest(next), options));
}

/**
 * Health for callers. No counts (arch 7.3). `complete` is the flag Phase 3
 * moves read to choose index over scan: only a conditional-mode, ready, fully
 * swept graph with no rebuild hint. A best-effort answer is never complete.
 */
export async function graphHealth(store, budget) {
  const manifest = await loadGraphManifest(store, budget);
  if (!manifest) {
    return { state: "unavailable", generation: null, building: null, mode: graphMode(store), possiblyIncomplete: true, complete: false };
  }
  // Either side best-effort means writes may have been unconditional.
  const mode = manifest.mode === "conditional" && graphMode(store) === "conditional" ? "conditional" : "best-effort";
  const { state, sweepComplete, rebuildHint } = manifest.health;
  return {
    state,
    generation: manifest.generation,
    // So Phase 3 can tell rebuilding from stale.
    building: manifest.building?.generation ?? null,
    mode,
    possiblyIncomplete: mode === "best-effort" || state !== "ready",
    complete: mode === "conditional" && state === "ready" && sweepComplete === true && !rebuildHint,
  };
}
