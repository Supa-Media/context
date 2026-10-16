/**
 * The path-to-id move's pages (`src/moves/idCopyPage.js`, routed by
 * `src/moves/mover.js`): copy each path's bytes to its `notes/` or `files/`
 * key inside one bucket, and report what the id key holds.
 *
 * Sabotage, each confirmed to fail a case here: copy an object over the size
 * cap without the unread check (the too-large case), drop the etag
 * precondition (the changed case), skip the post-write verify (the verify
 * case), accept a key outside `notes/` or `files/` (the routing case), or
 * answer a failure with the error's own message (the redaction case).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { runIdCheckPage, runIdCopyPage } from "../src/moves/idCopyPage.js";
import { handleMoverPage, MOVER_PAGE_PATH } from "../src/moves/mover.js";

const SECRET = "gateway-secret-for-tests";
const env = { GATEWAY_SECRET: SECRET };
const MB = 1024 * 1024;
const WS = "ws-1";

/** A bucket in memory. `copy` is optional, so the put path is exercised by one without it. */
function memoryStore({ seed = {}, serverCopy = false } = {}) {
  const objects = new Map(
    Object.entries(seed).map(([key, text], index) => [key, { bytes: new TextEncoder().encode(text), etag: `s${index}`, contentType: "text/markdown" }]),
  );
  const reads = [];
  let n = 100;
  const store = {
    objects,
    reads,
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true, serverSideCopy: serverCopy ? "same-store" : false },
    async head(key) {
      const hit = objects.get(key);
      if (!hit) return null;
      return { etag: hit.etag, size: hit.bytes.byteLength };
    },
    async get(key) {
      reads.push(key);
      const hit = objects.get(key);
      if (!hit) return null;
      return { etag: hit.etag, contentType: hit.contentType, size: hit.bytes.byteLength, arrayBuffer: async () => hit.bytes.slice().buffer };
    },
    async put(key, value, options = {}) {
      const etag = `e${++n}`;
      objects.set(key, { bytes: new Uint8Array(value.slice(0)), etag, contentType: options.contentType });
      return { etag };
    },
    async copy(from, to, options = {}) {
      const hit = objects.get(from);
      if (!hit) return null;
      if (options.sourceOnlyIf?.etagMatches !== hit.etag) return null;
      const etag = `c${++n}`;
      objects.set(to, { bytes: hit.bytes.slice(), etag, contentType: hit.contentType });
      return { etag };
    },
  };
  if (!serverCopy) delete store.copy;
  return store;
}

/** The store the page builds, handed to the run as the one bucket it is. */
function buildWith(store) {
  const built = [];
  const buildStore = (binding, _workspace, options) => {
    built.push({ binding, options });
    return store;
  };
  return { buildStore, built };
}

const source = { workspaceId: WS, provider: "r2", bucket: "managed" };
const limits = { lanes: 4, byteBudget: 16 * MB };

function item(path, key, store, extra = {}) {
  const hit = store.objects.get(path);
  return { path, key, etag: hit.etag, size: hit.bytes.byteLength, ...extra };
}

function silenced(fn) {
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(JSON.stringify(args));
  return fn().finally(() => {
    console.error = original;
  }).then((value) => ({ value, logged }));
}

test("without server-side copy, each path's bytes are read and written to its id key", async () => {
  const store = memoryStore({ seed: { "1-projects/foo.md": "# Foo", "2-areas/pic.png": "png-bytes" } });
  const { buildStore, built } = buildWith(store);
  const page = {
    kind: "idCopy",
    workspaceId: WS,
    source,
    items: [item("1-projects/foo.md", "notes/n1.md", store), item("2-areas/pic.png", "files/n2.png", store)],
    limits,
  };
  const { results } = await runIdCopyPage(page, { buildStore });
  assert.equal(results.length, 2);
  assert.equal(results[0].ok, true);
  assert.equal(results[0].path, "1-projects/foo.md");
  assert.equal(typeof results[0].copiedEtag, "string");
  assert.equal(results[1].ok, true);
  assert.equal(new TextDecoder().decode(store.objects.get("notes/n1.md").bytes), "# Foo");
  assert.equal(store.objects.get("notes/n1.md").contentType, "text/markdown");
  assert.equal(new TextDecoder().decode(store.objects.get("files/n2.png").bytes), "png-bytes");
  // The bare adapter, so sealed bytes travel as they are.
  assert.deepEqual(built.map((entry) => entry.options), [{ sealedObjects: true }]);
  // The path key is never removed here; retiring it is the control plane's step.
  assert.ok(store.objects.has("1-projects/foo.md"));
});

