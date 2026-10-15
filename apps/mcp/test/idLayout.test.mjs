/**
 * The id layer (`store/idLayout.js`, step 2 of `docs/decisions/storage-and-credentials/notes-by-id.md`).
 *
 * While staff have switched the layout to "ids", a read takes a note's body
 * from its id copy when the control plane says that copy is fresh, and every
 * write lands on both keys, so switching back loses nothing.
 *
 * Sabotage, each confirmed to fail a case here:
 *  - drop the etag override on a read from the id copy: the fresh-copy case fails;
 *  - look the id copy up on a plumbing path: the plumbing case fails;
 *  - write the key before the path: the ordering case fails;
 *  - let a failed path put touch the key: the failed-put case fails;
 *  - drop the `idLayout` check in sessionStore: the absent-layout case fails.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { withIdLayout } from "../src/store/idLayout.js";
import { storeForSession } from "../src/sessionStore.js";
import { createControlPlane } from "../src/controlPlane/index.js";
import { ControlPlaneError } from "../src/controlPlane/client.js";

/* ------------------------------ fixtures ------------------------------- */

/** A bucket in the shape the stores present: get/head/put/delete/list, with failure switches. */
function bucket() {
  const log = [];
  const objects = new Map();
  const failPut = new Set();
  const failGet = new Set();
  let counter = 0;
  const store = {
    log,
    objects,
    failPut,
    failGet,
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: false },
    async get(key) {
      log.push(["get", key]);
      if (failGet.has(key)) throw new Error("get failed");
      const value = objects.get(key);
      return value ? fileOf(value) : null;
    },
    async head(key) {
      log.push(["head", key]);
      if (failGet.has(key)) throw new Error("head failed");
      const value = objects.get(key);
      if (!value) return null;
      return { etag: value.etag, size: value.body.length, contentType: value.contentType };
    },
    async put(key, body, options = {}) {
      log.push(["put", key, options]);
      if (failPut.has(key)) throw new Error("put failed");
      const existing = objects.get(key);
      if (options.onlyIf?.absent === true && existing) return null;
      if (options.onlyIf?.etagMatches !== undefined && existing?.etag !== options.onlyIf.etagMatches) return null;
      const etag = `e${++counter}`;
      objects.set(key, {
        body: await textOf(body),
        etag,
        contentType: options.httpMetadata?.contentType ?? options.contentType,
      });
      return { etag };
    },
    async delete(key) {
      log.push(["delete", key]);
      objects.delete(key);
    },
    async list() {
      log.push(["list"]);
      return { objects: [], truncated: false };
    },
  };
  return store;
}

function fileOf(value) {
  const bytes = new TextEncoder().encode(value.body);
  return {
    etag: value.etag,
    size: bytes.byteLength,
    contentType: value.contentType,
    httpMetadata: { contentType: value.contentType },
    text: async () => value.body,
    arrayBuffer: async () => bytes.buffer.slice(0),
  };
}

async function textOf(body) {
  if (typeof body === "string") return body;
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
  if (ArrayBuffer.isView(body)) return new TextDecoder().decode(body);
  return await new Response(body).text();
}

/** A `lookup` that answers from a table, recording what it was asked. */
function lookupTo(copies, asked = []) {
  return async (paths) => {
    asked.push(paths);
    return { copies: Object.fromEntries(paths.filter((path) => copies[path]).map((path) => [path, copies[path]])) };
  };
}

const NOWRITE = async () => {
  throw new Error("wrote should not be called");
};

/** A bucket where note `1-projects/a.md` has a path copy "PATH BODY" and an id copy "ID BODY". */
async function withBothCopies() {
  const store = bucket();
  await store.put("notes/id1.md", "ID BODY", { contentType: "text/markdown; charset=utf-8" });
  await store.put("1-projects/a.md", "PATH BODY", { contentType: "text/markdown; charset=utf-8" });
  store.log.length = 0;
  return store;
}

const FRESH = { key: "notes/id1.md", etag: "e2", fresh: true };

/* -------------------------------- reads -------------------------------- */

