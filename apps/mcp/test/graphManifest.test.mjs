/**
 * Graph manifest lifecycle and graphHealth (`src/graph/manifest.js`).
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are failing tests in this
 * file.
 *
 *   complete ignores mode                                                    2
 *   possiblyIncomplete ignores mode (best-effort not labelled)               1
 *   conditional manifest create made unconditional                           3
 *   conditional publishHealth made unconditional                             2
 *   best-effort publishHealth re-read dropped                                1
 *   sweepComplete ignored in complete                                        2
 *   rebuild hint ignored in complete                                         1
 *   init treats an unreadable manifest as absent (best-effort)               1
 *   manifest mode trusted over the store's current mode                      1
 *   budget.take dropped before the publish write                             1
 *   records.js: newer formatVersion accepted by parseManifest                2 here, 1 in graphRecords
 *
 * Found while testing: best-effort init first treated a newer-format manifest
 * as absent and overwrote it; readGraphManifest now reports `absent` apart
 * from "unparseable".
 *
 * Process note: RED was shown by running the file before the module existed.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { graphManifestKey } from "../src/graph/keys.js";
import { graphHealth, initGraphManifest, loadGraphManifest, publishHealth, readGraphManifest } from "../src/graph/manifest.js";
import { createSearchBudget } from "../src/search/maintain.js";
import { memoryBucket } from "./store/fixtures.mjs";

const big = () => createSearchBudget(1000);
const NOW = Date.UTC(2026, 0, 1);
const CAPS = { conditionalWrite: true, conditionalCreate: true };
const withCaps = (bucket, capabilities) => Object.assign(bucket, { capabilities });
const cond = () => withCaps(memoryBucket(), CAPS);
const best = () => withCaps(memoryBucket({ ignoreIfMatch: true }), { conditionalWrite: false, conditionalCreate: false });
const init = (s, mode = "conditional") => initGraphManifest(s, big(), { mode, now: NOW });
const stored = (s) => JSON.parse(s.objects.get(graphManifestKey()).body);
const ready = (s, extra = {}) => s.put(graphManifestKey(), JSON.stringify({ ...stored(s), health: { state: "ready", sweepComplete: true, ...extra } }));

test("no manifest is unavailable", async () => {
  const h = await graphHealth(cond(), big());
  assert.deepEqual(h, { state: "unavailable", generation: null, building: null, mode: "conditional", possiblyIncomplete: true, complete: false });
});

test("an unparseable manifest is unavailable", async () => {
  const s = cond();
  await s.put(graphManifestKey(), "{nope");
  assert.equal((await graphHealth(s, big())).state, "unavailable");
});

test("init creates generation 1, partial and unswept", async () => {
  const s = cond();
  const m = await init(s);
  assert.equal(m.generation, "1");
  assert.deepEqual(stored(s).health, { state: "partial", sweepComplete: false });
  const h = await graphHealth(s, big());
  assert.equal(h.state, "partial");
  assert.equal(h.complete, false);
  assert.equal(h.possiblyIncomplete, true);
});

test("init twice concurrently leaves one manifest", async () => {
  const s = cond();
  const [a, b] = await Promise.all([init(s), init(s)]);
  assert.equal(a.generation, "1");
  assert.equal(b.generation, "1");
  assert.equal([...s.objects.keys()].filter((k) => k === graphManifestKey()).length, 1);
  assert.equal(s.objects.get(graphManifestKey()).etag, "m1");
});

test("init does not overwrite an existing manifest, in either mode", async () => {
  for (const s of [cond(), best()]) {
    await init(s, graphManifestKeyMode(s));
    await ready(s);
    const before = s.objects.get(graphManifestKey()).body;
    const m = await init(s, graphManifestKeyMode(s));
    assert.equal(m.health.state, "ready");
    assert.equal(s.objects.get(graphManifestKey()).body, before);
  }
});
const graphManifestKeyMode = (s) => (s.capabilities.conditionalWrite ? "conditional" : "best-effort");

test("init never replaces a newer-format manifest", async () => {
  for (const s of [cond(), best()]) {
    const newer = JSON.stringify({ formatVersion: 2, generation: "9", building: null, mode: "conditional", health: { state: "ready", sweepComplete: true } });
    await s.put(graphManifestKey(), newer);
    assert.equal(await init(s, graphManifestKeyMode(s)), null);
    assert.equal(s.objects.get(graphManifestKey()).body, newer);
  }
});

test("conditional ready sweep with no hint is complete", async () => {
  const s = cond();
  await init(s);
  await ready(s);
  assert.deepEqual(await graphHealth(s, big()), { state: "ready", generation: "1", building: null, mode: "conditional", possiblyIncomplete: false, complete: true });
});

test("ready but not swept, or with a rebuild hint, is not complete", async () => {
  const s = cond();
  await init(s);
  await ready(s, { sweepComplete: false });
  assert.equal((await graphHealth(s, big())).complete, false);
  await ready(s, { rebuildHint: "reconcile" });
  assert.equal((await graphHealth(s, big())).complete, false);
  assert.equal((await graphHealth(s, big())).possiblyIncomplete, false);
});

test("behind is possibly incomplete and not complete", async () => {
  const s = cond();
  await init(s);
  await s.put(graphManifestKey(), JSON.stringify({ ...stored(s), health: { state: "behind", sweepComplete: true } }));
  const h = await graphHealth(s, big());
  assert.equal(h.state, "behind");
  assert.equal(h.possiblyIncomplete, true);
  assert.equal(h.complete, false);
});

test("best-effort store is always possiblyIncomplete and never complete, even after a complete sweep", async () => {
  const s = best();
  const m = await init(s, "best-effort");
  assert.equal(m.mode, "best-effort");
  await ready(s);
  const h = await graphHealth(s, big());
  assert.equal(h.state, "ready");
  assert.equal(h.mode, "best-effort");
  assert.equal(h.possiblyIncomplete, true);
  assert.equal(h.complete, false);
});

test("a manifest written in conditional mode read by a best-effort store is labelled best-effort", async () => {
  const s = cond();
  await init(s);
  await ready(s);
  s.capabilities = { conditionalWrite: true, conditionalCreate: false };
  const h = await graphHealth(s, big());
  assert.equal(h.mode, "best-effort");
  assert.equal(h.complete, false);
});

test("a newer formatVersion is unavailable and publishHealth does not overwrite it", async () => {
  for (const s of [cond(), best()]) {
    const mode = graphManifestKeyMode(s);
    const m = await init(s, mode);
    const { etag } = await readGraphManifest(s, big());
    const newer = JSON.stringify({ formatVersion: 2, generation: "5", building: null, mode: "conditional", health: { state: "ready", sweepComplete: true } });
    await s.put(graphManifestKey(), newer);
    assert.equal(await loadGraphManifest(s, big()), null);
    assert.equal((await graphHealth(s, big())).state, "unavailable");
    // A stale parsed manifest and etag (conditional) or a re-read (best effort) must both refuse.
    await publishHealth(s, big(), m, mode === "conditional" ? etag : null, { health: { state: "ready" } });
    assert.equal(s.objects.get(graphManifestKey()).body, newer);
    // A null manifest (what a newer format loads as) is refused outright.
    assert.equal(await publishHealth(s, big(), null, "m1", { health: { state: "ready" } }), false);
    assert.equal(s.objects.get(graphManifestKey()).body, newer);
  }
});

test("publishHealth merges health and sets generation, conditionally", async () => {
  const s = cond();
  await init(s);
  const { manifest, etag } = await readGraphManifest(s, big());
  assert.equal(await publishHealth(s, big(), manifest, etag, { health: { state: "ready", sweepComplete: true }, generation: "2" }), true);
  const m = stored(s);
  assert.equal(m.generation, "2");
  assert.deepEqual(m.health, { state: "ready", sweepComplete: true });
  assert.equal(m.mode, "conditional");
});

test("publishHealth drops a refused write and leaves the manifest as the winner wrote it", async () => {
  const s = cond();
  await init(s);
  const { manifest, etag } = await readGraphManifest(s, big());
  await ready(s); // another writer moves the etag
  const after = s.objects.get(graphManifestKey()).body;
  assert.equal(await publishHealth(s, big(), manifest, etag, { health: { state: "behind" } }), false);
  assert.equal(s.objects.get(graphManifestKey()).body, after);
});

test("publishHealth refuses a patch that would not parse", async () => {
  const s = cond();
  await init(s);
  const { manifest, etag } = await readGraphManifest(s, big());
  assert.equal(await publishHealth(s, big(), manifest, etag, { health: { state: "bogus" } }), false);
  assert.equal(await publishHealth(s, big(), manifest, etag, { generation: "x" }), false);
  assert.equal(s.objects.get(graphManifestKey()).etag, "m1");
});

test("a spent budget stops every operation without touching the store", async () => {
  const s = cond();
  await init(s);
  const spent = () => createSearchBudget(0);
  assert.equal(await loadGraphManifest(s, spent()), null);
  assert.equal((await graphHealth(s, spent())).state, "unavailable");
  const { manifest, etag } = await readGraphManifest(s, big());
  assert.equal(await publishHealth(s, spent(), manifest, etag, { health: { state: "ready" } }), false);
  assert.equal(stored(s).health.state, "partial");
});

test("a hostile manifest with extra or wrong-typed fields cannot claim complete", async () => {
  const s = cond();
  await init(s);
  await s.put(graphManifestKey(), JSON.stringify({ ...stored(s), health: { state: "ready", sweepComplete: "yes" } }));
  assert.equal((await graphHealth(s, big())).complete, false);
  await s.put(graphManifestKey(), JSON.stringify({ ...stored(s), mode: "turbo" }));
  assert.equal((await graphHealth(s, big())).state, "unavailable");
});