test("with same-store server-side copy, the bytes never pass through the gateway", async () => {
  const store = memoryStore({ seed: { "1-projects/foo.md": "# Foo" }, serverCopy: true });
  const { buildStore } = buildWith(store);
  const page = { kind: "idCopy", workspaceId: WS, source, items: [item("1-projects/foo.md", "notes/n1.md", store)], limits };
  const { results } = await runIdCopyPage(page, { buildStore });
  assert.equal(results[0].ok, true);
  assert.equal(results[0].copiedEtag.startsWith("c"), true);
  assert.deepEqual(store.reads, [], "a server-side copy reads nothing");
  assert.equal(new TextDecoder().decode(store.objects.get("notes/n1.md").bytes), "# Foo");
});

test("an etag that moved since the plan is changed, and nothing is written", async () => {
  for (const serverCopy of [false, true]) {
    const store = memoryStore({ seed: { "a.md": "old" }, serverCopy });
    const { buildStore } = buildWith(store);
    const planned = item("a.md", "notes/n1.md", store, { etag: "stale-etag" });
    const { results } = await runIdCopyPage({ kind: "idCopy", workspaceId: WS, source, items: [planned], limits }, { buildStore });
    assert.deepEqual(results, [{ path: "a.md", ok: false, reason: "changed" }]);
    assert.equal(store.objects.has("notes/n1.md"), false);
  }
});

test("a path that is gone is missing, and the rest of the page still copies", async () => {
  const store = memoryStore({ seed: { "b.md": "b" } });
  const { buildStore } = buildWith(store);
  const items = [
    { path: "gone.md", key: "notes/g.md", etag: "x", size: 1 },
    item("b.md", "notes/b.md", store),
  ];
  const { results } = await runIdCopyPage({ kind: "idCopy", workspaceId: WS, source, items, limits }, { buildStore });
  assert.deepEqual(results.map((r) => [r.path, r.ok, r.reason]), [["gone.md", false, "missing"], ["b.md", true, undefined]]);
});

test("an object over the size cap is too large and is never read", async () => {
  const store = memoryStore({ seed: { "meetings/call.m4a": "audio" } });
  const { buildStore } = buildWith(store);
  const big = { path: "meetings/call.m4a", key: "files/c1.m4a", etag: store.objects.get("meetings/call.m4a").etag, size: 20 * MB + 1 };
  const { results } = await runIdCopyPage({ kind: "idCopy", workspaceId: WS, source, items: [big], limits }, { buildStore });
  assert.deepEqual(results, [{ path: "meetings/call.m4a", ok: false, reason: "too_large" }]);
  assert.deepEqual(store.reads, [], "the oversized object is not read");
  assert.equal(store.objects.has("files/c1.m4a"), false);
});

test("a destination whose size differs from the source is verify_failed", async () => {
  const store = memoryStore({ seed: { "a.md": "hello" } });
  const put = store.put;
  store.put = async (key, value, options) => put(key, new TextEncoder().encode("hi").buffer, options);
  const { buildStore } = buildWith(store);
  const { results } = await runIdCopyPage({ kind: "idCopy", workspaceId: WS, source, items: [item("a.md", "notes/a.md", store)], limits }, { buildStore });
  assert.deepEqual(results, [{ path: "a.md", ok: false, reason: "verify_failed" }]);
});

test("a destination that does not exist after the write is verify_failed", async () => {
  const store = memoryStore({ seed: { "a.md": "hello" } });
  store.put = async () => ({ etag: "ghost" });
  const { buildStore } = buildWith(store);
  const { results } = await runIdCopyPage({ kind: "idCopy", workspaceId: WS, source, items: [item("a.md", "notes/a.md", store)], limits }, { buildStore });
  assert.deepEqual(results, [{ path: "a.md", ok: false, reason: "verify_failed" }]);
});

test("a thrown error is copy_failed, and no path or provider text reaches the log", async () => {
  const store = memoryStore({ seed: { "private/salary-review.md": "x" } });
  store.get = async (key) => {
    throw new Error(`GET ${key} refused by provider`);
  };
  const { buildStore } = buildWith(store);
  const page = { kind: "idCopy", workspaceId: WS, source, items: [item("private/salary-review.md", "notes/s.md", store)], limits };
  const { value, logged } = await silenced(() => runIdCopyPage(page, { buildStore }));
  assert.deepEqual(value.results, [{ path: "private/salary-review.md", ok: false, reason: "copy_failed" }]);
  assert.equal(logged.join("").includes("salary"), false);
  assert.equal(logged.length, 1, "one summary line");
  assert.ok(logged[0].includes(WS) && logged[0].includes("copy_failed"), "the summary names the workspace and the reason count");
});