test("a fresh copy is read from the id key, under the path's etag", async () => {
  const store = await withBothCopies();
  const wrapped = withIdLayout(store, { lookup: lookupTo({ "1-projects/a.md": FRESH }), wrote: NOWRITE });
  const object = await wrapped.get("1-projects/a.md");
  assert.equal(await object.text(), "ID BODY");
  assert.equal(object.etag, "e2");
  assert.equal(new TextDecoder().decode(await object.arrayBuffer()), "ID BODY");
});

test("a stale copy or a path with no row is read from the path", async () => {
  const store = await withBothCopies();
  const stale = withIdLayout(store, {
    lookup: lookupTo({ "1-projects/a.md": { key: "notes/id1.md", etag: "e2", fresh: false } }),
    wrote: NOWRITE,
  });
  assert.equal(await (await stale.get("1-projects/a.md")).text(), "PATH BODY");
  const noRow = withIdLayout(store, { lookup: lookupTo({}), wrote: NOWRITE });
  const object = await noRow.get("1-projects/a.md");
  assert.equal(await object.text(), "PATH BODY");
  assert.equal(object.etag, "e2");
});

test("a fresh copy whose id object is missing falls back to the path", async () => {
  const store = await withBothCopies();
  const wrapped = withIdLayout(store, {
    lookup: lookupTo({ "1-projects/a.md": { key: "notes/gone.md", etag: "e2", fresh: true } }),
    wrote: NOWRITE,
  });
  assert.equal(await (await wrapped.get("1-projects/a.md")).text(), "PATH BODY");
});

test("a lookup that throws reads the path and never rejects", async () => {
  const store = await withBothCopies();
  const wrapped = withIdLayout(store, {
    lookup: async () => {
      throw new ControlPlaneError("status 503", 503);
    },
    wrote: NOWRITE,
  });
  assert.equal(await (await wrapped.get("1-projects/a.md")).text(), "PATH BODY");
});

test("an id copy that throws on read falls back to the path", async () => {
  const store = await withBothCopies();
  store.failGet.add("notes/id1.md");
  const wrapped = withIdLayout(store, { lookup: lookupTo({ "1-projects/a.md": FRESH }), wrote: NOWRITE });
  assert.equal(await (await wrapped.get("1-projects/a.md")).text(), "PATH BODY");
});

test("a read with a conditional or range option passes through without a lookup", async () => {
  const store = await withBothCopies();
  const asked = [];
  const wrapped = withIdLayout(store, { lookup: lookupTo({ "1-projects/a.md": FRESH }, asked), wrote: NOWRITE });
  for (const options of [
    { range: { offset: 0, length: 4 } },
    { ifMatch: "e2" },
    { ifNoneMatch: "e2" },
    { onlyIf: { etagMatches: "e2" } },
  ]) {
    assert.equal(await (await wrapped.get("1-projects/a.md", options)).text(), "PATH BODY");
  }
  assert.deepEqual(asked, []);
});

test("plumbing is never looked up", async () => {
  const store = await withBothCopies();
  const asked = [];
  const wrapped = withIdLayout(store, { lookup: lookupTo({}, asked), wrote: NOWRITE });
  for (const path of [".context/collaboration/x.json", "1-projects/.hidden/a.md", "privacy.md"]) {
    await wrapped.get(path);
    await wrapped.head(path);
  }
  assert.deepEqual(asked, []);
});

test("head reads the id copy's metadata under the path's etag, or the path's when stale", async () => {
  const store = await withBothCopies();
  const fresh = withIdLayout(store, { lookup: lookupTo({ "1-projects/a.md": FRESH }), wrote: NOWRITE });
  const head = await fresh.head("1-projects/a.md");
  assert.equal(head.etag, "e2");
  assert.equal(head.size, "ID BODY".length);
  const stale = withIdLayout(store, {
    lookup: lookupTo({ "1-projects/a.md": { key: "notes/id1.md", etag: "e2", fresh: false } }),
    wrote: NOWRITE,
  });
  assert.equal((await stale.head("1-projects/a.md")).size, "PATH BODY".length);
});

