/**
 * The bench's examples index (`bench/texExamplesIndex.mjs`): no index without credentials; each moment embedded once and
 * the vectors reused from the cache file; the nearest moments answered from memory; no text written to the cache.
 *
 * Sabotage that each test catches:
 *   1. an index built with no credentials                      "no account or token: no index" fails
 *   2. every build embedding every moment again                 "a second build embeds nothing" fails
 *   3. the cache keyed by something other than the text hash    "a changed moment is embedded again" fails
 *   4. the query answered with the wrong moments                "the query returns the nearest moment" fails
 *   5. the moment text written into the cache file              "the cache holds vectors, never text" fails
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { EXAMPLES_CACHE_FILE, benchExamplesIndex, benchExamplesIndexOnce } from "../texExamplesIndex.mjs";
import { MEANING_DIMENSIONS, MEANING_MODEL } from "../../src/search/meaning/embed.js";

const require = createRequire(import.meta.url);
const GENERATED = require("../../../../packages/tex/src/texTraining.generated.json");
const { indexEntries } = require("../../../../packages/tex/src/texExamples.cjs");

const ENTRIES = indexEntries(GENERATED);
const UNIQUE_TEXTS = new Set(ENTRIES.map((entry) => entry.text)).size;

/**
 * A fake Workers AI REST endpoint: each distinct text gets its own unit vector (the next axis), so a text's nearest
 * neighbour is itself. Counts the texts it was asked to embed.
 */
function fakeRest() {
  const axes = new Map();
  const seen = { texts: 0, calls: 0 };
  const fetchImpl = async (url, init) => {
    assert.match(url, new RegExp(`/ai/run/${MEANING_MODEL.replace("/", "\\/")}$`));
    seen.calls += 1;
    const { text } = JSON.parse(init.body);
    seen.texts += text.length;
    const data = text.map((t) => {
      if (!axes.has(t)) axes.set(t, axes.size % MEANING_DIMENSIONS);
      const vector = new Array(MEANING_DIMENSIONS).fill(0);
      vector[axes.get(t)] = 1;
      return vector;
    });
    return new Response(JSON.stringify({ success: true, result: { shape: [text.length, MEANING_DIMENSIONS], data } }), { status: 200 });
  };
  return { fetchImpl, seen, axisOf: (t) => axes.get(t) };
}

test("no account or no token: there is no index, and nothing is sent", async () => {
  const rest = fakeRest();
  const dir = await mkdtemp(join(tmpdir(), "examples-index-"));
  try {
    assert.equal(await benchExamplesIndex({ accountId: "", apiToken: "t", cacheDir: dir, fetchImpl: rest.fetchImpl }), null);
    assert.equal(await benchExamplesIndex({ accountId: "a", apiToken: "", cacheDir: dir, fetchImpl: rest.fetchImpl }), null);
    assert.equal(await benchExamplesIndex({ cacheDir: dir, fetchImpl: rest.fetchImpl }), null);
    assert.equal(rest.seen.calls, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("each moment is embedded once, a second build reuses the cache, and the query returns the nearest moments", async () => {
  const rest = fakeRest();
  const dir = await mkdtemp(join(tmpdir(), "examples-index-"));
  try {
    const first = await benchExamplesIndex({ accountId: "acct", apiToken: "tok", cacheDir: dir, fetchImpl: rest.fetchImpl });
    assert.equal(rest.seen.texts, UNIQUE_TEXTS, "every distinct moment text is embedded exactly once");

    const again = await benchExamplesIndex({ accountId: "acct", apiToken: "tok", cacheDir: dir, fetchImpl: rest.fetchImpl });
    assert.equal(rest.seen.texts, UNIQUE_TEXTS, "a second build embeds nothing: the cache answers");
    assert.equal(typeof again.embed, "function");

    // A moment's own vector finds that moment first.
    const target = ENTRIES.find((entry) => ENTRIES.filter((e) => e.text === entry.text).length === 1 && ENTRIES.indexOf(entry) > 2);
    const [vector] = await first.embed([target.text]);
    const res = await first.query(vector, { topK: 3 });
    assert.equal(res.matches.length, 3);
    assert.equal(res.matches[0].id, target.id);
    assert.ok(Math.abs(res.matches[0].score - 1) < 1e-9);
    assert.ok(res.matches[1].score <= res.matches[0].score, "best first");

    // The cache file holds vectors keyed by hash, never a moment's text.
    const file = await readFile(join(dir, EXAMPLES_CACHE_FILE), "utf8");
    const parsed = JSON.parse(file);
    assert.equal(parsed.model, MEANING_MODEL);
    assert.equal(Object.keys(parsed.vectors).length, UNIQUE_TEXTS);
    assert.ok(!file.includes(target.text), "the cache never holds moment text");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a changed moment is embedded again, and only that one", async () => {
  const rest = fakeRest();
  const dir = await mkdtemp(join(tmpdir(), "examples-index-"));
  try {
    await benchExamplesIndex({ accountId: "acct", apiToken: "tok", cacheDir: dir, fetchImpl: rest.fetchImpl });
    const path = join(dir, EXAMPLES_CACHE_FILE);
    const parsed = JSON.parse(await readFile(path, "utf8"));
    const [dropped] = Object.keys(parsed.vectors);
    delete parsed.vectors[dropped];
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, JSON.stringify(parsed));
    const before = rest.seen.texts;
    await benchExamplesIndex({ accountId: "acct", apiToken: "tok", cacheDir: dir, fetchImpl: rest.fetchImpl });
    assert.equal(rest.seen.texts - before, 1, "only the moment missing from the cache is embedded");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("one build per process: the same options share one index", async () => {
  const rest = fakeRest();
  const dir = await mkdtemp(join(tmpdir(), "examples-index-"));
  try {
    const options = { accountId: "acct-once", apiToken: "tok", cacheDir: dir, fetchImpl: rest.fetchImpl };
    const a = benchExamplesIndexOnce(options);
    const b = benchExamplesIndexOnce(options);
    assert.equal(a, b);
    await a;
    assert.equal(rest.seen.texts, UNIQUE_TEXTS, "one build embeds the moments once");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
