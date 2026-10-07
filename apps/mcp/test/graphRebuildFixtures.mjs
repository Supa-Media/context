/**
 * Shared helpers for graphRebuild.test.mjs (split out so that file stays under
 * the architecture review threshold).
 */

import assert from "node:assert/strict";

import { reconcileGraph } from "../src/graph/reconcile.js";
import { loadGraphManifest } from "../src/graph/manifest.js";
import { validateEntry } from "../src/graph/project.js";
import { readPostings } from "../src/graph/postings.js";
import { RESOLVER_VERSION } from "../src/graph/facts.js";
import { generationPrefix, graphManifestKey, nodeKey, pathHash, postingPageKey } from "../src/graph/keys.js";
import { parseNode } from "../src/graph/records.js";
import { GRAPH_PREFIX } from "../../../packages/shared/src/storageLayout.cjs";
import { createSearchBudget, defaultIsIndexable } from "../src/search/maintain.js";
import { memoryBucket } from "./store/fixtures.mjs";

export const now = 1_700_000_000_000;
export const big = () => createSearchBudget(100000);
export const links = (...targets) => targets.map((t) => `[${t}](./${t})`).join(" ");
export const pad = (i) => String(i).padStart(3, "0");

export function bucket({ conditional = true, conditionalDelete = true } = {}) {
  const b = memoryBucket();
  b.capabilities = conditional
    ? { conditionalWrite: true, conditionalCreate: true, conditionalDelete }
    : { conditionalDelete };
  return b;
}
/** A view of `b` whose `list` honours `limit` and `cursor` like R2 does. */
export function paged(b) {
  return {
    ...b,
    async list(options = {}) {
      const all = (await b.list({ prefix: options.prefix })).objects;
      const start = options.cursor ? Number(options.cursor) : 0;
      const end = options.limit ? start + options.limit : all.length;
      const truncated = end < all.length;
      return { objects: all.slice(start, end), truncated, ...(truncated && { cursor: String(end) }) };
    },
  };
}
export function censusOf(b) {
  const census = new Map();
  for (const [key, { etag }] of b.objects) if (defaultIsIndexable(key)) census.set(key, etag);
  return census;
}
export const pass = (b, budget = big(), extra = {}) =>
  reconcileGraph(b, budget, {
    census: censusOf(b),
    censusComplete: true,
    removedHints: [],
    isIndexable: defaultIsIndexable,
    now,
    ...extra,
  });