/* -------------------------------- writes -------------------------------- */

test("a put writes the path, then the id key, then records the path's new etag", async () => {
  const store = bucket();
  await store.put("1-projects/a.md", "OLD");
  store.log.length = 0;
  const events = [];
  const asked = [];
  const wrapped = withIdLayout(store, {
    lookup: lookupTo({ "1-projects/a.md": { key: "notes/id1.md", etag: null, fresh: false } }, asked),
    wrote: async (copy) => {
      events.push(["wrote", copy]);
      return { recorded: true };
    },
  });
  const result = await wrapped.put("1-projects/a.md", "NEW", {
    contentType: "text/markdown; charset=utf-8",
    httpMetadata: { contentType: "text/markdown; charset=utf-8" },
    onlyIf: { etagMatches: "e1" },
  });
  assert.deepEqual(result, { etag: "e2" });
  const puts = store.log.filter((entry) => entry[0] === "put").map((entry) => entry[1]);
  assert.deepEqual(puts, ["1-projects/a.md", "notes/id1.md"]);
  assert.deepEqual(events, [["wrote", { path: "1-projects/a.md", key: "notes/id1.md", etag: "e2" }]]);
  assert.deepEqual(asked, [["1-projects/a.md"]]);
  assert.equal(store.objects.get("notes/id1.md").body, "NEW");
});

test("the id key is written unconditionally, with the same content type and metadata", async () => {
  const store = bucket();
  await store.put("1-projects/a.md", "OLD");
  store.log.length = 0;
  const wrapped = withIdLayout(store, {
    lookup: lookupTo({ "1-projects/a.md": { key: "notes/id1.md", etag: null, fresh: true } }),
    wrote: async () => ({ recorded: true }),
  });
  await wrapped.put("1-projects/a.md", "NEW", {
    contentType: "text/markdown; charset=utf-8",
    httpMetadata: { contentType: "text/markdown; charset=utf-8", cacheControl: "no-store" },
    onlyIf: { etagMatches: "e1" },
  });
  const keyPut = store.log.find((entry) => entry[0] === "put" && entry[1] === "notes/id1.md");
  assert.equal(keyPut[2].onlyIf, undefined);
  assert.equal(keyPut[2].contentType, "text/markdown; charset=utf-8");
  assert.deepEqual(keyPut[2].httpMetadata, { contentType: "text/markdown; charset=utf-8", cacheControl: "no-store" });
  assert.equal(store.objects.get("notes/id1.md").contentType, "text/markdown; charset=utf-8");
});

test("a failed path put returns null and never touches the id key", async () => {
  const store = bucket();
  await store.put("1-projects/a.md", "OLD");
  store.log.length = 0;
  let wroteCalled = false;
  const wrapped = withIdLayout(store, {
    lookup: lookupTo({ "1-projects/a.md": { key: "notes/id1.md", etag: null, fresh: true } }),
    wrote: async () => {
      wroteCalled = true;
    },
  });
  assert.equal(await wrapped.put("1-projects/a.md", "NEW", { onlyIf: { etagMatches: "stale" } }), null);
  assert.equal(store.objects.has("notes/id1.md"), false);
  assert.equal(wroteCalled, false);
});

test("a path put that throws rejects and never touches the id key", async () => {
  const store = bucket();
  store.failPut.add("1-projects/a.md");
  const wrapped = withIdLayout(store, { lookup: lookupTo({ "1-projects/a.md": FRESH }), wrote: NOWRITE });
  await assert.rejects(wrapped.put("1-projects/a.md", "NEW"), /put failed/);
  assert.equal(store.objects.has("notes/id1.md"), false);
});

test("a failing id-key put still returns the path's result", async () => {
  const store = bucket();
  store.failPut.add("notes/id1.md");
  const wrapped = withIdLayout(store, {
    lookup: lookupTo({ "1-projects/a.md": { key: "notes/id1.md", etag: null, fresh: true } }),
    wrote: NOWRITE,
  });
  assert.deepEqual(await wrapped.put("1-projects/a.md", "NEW"), { etag: "e1" });
  assert.equal(store.objects.get("1-projects/a.md").body, "NEW");
});

