/**
 * The old-copy cleanup's pages (`src/moves/cleanupPage.js`, routed by
 * `src/moves/mover.js`): list a bucket a page at a time, and delete the keys
 * the control plane approved. The gateway is the second guard: a key under
 * `notes/` or `files/`, or under `.context/` outside the three folders the
 * cleanup owns, is refused here even if the control plane sent it.
 *
 * Sabotage, each confirmed to fail a case here: let the list read bodies (the
 * no-read case), accept `notes/` or `.context/collaboration/` in the delete
 * page (the guard cases), or answer a failed delete with the error's text (the
 * redaction case).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { cleanupKey } from "../src/moves/cleanupKeys.js";
import { runCleanupDeletePage, runCleanupListPage } from "../src/moves/cleanupPage.js";
import { handleMoverPage, MOVER_PAGE_PATH } from "../src/moves/mover.js";

const SECRET = "gateway-secret-for-tests";
const env = { GATEWAY_SECRET: SECRET };
const WS = "ws-1";
const source = { workspaceId: WS, provider: "r2", bucket: "customer" };

/** A bucket in memory: list in key order, delete, and a get that counts reads. */
function memoryStore(seed = [], { failDelete = [] } = {}) {
  const objects = new Map(seed.map((key) => [key, { etag: `e-${key}` }]));
  const reads = [];
  const deletes = [];
  return {
    objects,
    reads,
    deletes,
    capabilities: { conditionalWrite: true },
    async list({ cursor, limit }) {
      const keys = [...objects.keys()].sort().filter((key) => cursor === undefined || key > cursor);
      const page = keys.slice(0, limit);
      return { objects: page.map((key) => ({ key, size: 1 })), truncated: keys.length > limit, cursor: page.at(-1) };
    },
    async get(key) {
      reads.push(key);
      return null;
    },
    async head(key) {
      return objects.has(key) ? { etag: objects.get(key).etag, size: 1 } : null;
    },
    async delete(key) {
      deletes.push(key);
      if (failDelete.includes(key)) throw new Error(`provider said: secret text about ${key}`);
      objects.delete(key);
      return null;
    },
  };
}

const buildWith = (store) => ({ buildStore: () => store });

test("the key rule: note and attachment keys and the collaboration history are never the cleanup's", () => {
  for (const key of ["notes/a.md", "files/a.png", "notes", "files", ".context/collaboration/x", ".context", ".context/settings.json", ".obsidian/plugins/x/main.js", ".audit/2026-10.jsonl", ".history/a.md"]) {
    assert.equal(cleanupKey(key), false, key);
  }
  for (const key of ["1-projects/foo.md", "privacy.md", "index.md", "notesx.md", ".context/trash/s/x.md", ".context/moves/m.json", ".context/access/a.json"]) {
    assert.equal(cleanupKey(key), true, key);
  }
});

test("a list page returns the keys and a cursor, and reads no bodies", async () => {
  const store = memoryStore(["1-projects/a.md", "1-projects/b.md", "notes/n1.md"]);
  const page = await runCleanupListPage({ workspaceId: WS, source, cursor: undefined, limit: 2 }, buildWith(store));
  assert.deepEqual(page, { keys: ["1-projects/a.md", "1-projects/b.md"], nextCursor: "1-projects/b.md" });
  const last = await runCleanupListPage({ workspaceId: WS, source, cursor: page.nextCursor, limit: 2 }, buildWith(store));
  assert.deepEqual(last, { keys: ["notes/n1.md"], nextCursor: null });
  assert.deepEqual(store.reads, []);
});

test("a delete page deletes what it is given, and reports each key on its own", async () => {
  const store = memoryStore(["1-projects/a.md", "index.md"]);
  const { results } = await runCleanupDeletePage({ workspaceId: WS, source, keys: ["1-projects/a.md", "gone.md", "index.md"] }, buildWith(store));
  assert.deepEqual(results, [
    { key: "1-projects/a.md", ok: true },
    { key: "gone.md", ok: true },
    { key: "index.md", ok: true },
  ]);
  assert.deepEqual([...store.objects.keys()], []);
});

test("a delete page refuses a key outside the cleanup, and deletes nothing for it", async () => {
  const keep = ["notes/n1.md", "files/f.png", ".context/collaboration/doc.yjs", ".context/settings.json", "notes"];
  const store = memoryStore([...keep, "old.md"]);
  const { results } = await runCleanupDeletePage({ workspaceId: WS, source, keys: [...keep, "old.md"] }, buildWith(store));
  assert.deepEqual(store.deletes, ["old.md"]);
  for (const key of keep) assert.deepEqual(results.find((result) => result.key === key), { key, ok: false, reason: "kept" });
  assert.equal(store.objects.size, keep.length);
});

test("a failed delete answers a fixed reason, never the provider's text", async () => {
  const store = memoryStore(["old.md"], { failDelete: ["old.md"] });
  const { results } = await runCleanupDeletePage({ workspaceId: WS, source, keys: ["old.md"] }, buildWith(store));
  assert.deepEqual(results, [{ key: "old.md", ok: false, reason: "delete_failed" }]);
  assert.equal(JSON.stringify(results).includes("secret"), false);
});

test("the mover routes both cleanup kinds, and refuses a page with a malformed key before deleting", async () => {
  const store = memoryStore(["old.md", "notes/n1.md"]);
  const make = (page) => ({
    controlPlane: { openMoverPage: async () => ({ ...page, workspaceId: WS, source }) },
    buildStore: () => store,
  });
  const request = (ticket) =>
    new Request(`https://gateway.example.test${MOVER_PAGE_PATH}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ticket }),
    });
  const listed = await (await handleMoverPage(request("t1"), env, make({ kind: "cleanupList", cursor: undefined, limit: 10 }))).json();
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.keys, ["notes/n1.md", "old.md"]);
  const deleted = await (await handleMoverPage(request("t2"), env, make({ kind: "cleanupDelete", keys: ["notes/n1.md", "old.md"] }))).json();
  assert.equal(deleted.ok, true);
  assert.deepEqual(deleted.results.map((r) => [r.key, r.ok]), [["notes/n1.md", false], ["old.md", true]]);
  const bad = await (await handleMoverPage(request("t3"), env, make({ kind: "cleanupDelete", keys: ["x/../y"] }))).json();
  assert.equal(bad.ok, false);
  assert.equal(store.deletes.length, 1);
});