export const manifestOf = (b) => loadGraphManifest(b, big());
export const rawManifest = (b) => JSON.parse(b.objects.get(graphManifestKey()).body);
export const nodeIn = async (b, gen, path) => {
  const got = await b.get(nodeKey(gen, await pathHash(path)));
  return got ? parseNode(await got.text(), path) : null;
};
export const settledIn = async (b, gen, path) => {
  const n = await nodeIn(b, gen, path);
  return n !== null && n.observedSourceVersion === b.objects.get(path).etag && n.reverseRepair.length === 0;
};
/** Validated backlinks of `target` as a reader pinned to `gen` sees them. */
export const backlinks = async (b, gen, target) => {
  const { entries } = await readPostings(b, big(), {
    gen, family: "incoming", hash: await pathHash(target), canSee: () => true, validate: validateEntry(b, big(), gen),
  });
  return entries.map((e) => e.source).sort();
};
export const keysUnder = (b, prefix) => [...b.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
export const snapshot = (b, prefix) => keysUnder(b, prefix).map((k) => `${k}=${b.objects.get(k).body}`);

/** Simulate deploying code with a newer resolver: the manifest names an older one. */
export async function bump(b) {
  const m = rawManifest(b);
  await b.put(graphManifestKey(), JSON.stringify({ ...m, resolverVersion: RESOLVER_VERSION - 1 }));
}
export async function converge(b, budget = big) {
  for (let i = 0; i < 10; i += 1) {
    await pass(b, budget());
    if ((await manifestOf(b))?.health.state === "ready") return;
  }
  assert.fail("did not converge");
}
/** Bump and pass at a big budget until `gen` is serving. */
export async function rebuildTo(b, gen, store = b) {
  await bump(b);
  for (let i = 0; i < 10; i += 1) {
    await pass(store);
    if ((await manifestOf(b)).generation === gen) return;
  }
  assert.fail(`no cutover to ${gen}`);
}

export async function seed(b) {
  await b.put("a.md", links("t.md", "u.md"));
  await b.put("b.md", links("t.md"));
  await b.put("c.md", "no links");
  await b.put("t.md", links("a.md"));
  await b.put("u.md", "plain");
}

/** Records every delete and every write outside the graph prefix. */
export function audited(b) {
  const log = { deleted: [], outside: [] };
  const store = {
    ...paged(b),
    put: (k, v, o) => { if (!k.startsWith(GRAPH_PREFIX)) log.outside.push(k); return b.put(k, v, o); },
    delete: (k, o) => { log.deleted.push(k); if (!k.startsWith(GRAPH_PREFIX)) log.outside.push(k); return b.delete(k, o); },
  };
  return { store, log };
}
export async function twoCutovers(b) {
  await seed(b);
  await b.put(".context/forwarding.json", "{\"fake\":true}");
  await b.put(".context/search/manifest.json", "{\"fake\":true}");
  // A decoy generation whose prefix shares the digit: g/10/ is not g/1/.
  await b.put(`${generationPrefix("10")}nodes/decoy.json`, "{}");
  await converge(b);
  await rebuildTo(b, "2");
  await rebuildTo(b, "3");
}

/** A store whose deletes under `prefix` always fail, like a 403 on a locked prefix. */
export const refusingDeletes = (b, prefix) => ({
  ...paged(b),
  delete: (k, o) => (k.startsWith(prefix) ? Promise.reject(new Error("403")) : b.delete(k, o)),
});
/** Captures console.error and console.warn lines during `fn`. */
export async function capturingLogs(fn) {
  const lines = [];
  const saved = [console.error, console.warn];
  console.error = (...a) => lines.push(a.join(" "));
  console.warn = (...a) => lines.push(a.join(" "));
  try {
    await fn();
  } finally {
    [console.error, console.warn] = saved;
  }
  return lines;
}

/** Generation 3 serving and `collect` naming 1, with `junk` extra keys under g/1/. */
export async function collecting(conditional, junk) {
  const b = bucket({ conditional });
  await twoCutovers(b);
  assert.equal(rawManifest(b).collect, "1");
  for (let i = 0; i < junk; i += 1) b.objects.set(`${generationPrefix("1")}junk/${String(i).padStart(6, "0")}.json`, { body: "{}", etag: `j${i}` });
  return b;
}
/** Passes at budget `B` until `done()`; the pass count, or null after `max`. */
export async function passesUntil(b, B, max, done) {
  for (let p = 1; p <= max; p += 1) {
    const budget = createSearchBudget(B);
    await pass(paged(b), budget);
    assert.ok(budget.spent <= B, `spent ${budget.spent} > ${B}`);
    if (await done()) return p;
  }
  return null;
}
/** `b` as code one resolver version older sees it: manifest labels read one newer and are written back one older. */
export function olderCode(b) {
  const shift = (text, d) => {
    const m = JSON.parse(text);
    const s = (r) => (r && Number.isInteger(r.resolverVersion) ? { ...r, resolverVersion: r.resolverVersion + d } : r);
    return JSON.stringify({ ...s(m), building: s(m.building) });
  };
  return {
    ...paged(b),
    async get(k) {
      const got = await b.get(k);
      if (!got || k !== graphManifestKey()) return got;
      const text = shift(await got.text(), 1);
      return { ...got, text: async () => text };
    },
    put: (k, v, o) => b.put(k, k === graphManifestKey() ? shift(v, -1) : v, o),
  };
}

/**
 * One scheduling cell (fix round 3): `t.md` linked from N notes, generation 1
 * ready, then `collect` names a junk generation 9 and t.md's incoming head is
 * dropped. `health`: "ready"; "stuck" (an unreadable note keeps every wrap
 * behind); "rollback" (a building generation labelled newer, no newer code
 * running). Passes at budget `B` until GC has emptied g/9/ and the audit has
 * restored the dropped memberships; `{ gcAt, auditAt }`, null past `max`.
 */
export async function scheduleCell(conditional, B, N, health, max) {
  const b = bucket({ conditional });
  let unreadable = false;
  const store = { ...paged(b), get: (k) => (unreadable && k === "bad.md" ? Promise.reject(new Error("io")) : b.get(k)) };
  await b.put("t.md", "x");
  for (let i = 0; i < N; i += 1) await b.put(`n${pad(i)}.md`, links("t.md"));
  if (health === "stuck") await b.put("bad.md", "plain");
  for (let i = 0; i < 10; i += 1) await pass(store);
  assert.equal(rawManifest(b).health.state, "ready");
  const junk = generationPrefix("9");
  for (let i = 0; i < 30; i += 1) b.objects.set(`${junk}j${i}.json`, { body: "{}", etag: `j${i}` });
  const m = { ...rawManifest(b), collect: "9" };
  if (health === "rollback") m.building = { generation: "5", startedAt: "t", parserVersion: m.parserVersion, resolverVersion: m.resolverVersion + 1, urlKeyVersion: m.urlKeyVersion };
  await b.put(graphManifestKey(), JSON.stringify(m));
  if (health === "stuck") {
    unreadable = true;
    await b.put("bad.md", "plain edited");
  }
  const hash = await pathHash("t.md");
  b.objects.delete(postingPageKey("1", "incoming", hash, 0));
  const restored = async () =>
    (await readPostings(b, createSearchBudget(100000), { gen: "1", family: "incoming", hash, canSee: () => true, validate: () => true })).entries.length >= N;
  let gcAt = null;
  let auditAt = null;
  for (let p = 1; p <= max && (gcAt === null || auditAt === null); p += 1) {
    await pass(store, createSearchBudget(B));
    if (gcAt === null && keysUnder(b, junk).length === 0) gcAt = p;
    if (auditAt === null && (await restored())) auditAt = p;
  }
  return { gcAt, auditAt };
}