test("a failing wrote, or a failing lookup, still returns the path's result", async () => {
  const store = bucket();
  const failingWrote = withIdLayout(store, {
    lookup: lookupTo({ "1-projects/a.md": { key: "notes/id1.md", etag: null, fresh: true } }),
    wrote: async () => {
      throw new ControlPlaneError("status 500", 500);
    },
  });
  assert.deepEqual(await failingWrote.put("1-projects/a.md", "A"), { etag: "e1" });
  assert.equal(store.objects.get("notes/id1.md").body, "A");

  const failingLookup = withIdLayout(store, {
    lookup: async () => {
      throw new Error("down");
    },
    wrote: NOWRITE,
  });
  // e1 the first path write, e2 the id copy of it, e3 this path write.
  assert.deepEqual(await failingLookup.put("1-projects/a.md", "B"), { etag: "e3" });
  assert.equal(store.objects.get("1-projects/a.md").body, "B");
  assert.equal(store.objects.get("notes/id1.md").body, "A");
});

test("a stream body is written to the path only, with no lookup", async () => {
  const store = bucket();
  const asked = [];
  const wrapped = withIdLayout(store, { lookup: lookupTo({ "1-projects/a.md": FRESH }, asked), wrote: NOWRITE });
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("STREAMED"));
      controller.close();
    },
  });
  assert.deepEqual(await wrapped.put("1-projects/a.md", stream), { etag: "e1" });
  assert.deepEqual(asked, []);
  assert.equal(store.objects.has("notes/id1.md"), false);
});

test("string, ArrayBuffer, typed array and Blob bodies are all mirrored", async () => {
  const bodies = {
    string: "S",
    arrayBuffer: new TextEncoder().encode("B").buffer,
    typedArray: new TextEncoder().encode("T"),
    blob: new Blob(["L"]),
  };
  for (const [kind, body] of Object.entries(bodies)) {
    const store = bucket();
    const wrapped = withIdLayout(store, {
      lookup: lookupTo({ "1-projects/a.md": { key: "notes/id1.md", etag: null, fresh: true } }),
      wrote: async () => ({ recorded: true }),
    });
    await wrapped.put("1-projects/a.md", body);
    assert.ok(store.objects.has("notes/id1.md"), `${kind} mirrored`);
  }
});

test("a plumbing put is never looked up and never mirrored", async () => {
  const store = bucket();
  const asked = [];
  const wrapped = withIdLayout(store, { lookup: lookupTo({}, asked), wrote: NOWRITE });
  await wrapped.put(".context/collaboration/x.json", "{}");
  await wrapped.put("privacy.md", "# Privacy");
  assert.deepEqual(asked, []);
  assert.deepEqual(
    store.log.filter((entry) => entry[0] === "put").map((entry) => entry[1]),
    [".context/collaboration/x.json", "privacy.md"],
  );
});

/* ------------------------- everything else, and shape ------------------ */

test("list and delete pass through with no lookup", async () => {
  const store = await withBothCopies();
  const asked = [];
  const wrapped = withIdLayout(store, { lookup: lookupTo({ "1-projects/a.md": FRESH }, asked), wrote: NOWRITE });
  await wrapped.list({ prefix: "" });
  await wrapped.delete("1-projects/a.md");
  assert.deepEqual(asked, []);
  assert.deepEqual(store.log.map((entry) => entry[0]), ["list", "delete"]);
});

test("the wrapper keeps the store's non-enumerable properties and enumerable ones", async () => {
  const store = bucket();
  store.provider = "r2-binding";
  Object.defineProperty(store, "encryptionKey", { value: { current: "k", keys: { k: "secret" } }, enumerable: false });
  const wrapped = withIdLayout(store, { lookup: lookupTo({}), wrote: NOWRITE });
  assert.deepEqual(wrapped.encryptionKey, { current: "k", keys: { k: "secret" } });
  assert.equal(wrapped.provider, "r2-binding");
  assert.ok(!Object.keys(wrapped).includes("encryptionKey"));
});

