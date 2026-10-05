/**
 * Graph prefix, keys and record codecs (`src/graph/keys.js`, `records.js`).
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are failing tests in this
 * file.
 *
 *   parseManifest accepts formatVersion 2                       1 (manifest)
 *   parseNode drops the path check                              1 (node)
 *   parsePage drops the key check                               1 (page)
 *   byte cap skipped in parseObject                             2 (manifest, node)
 *   parseNode accepts formatVersion 2                           1 (node)
 *
 * Fix round 1 (each 1 failing test):
 *   manifest generation/mode check dropped; health check dropped;
 *   building check dropped
 *   page entries check dropped; page next check dropped; page formatVersion
 *   check dropped
 *   node coverage check dropped
 *   key builders: gen check dropped; hash check dropped; page check dropped
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { GRAPH_PREFIX } from "../../../packages/shared/src/storageLayout.cjs";
import { isPlumbing } from "../src/privacy/engine.js";
import { defaultIsIndexable } from "../src/search/maintain.js";
import {
  graphManifestKey,
  nameHash,
  nodeKey,
  pathHash,
  postingPageKey,
  urlHash,
} from "../src/graph/keys.js";
import {
  GRAPH_FORMAT_VERSION,
  GRAPH_RECORD_BYTE_CAP,
  POSTING_PAGE_SIZE,
  parseManifest,
  parseNode,
  parsePage,
  serializeManifest,
  serializeNode,
  serializePage,
} from "../src/graph/records.js";

const H = "a".repeat(64);
const manifest = () => ({
  formatVersion: 1,
  generation: "1",
  building: null,
  mode: "conditional",
  health: {
    state: "ready",
    sweepComplete: false,
    lastSweepAt: null,
    parserVersion: 1,
    resolverVersion: 1,
    urlKeyVersion: 1,
  },
});

const node = (path = "notes/a.md") => ({
  formatVersion: 1,
  path,
  observedSourceVersion: "etag-1",
  observedAt: "2026-01-01T00:00:00.000Z",
  parserVersion: 1,
  resolverVersion: 1,
  urlKeyVersion: 1,
  referenceSetVersion: "abc",
  occurrences: [{ kind: "wiki", target: "notes/b.md", start: 0, end: 10, fragment: "", style: "wiki" }],
  externalReferences: [{ urlHash: "f".repeat(64), start: 12, end: 30 }],
  coverage: "complete",
  reverseRepair: [{ family: "incoming", hash: "e".repeat(64) }],
});

test("constants", () => {
  assert.equal(GRAPH_PREFIX, ".context/graph/");
  assert.equal(GRAPH_FORMAT_VERSION, 1);
  assert.equal(POSTING_PAGE_SIZE, 256);
  assert.equal(graphManifestKey(), ".context/graph/v1/manifest.json");
});

test("keys: hashes are deterministic, case-sensitive sha256 hex", async () => {
  const a = await pathHash("A.md");
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, await pathHash("A.md"));
  assert.notEqual(a, await pathHash("a.md"));
  // sha256("abc")
  assert.equal(await pathHash("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(await nameHash("abc"), await pathHash("abc"));
  assert.equal(await urlHash("abc"), await pathHash("abc"));
});

test("keys: layout under the generation", async () => {
  const h = await pathHash("a.md");
  assert.equal(nodeKey("3", h), `.context/graph/v1/g/3/nodes/${h}.json`);
  assert.equal(postingPageKey("3", "incoming", h, 0), `.context/graph/v1/g/3/incoming/${h}/0.json`);
  assert.equal(postingPageKey("3", "urls", h, 2), `.context/graph/v1/g/3/urls/${h}/2.json`);
  assert.throws(() => postingPageKey("3", "bogus", h, 0));
});

test("every key keys.js produces is plumbing and never indexable", async () => {
  const h = await pathHash("a.md");
  const keys = [
    graphManifestKey(),
    nodeKey("1", h),
    ...["incoming", "bare", "names", "urls"].map((f) => postingPageKey("1", f, h, 0)),
  ];
  for (const key of keys) {
    assert.ok(key.startsWith(GRAPH_PREFIX), key);
    assert.equal(isPlumbing(key), true, key);
    assert.equal(defaultIsIndexable(key), false, key);
  }
});

test("manifest round trip and null cases", () => {
  const m = manifest();
  assert.deepEqual(parseManifest(serializeManifest(m)), m);
  assert.equal(parseManifest("{not json"), null);
  assert.equal(parseManifest("null"), null);
  assert.equal(parseManifest(JSON.stringify({ ...m, formatVersion: 2 })), null);
  assert.equal(parseManifest(JSON.stringify({ ...m, formatVersion: 0 })), null);
  assert.equal(parseManifest(JSON.stringify({ ...m, pad: "x".repeat(GRAPH_RECORD_BYTE_CAP) })), null);
});

test("node round trip and null cases", () => {
  const n = node();
  assert.deepEqual(parseNode(serializeNode(n), "notes/a.md"), n);
  assert.equal(parseNode("{not json", "notes/a.md"), null);
  assert.equal(parseNode(JSON.stringify({ ...n, formatVersion: 2 }), "notes/a.md"), null);
  assert.equal(parseNode(serializeNode(n), "notes/other.md"), null);
  assert.equal(parseNode(serializeNode(n), "Notes/a.md"), null);
  const big = { ...n, occurrences: Array.from({ length: 4000 }, () => n.occurrences[0]) };
  assert.ok(serializeNode(big).length > GRAPH_RECORD_BYTE_CAP);
  assert.equal(parseNode(serializeNode(big), "notes/a.md"), null);
});

test("page round trip and null cases", async () => {
  const key = postingPageKey("1", "incoming", await pathHash("b.md"), 0);
  const page = { key, entries: [{ source: "notes/a.md", referenceSetVersion: "abc" }], next: "1" };
  const withVersion = { ...page, formatVersion: 1 };
  assert.deepEqual(parsePage(serializePage(page), key), withVersion);
  assert.equal(JSON.parse(serializePage(page)).formatVersion, 1);
  const last = { key, entries: [] };
  assert.deepEqual(parsePage(serializePage(last), key), { ...last, formatVersion: 1 });
  const raw = (o) => JSON.stringify({ formatVersion: 1, ...o });
  assert.equal(parsePage(JSON.stringify({ key, entries: [] }), key), null);
  assert.equal(parsePage(JSON.stringify({ formatVersion: 2, key, entries: [] }), key), null);
  assert.equal(parsePage(raw({ key, entries: ["x"] }), key), null);
  assert.equal(parsePage(raw({ key, entries: [null] }), key), null);
  assert.equal(parsePage(raw({ key, entries: [{ source: 1, referenceSetVersion: "a" }] }), key), null);
  assert.equal(parsePage(raw({ key, entries: [{ source: "a.md" }] }), key), null);
  assert.equal(parsePage(raw({ key, entries: [], next: "../x" }), key), null);
  assert.equal(parsePage(raw({ key, entries: [], next: 3 }), key), null);
  assert.equal(parsePage("{not json", key), null);
  assert.equal(parsePage(serializePage(page), key.replace("/0.json", "/1.json")), null);
});

test("manifest rejects malformed fields", () => {
  const m = manifest();
  const bad = [
    { generation: "../x" }, { generation: 1 }, { generation: "" }, { generation: undefined },
    { mode: "other" }, { mode: undefined },
    { health: null }, { health: "ready" }, { health: { ...m.health, state: "weird" } },
    { building: {} }, { building: { generation: "x", startedAt: "t" } },
    { building: { generation: "2" } }, { building: undefined }, { building: "no" },
  ];
  for (const patch of bad) assert.equal(parseManifest(JSON.stringify({ ...m, ...patch })), null, JSON.stringify(patch));
  const ok = { ...m, building: { generation: "2", startedAt: "2026-01-01T00:00:00.000Z" } };
  assert.deepEqual(parseManifest(serializeManifest(ok)), ok);
});

test("node rejects malformed fields", () => {
  const n = node();
  for (const patch of [{ occurrences: {} }, { occurrences: undefined }, { externalReferences: "x" },
    { externalReferences: undefined }, { coverage: "full" }, { coverage: undefined }]) {
    assert.equal(parseNode(JSON.stringify({ ...n, ...patch }), "notes/a.md"), null, JSON.stringify(patch));
  }
});

test("key builders throw on bad segments and never leave the graph prefix", () => {
  assert.throws(() => nodeKey("../../../x", H), TypeError);
  assert.throws(() => nodeKey("1", "../../x"), TypeError);
  assert.throws(() => nodeKey("1", "A".repeat(64)), TypeError);
  assert.throws(() => nodeKey(1, H), TypeError);
  assert.throws(() => nodeKey("", H), TypeError);
  assert.throws(() => postingPageKey("../x", "incoming", H, 0), TypeError);
  assert.throws(() => postingPageKey("1", "incoming", "../x", 0), TypeError);
  for (const page of [-1, 1.5, "0", "../0", NaN, undefined]) {
    assert.throws(() => postingPageKey("1", "incoming", H, page), TypeError, String(page));
  }
  assert.ok(nodeKey("12", H).startsWith(GRAPH_PREFIX));
});
