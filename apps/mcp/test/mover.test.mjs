/**
 * The mover (`src/moves/mover.js`): one page of a whole-bucket move, copied
 * bucket to bucket here so no file passes through the control plane.
 *
 * Sabotage, each confirmed to fail a case here: drop the secret check (the
 * first two cases), stop checking that the spent ticket's source is its own
 * workspace's (the other-workspace case), stop filtering files over the limit
 * (the left-behind case), or answer a failure with the error's own message
 * (the redaction case).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { handleMoverPage, MOVER_PAGE_PATH } from "../src/moves/mover.js";

const SECRET = "gateway-secret-for-tests";
const env = { GATEWAY_SECRET: SECRET };
const MB = 1024 * 1024;

function memoryStore(name, seed = {}) {
  const objects = new Map(Object.entries(seed).map(([key, text]) => [key, { bytes: new TextEncoder().encode(text).buffer, contentType: "text/markdown; charset=utf-8" }]));
  const sizes = new Map();
  const reads = [];
  return {
    name,
    objects,
    reads,
    sizes,
    async list({ cursor, limit }) {
      const keys = [...objects.keys()].sort().filter((key) => cursor === undefined || key > cursor);
      const page = keys.slice(0, limit);
      return {
        objects: page.map((key) => ({ key, size: sizes.get(key) ?? objects.get(key).bytes.byteLength })),
        truncated: keys.length > limit,
        cursor: page.at(-1),
      };
    },
    async get(key) {
      reads.push(key);
      const found = objects.get(key);
      if (!found) return null;
      return { contentType: found.contentType, arrayBuffer: async () => found.bytes.slice(0) };
    },
    async put(key, value, options) {
      objects.set(key, { bytes: value.slice(0), contentType: options.contentType });
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}

function opened(overrides = {}) {
  return {
    workspaceId: "ws-1",
    phase: "copy",
    source: { workspaceId: "ws-1", provider: "r2", bucket: "source" },
    target: { provider: "r2", bucket: "target" },
    limits: { pageSize: 100, byteCap: 20 * MB, maxWidth: 16, byteBudget: 16 * MB },
    rules: {},
    ...overrides,
  };
}

function setup(page, stores) {
  const spent = [];
  const deps = {
    controlPlane: {
      async openMoverPage(ticket) {
        spent.push(ticket);
        return typeof page === "function" ? page() : page;
      },
    },
    buildStore: (binding) => (binding.bucket === "source" ? stores.source : stores.target),
  };
  return { spent, deps };
}

function request(body, secret = SECRET) {
  return new Request(`https://gateway.example${MOVER_PAGE_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(secret === null ? {} : { Authorization: `Bearer ${secret}` }) },
    body: JSON.stringify(body),
  });
}

test("without the gateway secret nothing is opened", async () => {
  const stores = { source: memoryStore("source", { "a.md": "a" }), target: memoryStore("target") };
  const { spent, deps } = setup(opened(), stores);
  for (const secret of [null, "wrong", `${SECRET}x`]) {
    const response = await handleMoverPage(request({ ticket: "t1" }, secret), env, deps);
    assert.equal(response.status, 401);
  }
  assert.deepEqual(spent, []);
  assert.equal(stores.target.objects.size, 0);
});

test("a deployment with no secret set refuses everyone, even an empty bearer", async () => {
  const stores = { source: memoryStore("source"), target: memoryStore("target") };
  const { spent, deps } = setup(opened(), stores);
  const response = await handleMoverPage(request({ ticket: "t1" }, ""), {}, deps);
  assert.equal(response.status, 401);
  assert.deepEqual(spent, []);
});

test("a body without a ticket is refused before anything is opened", async () => {
  const stores = { source: memoryStore("source"), target: memoryStore("target") };
  const { spent, deps } = setup(opened(), stores);
  assert.equal((await handleMoverPage(request({}), env, deps)).status, 400);
  assert.equal((await handleMoverPage(request({ ticket: "x".repeat(300) }), env, deps)).status, 400);
  assert.deepEqual(spent, []);
});

test("one page is copied bucket to bucket and counted", async () => {
  const stores = {
    source: memoryStore("source", { "1-projects/a.md": "# A", "1-projects/b.md": "# B", "index.md": "# Home" }),
    target: memoryStore("target"),
  };
  const { spent, deps } = setup(opened({ limits: { pageSize: 2, byteCap: 20 * MB, maxWidth: 16, byteBudget: 16 * MB } }), stores);
  const response = await handleMoverPage(request({ ticket: "t1" }), env, deps);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, { ok: true, copied: 2, changes: 2, processed: 2, nextCursor: "1-projects/b.md", skipped: [] });
  assert.deepEqual(spent, ["t1"]);
  assert.deepEqual([...stores.target.objects.keys()].sort(), ["1-projects/a.md", "1-projects/b.md"]);
  assert.equal(new TextDecoder().decode(stores.target.objects.get("1-projects/a.md").bytes), "# A");
  // The source is never written or deleted.
  assert.equal(stores.source.objects.size, 3);
});

test("the page starts where the spent ticket says, not where the body says", async () => {
  const stores = { source: memoryStore("source", { "a.md": "a", "b.md": "b" }), target: memoryStore("target") };
  const { deps } = setup(opened({ cursor: "a.md" }), stores);
  const body = await (await handleMoverPage(request({ ticket: "t1", cursor: undefined, workspaceId: "ws-2" }), env, deps)).json();
  assert.equal(body.processed, 1);
  assert.deepEqual([...stores.target.objects.keys()], ["b.md"]);
});

test("a file over the limit stays behind, named and never read", async () => {
  const stores = { source: memoryStore("source", { "a.md": "a", "meetings/call.m4a": "audio" }), target: memoryStore("target") };
  stores.source.sizes.set("meetings/call.m4a", 20 * MB + 1);
  const { deps } = setup(opened(), stores);
  const body = await (await handleMoverPage(request({ ticket: "t1" }), env, deps)).json();
  assert.deepEqual(body.skipped, ["meetings/call.m4a"]);
  assert.equal(body.processed, 2);
  assert.equal(body.copied, 1);
  assert.ok(!stores.source.reads.includes("meetings/call.m4a"));
  assert.ok(!stores.target.objects.has("meetings/call.m4a"));
});

test("the last pass lists the destination and leaves a big file there unnamed", async () => {
  const stores = { source: memoryStore("source", { "a.md": "a" }), target: memoryStore("target", { "a.md": "a", "own/movie.mp4": "m" }) };
  stores.target.sizes.set("own/movie.mp4", 30 * MB);
  const { deps } = setup(opened({ phase: "verify_target" }), stores);
  const body = await (await handleMoverPage(request({ ticket: "t1" }), env, deps)).json();
  assert.deepEqual(body, { ok: true, copied: 1, changes: 0, processed: 2, nextCursor: null, skipped: [] });
  assert.ok(stores.target.objects.has("own/movie.mp4"));
});

test("a destination file is deleted only when the spent ticket's rules allow it", async () => {
  const seed = () => ({ source: memoryStore("source", {}), target: memoryStore("target", { ".context/old.json": "{}", "mine.md": "x" }) });
  let stores = seed();
  let { deps } = setup(opened({ phase: "verify_target" }), stores);
  await handleMoverPage(request({ ticket: "t1", rules: { deleteUnmatchedTarget: true } }), env, deps);
  assert.equal(stores.target.objects.size, 2, "the body's rules are not the ticket's");

  stores = seed();
  ({ deps } = setup(opened({ phase: "verify_target", rules: { deleteUnmatchedTarget: true, deleteOnlyUnder: ".context/" } }), stores));
  await handleMoverPage(request({ ticket: "t1" }), env, deps);
  assert.deepEqual([...stores.target.objects.keys()], ["mine.md"]);
});

test("a spent, expired or stale ticket moves nothing", async () => {
  const stores = { source: memoryStore("source", { "a.md": "a" }), target: memoryStore("target") };
  const { deps } = setup(null, stores);
  const body = await (await handleMoverPage(request({ ticket: "t1" }), env, deps)).json();
  assert.deepEqual(body, { ok: false, error: "STALE" });
  assert.equal(stores.target.objects.size, 0);
});

test("an answer for another workspace's bucket is refused before a store exists", async () => {
  const stores = { source: memoryStore("source", { "a.md": "a" }), target: memoryStore("target") };
  let built = 0;
  const { deps } = setup(opened({ source: { workspaceId: "ws-2", provider: "r2", bucket: "source" } }), stores);
  deps.buildStore = () => {
    built += 1;
    return stores.source;
  };
  const body = await (await handleMoverPage(request({ ticket: "t1" }), env, deps)).json();
  assert.deepEqual(body, { ok: false, error: "COPY_FAILED" });
  assert.equal(built, 0);
});

test("a failure answers a fixed code and never the provider's words", async () => {
  const stores = { source: memoryStore("source", { "private/salary-review.md": "x" }), target: memoryStore("target") };
  stores.target.put = async (key) => {
    throw new Error(`PUT ${key} refused by provider`);
  };
  const { deps } = setup(opened(), stores);
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(JSON.stringify(args));
  try {
    const text = await (await handleMoverPage(request({ ticket: "t1" }), env, deps)).text();
    assert.deepEqual(JSON.parse(text), { ok: false, error: "COPY_FAILED" });
    assert.ok(!text.includes("salary"));
  } finally {
    console.error = original;
  }
  assert.ok(errors.every((line) => !line.includes("salary")));
});

test("a read-back that does not match is VERIFY_FAILED, so the control plane retries it", async () => {
  const stores = { source: memoryStore("source", { "a.md": "a" }), target: memoryStore("target") };
  const put = stores.target.put;
  stores.target.put = async (key, value, options) => put(key, new TextEncoder().encode("different").buffer, options);
  const { deps } = setup(opened(), stores);
  const original = console.error;
  console.error = () => {};
  try {
    const body = await (await handleMoverPage(request({ ticket: "t1" }), env, deps)).json();
    assert.deepEqual(body, { ok: false, error: "VERIFY_FAILED" });
  } finally {
    console.error = original;
  }
});

test("the control plane being unreachable is a retry, not a failed move", async () => {
  const stores = { source: memoryStore("source"), target: memoryStore("target") };
  const { deps } = setup(() => {
    throw new Error("control plane unavailable: timed out");
  }, stores);
  const body = await (await handleMoverPage(request({ ticket: "t1" }), env, deps)).json();
  assert.deepEqual(body, { ok: false, error: "SOURCE_UNAVAILABLE" });
});