test("without a lookup or a wrote the store is returned as it was", () => {
  const store = bucket();
  assert.equal(withIdLayout(store, {}), store);
});

/* ------------------------------- session ------------------------------- */

const BINDING = {
  status: "active",
  workspaceId: "w1",
  provider: "r2-binding",
  bindingName: "TEST_BUCKET",
  capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: false },
};

test("a session in the ids layout reads the id copy and mirrors its writes", async () => {
  const bucketFake = await withBothCopies();
  const asked = [];
  const wrote = [];
  const controlPlane = {
    getStorageBinding: async () => ({
      binding: BINDING,
      pendingMoves: [],
      idLayout: "ids",
      encryptionKey: { current: "k", keys: { k: "secret" } },
    }),
    noteIdLookup: async (token, workspaceId, paths) => {
      asked.push([token, workspaceId, paths]);
      return lookupTo({ "1-projects/a.md": FRESH })(paths);
    },
    noteIdWrote: async (token, workspaceId, copy) => {
      wrote.push([token, workspaceId, copy]);
      return { recorded: true };
    },
  };
  const session = { workspaceId: "w1", accessToken: "tok" };
  const built = await storeForSession(session, { NATIVE_BINDINGS: "TEST_BUCKET", TEST_BUCKET: bucketFake }, controlPlane);
  assert.equal(await (await built.get("1-projects/a.md")).text(), "ID BODY");
  assert.deepEqual(asked, [["tok", "w1", ["1-projects/a.md"]]]);
  await built.put("1-projects/a.md", "EDITED", { contentType: "text/markdown; charset=utf-8" });
  assert.equal(bucketFake.objects.get("notes/id1.md").body, "EDITED");
  assert.equal(wrote.length, 1);
  assert.equal(wrote[0][0], "tok");
  assert.equal(wrote[0][2].path, "1-projects/a.md");
  assert.equal(wrote[0][2].key, "notes/id1.md");
  // The wrapper carries the session's non-enumerable key across, as it carries the other properties.
  assert.deepEqual(built.encryptionKey, { current: "k", keys: { k: "secret" } });
  assert.ok(!Object.keys(built).includes("encryptionKey"));
});

test("a session with no idLayout has no id wrapper: reads and writes stay on paths", async () => {
  const bucketFake = await withBothCopies();
  const asked = [];
  const controlPlane = {
    getStorageBinding: async () => ({ binding: BINDING, pendingMoves: [], idLayout: null }),
    noteIdLookup: async (token, workspaceId, paths) => {
      asked.push(paths);
      return { copies: {} };
    },
    noteIdWrote: async () => {
      throw new Error("never");
    },
  };
  const session = { workspaceId: "w1", accessToken: "tok" };
  const built = await storeForSession(session, { NATIVE_BINDINGS: "TEST_BUCKET", TEST_BUCKET: bucketFake }, controlPlane);
  assert.equal(await (await built.get("1-projects/a.md")).text(), "PATH BODY");
  await built.put("1-projects/a.md", "EDITED", { contentType: "text/markdown; charset=utf-8" });
  assert.equal(bucketFake.objects.get("notes/id1.md").body, "ID BODY");
  assert.deepEqual(asked, []);
});

test("the ids layout without the client methods is not wrapped", async () => {
  const bucketFake = await withBothCopies();
  const controlPlane = {
    getStorageBinding: async () => ({ binding: BINDING, pendingMoves: [], idLayout: "ids" }),
  };
  const session = { workspaceId: "w1", accessToken: "tok" };
  const built = await storeForSession(session, { NATIVE_BINDINGS: "TEST_BUCKET", TEST_BUCKET: bucketFake }, controlPlane);
  assert.equal(await (await built.get("1-projects/a.md")).text(), "PATH BODY");
});

