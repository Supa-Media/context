/**
 * The mover's encryption-walk pages (`src/moves/walkPage.js` behind
 * `src/moves/mover.js`): one managed bucket sealed, or opened, in place here,
 * so no object passes through the control plane.
 *
 * Sabotage, each confirmed to fail a case here: drop the check that the
 * walk's bucket is its own workspace's (the other-workspace case), accept a
 * page without its data key (the no-key case), or answer a failure with the
 * error's own message (the redaction case).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { handleMoverPage, MOVER_PAGE_PATH } from "../src/moves/mover.js";
import { ManagedCipher, isManagedEnvelope } from "../src/store/managedEncryption.js";

const SECRET = "gateway-secret-for-tests";
const env = { GATEWAY_SECRET: SECRET };
const WS = "ws-1";
const dataKey = { current: "k1", keys: { k1: Buffer.alloc(32, 7).toString("base64") } };

class MemoryStore {
  constructor(seed = {}) {
    this.objects = new Map();
    this.n = 0;
    for (const [key, text] of Object.entries(seed)) this.objects.set(key, { bytes: new TextEncoder().encode(text), etag: `s${++this.n}`, contentType: "text/markdown; charset=utf-8" });
  }
  async get(key) {
    const hit = this.objects.get(key);
    if (!hit) return null;
    return { etag: hit.etag, contentType: hit.contentType, size: hit.bytes.byteLength, arrayBuffer: async () => hit.bytes.slice().buffer };
  }
  async put(key, value, options = {}) {
    const existing = this.objects.get(key);
    if (options.onlyIf?.etagMatches && existing?.etag !== options.onlyIf.etagMatches) return null;
    const etag = `e${++this.n}`;
    this.objects.set(key, { bytes: new Uint8Array(value), etag, contentType: options.contentType });
    return { etag };
  }
  async delete(key) {
    this.objects.delete(key);
  }
  async list({ cursor, limit }) {
    const keys = [...this.objects.keys()].sort().filter((key) => cursor === undefined || key > cursor);
    const page = keys.slice(0, limit);
    return { objects: page.map((key) => ({ key, size: this.objects.get(key).bytes.byteLength })), truncated: keys.length > limit, cursor: page.at(-1) };
  }
}

function walkPage(overrides = {}) {
  return {
    kind: "walk",
    workspaceId: WS,
    phase: "seal",
    cursor: null,
    source: { workspaceId: WS, provider: "r2", bucket: "managed" },
    dataKey,
    limits: { pageSize: 100, lanes: 6, byteBudget: 16 * 1024 * 1024 },
    ...overrides,
  };
}

function deps(page, store) {
  const built = [];
  return {
    built,
    controlPlane: { openMoverPage: async () => page },
    buildStore: (binding, _workspace, options) => {
      built.push({ bucket: binding.bucket, options });
      return store;
    },
  };
}

function request() {
  return new Request(`https://gateway.example${MOVER_PAGE_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRET}` },
    body: JSON.stringify({ ticket: "t1" }),
  });
}

test("a seal page seals every listed object in place, through the bare adapter", async () => {
  const store = new MemoryStore({ "index.md": "# Home", "1-projects/plan.md": "The words people typed." });
  const d = deps(walkPage(), store);
  const response = await handleMoverPage(request(), env, d);
  assert.deepEqual(await response.json(), { ok: true, phase: "seal", nextCursor: null, done: 2 });
  assert.deepEqual(d.built, [{ bucket: "managed", options: { sealedObjects: true } }]);
  const cipher = new ManagedCipher(WS, dataKey);
  for (const [key, text] of [["index.md", "# Home"], ["1-projects/plan.md", "The words people typed."]]) {
    const sealed = store.objects.get(key).bytes;
    assert.equal(isManagedEnvelope(sealed), true);
    assert.equal(new TextDecoder().decode(await cipher.open(sealed)), text);
  }
});

test("a page stops at its size and names where the next one starts", async () => {
  const store = new MemoryStore({ "a.md": "a", "b.md": "b", "c.md": "c" });
  const response = await handleMoverPage(request(), env, deps(walkPage({ limits: { pageSize: 2, lanes: 6, byteBudget: 1024 } }), store));
  assert.deepEqual(await response.json(), { ok: true, phase: "seal", nextCursor: "b.md", done: 2 });
  assert.equal(isManagedEnvelope(store.objects.get("c.md").bytes), false);
});

test("unseal then confirm opens a sealed bucket back to plain", async () => {
  const store = new MemoryStore({ "index.md": "# Home" });
  await handleMoverPage(request(), env, deps(walkPage(), store));
  const unsealed = await handleMoverPage(request(), env, deps(walkPage({ phase: "unseal" }), store));
  assert.deepEqual(await unsealed.json(), { ok: true, phase: "unseal", nextCursor: null, done: 1 });
  const confirmed = await handleMoverPage(request(), env, deps(walkPage({ phase: "confirm" }), store));
  assert.deepEqual(await confirmed.json(), { ok: true, phase: "confirm", nextCursor: null, done: 0 });
  assert.equal(new TextDecoder().decode(store.objects.get("index.md").bytes), "# Home");
});

test("a page whose bucket is another workspace's, or that carries no key, opens nothing", async () => {
  for (const page of [
    walkPage({ source: { workspaceId: "ws-2", provider: "r2", bucket: "managed" } }),
    walkPage({ dataKey: undefined }),
    walkPage({ dataKey: { current: "k2", keys: dataKey.keys } }),
    walkPage({ phase: "count" }),
  ]) {
    const store = new MemoryStore({ "index.md": "# Home" });
    const d = deps(page, store);
    const response = await handleMoverPage(request(), env, d);
    assert.deepEqual(await response.json(), { ok: false, error: "WALK_FAILED" });
    assert.deepEqual(d.built, []);
    assert.equal(isManagedEnvelope(store.objects.get("index.md").bytes), false);
  }
});

test("a failure answers the walk's own code, and never the error's text", async () => {
  const store = new MemoryStore({ "1-projects/secret-plan.md": "x" });
  store.put = async () => {
    throw new Error("PUT 1-projects/secret-plan.md refused by provider");
  };
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(JSON.stringify(args));
  try {
    const response = await handleMoverPage(request(), env, deps(walkPage(), store));
    const body = await response.json();
    assert.deepEqual(body, { ok: false, error: "WALK_FAILED" });
  } finally {
    console.error = original;
  }
  assert.equal(logged.join("").includes("secret-plan"), false);

  // A sealed object that will not open with this key is the walk's own code.
  const other = new MemoryStore({ "index.md": "# Home" });
  await handleMoverPage(request(), env, deps(walkPage({ dataKey: { current: "k9", keys: { k9: Buffer.alloc(32, 9).toString("base64") } } }), other));
  const response = await handleMoverPage(request(), env, deps(walkPage({ phase: "check" }), other));
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /^[A-Z_]{3,40}$/);
  assert.notEqual(body.error, "WALK_FAILED");
});