test("check: same, missing, source_missing, differs by size and by bytes, and the same bytes under another etag", async () => {
  const store = memoryStore({
    seed: {
      "same.md": "same",
      "gone-dest.md": "x",
      "gone-src.md": "x",
      "size.md": "one",
      "bytes.md": "aaaa",
      "etag.md": "twin",
    },
  });
  store.objects.set("notes/same.md", { bytes: new TextEncoder().encode("same"), etag: "other-etag" });
  store.objects.set("notes/gone-src.md", { bytes: new TextEncoder().encode("x"), etag: "d" });
  store.objects.delete("gone-src.md");
  store.objects.set("notes/size.md", { bytes: new TextEncoder().encode("one!"), etag: "z" });
  store.objects.set("notes/bytes.md", { bytes: new TextEncoder().encode("bbbb"), etag: "y" });
  store.objects.set("notes/etag.md", { bytes: new TextEncoder().encode("twin"), etag: "fresh" });
  store.objects.set("etag.md", { bytes: new TextEncoder().encode("twin"), etag: "stale" });
  const { buildStore } = buildWith(store);
  const items = [
    { path: "same.md", key: "notes/same.md" },
    { path: "gone-dest.md", key: "notes/never.md" },
    { path: "gone-src.md", key: "notes/gone-src.md" },
    { path: "size.md", key: "notes/size.md" },
    { path: "bytes.md", key: "notes/bytes.md" },
    { path: "etag.md", key: "notes/etag.md" },
  ];
  const { results } = await runIdCheckPage({ kind: "idCheck", workspaceId: WS, source, items, limits }, { buildStore });
  assert.deepEqual(results, [
    { path: "same.md", state: "same" },
    { path: "gone-dest.md", state: "missing" },
    { path: "gone-src.md", state: "source_missing" },
    { path: "size.md", state: "differs" },
    { path: "bytes.md", state: "differs" },
    { path: "etag.md", state: "same" },
  ]);
});

test("the mover runs an id page and answers its results", async () => {
  const store = memoryStore({ seed: { "1-projects/foo.md": "# Foo" } });
  const page = { kind: "idCopy", workspaceId: WS, source, items: [item("1-projects/foo.md", "notes/n1.md", store)], limits };
  const request = new Request(`https://gateway.example${MOVER_PAGE_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRET}` },
    body: JSON.stringify({ ticket: "t1" }),
  });
  const { buildStore } = buildWith(store);
  const body = await (await handleMoverPage(request, env, { controlPlane: { openMoverPage: async () => page }, buildStore })).json();
  assert.equal(body.ok, true);
  assert.equal(body.results[0].ok, true);
  assert.ok(store.objects.has("notes/n1.md"));
});

test("the mover refuses a key outside notes/ or files/, or another workspace's bucket, before any store exists", async () => {
  const cases = [
    { items: [{ path: "a.md", key: "index.md", etag: "e", size: 1 }] },
    { items: [{ path: "a.md", key: "notes/../index.md", etag: "e", size: 1 }] },
    { items: [{ path: "a.md", key: "tenants/x/notes/a.md", etag: "e", size: 1 }] },
    { items: [{ path: "", key: "notes/a.md", etag: "e", size: 1 }] },
    { items: [{ path: "a.md", key: "notes/a.md", etag: "e", size: 1 }], workspaceId: "ws-2" },
    { items: Array.from({ length: 501 }, (_, i) => ({ path: `p${i}.md`, key: `notes/${i}.md`, etag: "e", size: 1 })) },
  ];
  for (const overrides of cases) {
    const store = memoryStore({ seed: { "a.md": "a" } });
    const { buildStore, built } = buildWith(store);
    const page = { kind: "idCopy", workspaceId: WS, source, limits, ...overrides };
    const request = new Request(`https://gateway.example${MOVER_PAGE_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ ticket: "t1" }),
    });
    const body = await (await handleMoverPage(request, env, { controlPlane: { openMoverPage: async () => page }, buildStore })).json();
    assert.deepEqual(body, { ok: false, error: "ID_COPY_FAILED" });
    assert.deepEqual(built, []);
    assert.equal(store.objects.size, 1);
  }
});

test("an id-layout copy is plumbing; a folder a person named notes/ is not", async () => {
  const { isIdKey, isPlumbing } = await import("../src/privacy/engine.js");
  const id = "0192f1a2-3b4c-7d5e-8f60-0123456789ab";
  assert.equal(isIdKey(`notes/${id}.md`), true);
  assert.equal(isIdKey(`files/${id}.png`), true);
  assert.equal(isPlumbing(`notes/${id}.md`), true);
  assert.equal(isPlumbing(`files/${id}`), true);
  assert.equal(isPlumbing("notes/meeting.md"), false);
  assert.equal(isPlumbing(`notes/sub/${id}.md`), false);
  assert.equal(isPlumbing(`1-projects/${id}.md`), false);
});