test("getStorageBinding reads idLayout off the response, and only \"ids\" counts", async () => {
  const respond = (body) => async () =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const env = { CONTROL_PLANE_URL: "https://cp.example", GATEWAY_SECRET: "secret" };
  const switched = createControlPlane(env, { fetchImpl: respond({ binding: BINDING, idLayout: "ids" }) });
  assert.equal((await switched.getStorageBinding("tok", "w1")).idLayout, "ids");
  const absent = createControlPlane(env, { fetchImpl: respond({ binding: BINDING }) });
  assert.equal((await absent.getStorageBinding("tok", "w1")).idLayout, null);
  const other = createControlPlane(env, { fetchImpl: respond({ binding: BINDING, idLayout: "paths" }) });
  assert.equal((await other.getStorageBinding("tok", "w1")).idLayout, null);
});

/* ------------------------------- client -------------------------------- */

function recorder(answer, status = 200) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(answer), { status, headers: { "content-type": "application/json" } });
  };
  return { calls, fetchImpl };
}

const ENV = { CONTROL_PLANE_URL: "https://cp.example/", GATEWAY_SECRET: "secret" };

test("noteIdLookup posts the paths with the same proofs as tree facts, and keeps only well-formed copies", async () => {
  const { calls, fetchImpl } = recorder({
    copies: {
      "a.md": { key: "notes/x.md", etag: "e1", fresh: true },
      "b.md": { key: "notes/y.md", etag: null, fresh: false },
      "c.md": { key: "", etag: "e3", fresh: true },
      "d.md": "not an entry",
    },
  });
  const cp = createControlPlane(ENV, { fetchImpl });
  const answer = await cp.noteIdLookup("tok", "w1", ["a.md", "b.md"]);
  assert.equal(calls[0].url, "https://cp.example/gateway/note-ids/lookup");
  assert.equal(calls[0].init.headers.Authorization, "Bearer secret");
  assert.deepEqual(calls[0].body, {
    workspaceId: "w1",
    paths: ["a.md", "b.md"],
    accessToken: "tok",
    expectedWorkspaceId: "w1",
  });
  assert.deepEqual(answer, {
    copies: {
      "a.md": { key: "notes/x.md", etag: "e1", fresh: true },
      "b.md": { key: "notes/y.md", etag: null, fresh: false },
    },
  });
});

test("noteIdLookup refuses a missing copies map and any refusal from the control plane", async () => {
  const cp = createControlPlane(ENV, { fetchImpl: recorder({}).fetchImpl });
  await assert.rejects(cp.noteIdLookup("tok", "w1", ["a.md"]), ControlPlaneError);
  const refused = createControlPlane(ENV, { fetchImpl: recorder({ error: "x" }, 403).fetchImpl });
  await assert.rejects(refused.noteIdLookup("tok", "w1", ["a.md"]), ControlPlaneError);
});

test("noteIdLookup refuses an empty or oversized path list before asking", async () => {
  const { calls, fetchImpl } = recorder({ copies: {} });
  const cp = createControlPlane(ENV, { fetchImpl });
  await assert.rejects(cp.noteIdLookup("tok", "w1", []), ControlPlaneError);
  await assert.rejects(
    cp.noteIdLookup("tok", "w1", Array.from({ length: 201 }, (_, i) => `${i}.md`)),
    ControlPlaneError,
  );
  assert.equal(calls.length, 0);
});

test("noteIdWrote posts the path, key and etag, and needs an ok", async () => {
  const { calls, fetchImpl } = recorder({ ok: true, recorded: true });
  const cp = createControlPlane(ENV, { fetchImpl });
  assert.deepEqual(await cp.noteIdWrote("tok", "w1", { path: "a.md", key: "notes/x.md", etag: "e1" }), {
    recorded: true,
  });
  assert.equal(calls[0].url, "https://cp.example/gateway/note-ids/wrote");
  assert.deepEqual(calls[0].body, {
    workspaceId: "w1",
    path: "a.md",
    key: "notes/x.md",
    etag: "e1",
    accessToken: "tok",
    expectedWorkspaceId: "w1",
  });
  const silent = createControlPlane(ENV, { fetchImpl: recorder({ recorded: true }).fetchImpl });
  await assert.rejects(silent.noteIdWrote("tok", "w1", { path: "a.md", key: "notes/x.md", etag: "e1" }), ControlPlaneError);
});
