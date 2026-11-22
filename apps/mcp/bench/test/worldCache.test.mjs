/**
 * A built world kept and loaded (`evals/worldCache.mjs`): a second run of the same notes loads what the first built
 * and ranks exactly as it did, and any change to the notes or the code names a different world.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { writeBeir } from "../../../../packages/bench/src/beir.mjs";
import { runSearchSet } from "../evals/searchCli.mjs";
import { codeHash, worldKey } from "../evals/worldCache.mjs";

const quiet = async (fn) => {
  const write = process.stderr.write;
  process.stderr.write = () => true;
  try {
    return await fn();
  } finally {
    process.stderr.write = write;
  }
};

const set = (third) => ({
  id: "scifact",
  revision: null,
  corpus: [
    { _id: "1", title: "", text: "Vitamin D supplements lower the risk of bone fractures in older adults." },
    { _id: "2", title: "", text: "Coffee drinking is linked to a lower risk of liver disease." },
    { _id: "3", title: "", text: third },
  ],
  queries: [
    { _id: "q1", text: "coffee and liver disease" },
    { _id: "q2", text: "running blood pressure" },
  ],
  qrels: { q1: { 2: 1 }, q2: { 3: 1 } },
});

test("a built world is kept once, loaded by the next run with the same ranks, and rebuilt when a note changes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bench-worlds-"));
  const cache = join(dir, "worlds");
  writeBeir(join(dir, "nanobeir", "scifact"), set("Regular running improves heart health and lowers blood pressure."));
  const run = () => quiet(() => runSearchSet({ bench: "nanobeir", sets: "scifact", fetch: dir, fake: true, "world-cache": cache }));
  try {
    const built = await run();
    const kept = readdirSync(cache);
    assert.equal(kept.length, 1, "one world kept");
    assert.ok(existsSync(join(cache, kept[0], "done")));
    assert.ok(existsSync(join(cache, kept[0], "objects", "objects.json")), "the object world is kept beside the bucket world");
    const loaded = await run();
    assert.deepEqual(readdirSync(cache), kept, "the second run built nothing new");
    assert.deepEqual(loaded.rows.map((r) => [r.id, r.rank, r.objectRank]), built.rows.map((r) => [r.id, r.rank, r.objectRank]));
    assert.equal(loaded.search.ndcg10, 1);
    assert.equal(loaded.search.objectNdcg10, 1);
    // A changed note is a different world: the kept one is never read for it.
    rmSync(join(dir, "nanobeir"), { recursive: true, force: true });
    writeBeir(join(dir, "nanobeir", "scifact"), set("Regular running improves heart health and lowers blood pressure a lot."));
    await run();
    assert.equal(readdirSync(cache).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the world's name changes with the code that builds it", () => {
  const repo = mkdtempSync(join(tmpdir(), "bench-code-"));
  try {
    mkdirSync(join(repo, "apps", "mcp", "src", "search"), { recursive: true });
    writeFileSync(join(repo, "apps", "mcp", "src", "search", "fts.js"), "export const a = 1;\n");
    writeFileSync(join(repo, "apps", "mcp", "src", "search", "fts.test.mjs"), "// a test\n");
    const bench = { people: [], workspaces: { w: { files: { "a.md": "hello" } } } };
    const before = codeHash(repo);
    const key = worldKey({ bench, embedder: "fake", repo });
    writeFileSync(join(repo, "apps", "mcp", "src", "search", "fts.test.mjs"), "// a changed test\n");
    assert.equal(codeHash(repo), before, "a test file is not the world's code");
    writeFileSync(join(repo, "apps", "mcp", "src", "search", "fts.js"), "export const a = 2;\n");
    assert.notEqual(codeHash(repo), before);
    assert.notEqual(worldKey({ bench, embedder: "fake", repo }), key);
    assert.notEqual(worldKey({ bench, embedder: "workers-ai", repo }), key, "another embedder is another world");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
