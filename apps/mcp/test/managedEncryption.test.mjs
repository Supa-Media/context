/**
 * Managed-storage encryption, as a store wrapper and through the factory.
 *
 * The dangerous directions, each a test: a wrong key, a missing key, another
 * workspace's bytes, a flipped bit, a truncated object, a plain object in an
 * encrypted workspace, and a descriptor that names a mode with no key behind
 * it. None may answer with bytes; each must throw.
 *
 * ## Sabotage record (temporary local edits, reverted; failures measured)
 *
 *   `open` returning the ciphertext when the content tag fails            1
 *   strict mode accepting a plain object                                   1
 *   workspace id dropped from both AADs                                    1
 *     (from the content AAD alone: 0, the wrapped key's AAD still binds it)
 *   `put` passing deletion markers through the cipher                      1
 *   factory skipping the wrapper                                           1
 *   `readManagedEncryption` treating a keyless descriptor as "off"         1
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  ManagedCipher,
  ManagedEncryptionError,
  isManagedEnvelope,
  managedEncryptionFor,
  withManagedEncryption,
} from "../src/store/managedEncryption.js";
import { LOGICAL_DELETE_CONTENT_TYPE } from "../src/store/index.js";
import { storeForBinding, StorageUnavailable } from "../src/store/factory.js";

const KEY_A = Buffer.alloc(32, 7).toString("base64");
const KEY_B = Buffer.alloc(32, 9).toString("base64");
const WS = "ws_one";

class MemoryStore {
  constructor() {
    this.objects = new Map();
    this.n = 0;
    this.capabilities = { conditionalWrite: true, conditionalCreate: true };
  }
  async get(key) {
    const hit = this.objects.get(key);
    if (!hit) return null;
    const bytes = hit.bytes;
    return {
      etag: hit.etag,
      contentType: hit.contentType,
      size: bytes.byteLength,
      text: async () => new TextDecoder().decode(bytes),
      arrayBuffer: async () => bytes.slice().buffer,
    };
  }
  async put(key, value, options = {}) {
    const existing = this.objects.get(key);
    if (options.onlyIf?.absent && existing) return null;
    if (options.onlyIf?.etagMatches && existing?.etag !== options.onlyIf.etagMatches) return null;
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
    const etag = `e${++this.n}`;
    this.objects.set(key, { bytes, etag, contentType: options.contentType });
    return { etag };
  }
  async delete(key) {
    this.objects.delete(key);
  }
  async list() {
    return { objects: [...this.objects.keys()].map((key) => ({ key, size: 0 })), truncated: false };
  }
}

const keys = (current = "k1", extra = {}) => ({ current, keys: { k1: KEY_A, ...extra } });
const wrap = (store, mode = "migrating", dataKey = keys(), workspaceId = WS) =>
  withManagedEncryption(store, { workspaceId, mode, ...dataKey });

test("a write lands sealed in the bucket and reads back plain", async () => {
  const raw = new MemoryStore();
  const store = wrap(raw);
  await store.put("1-projects/a.md", "# Secret plan\n", { contentType: "text/markdown" });
  const stored = raw.objects.get("1-projects/a.md").bytes;
  assert.ok(isManagedEnvelope(stored));
  assert.ok(!new TextDecoder().decode(stored).includes("Secret plan"));
  const read = await store.get("1-projects/a.md");
  assert.equal(await read.text(), "# Secret plan\n");
  assert.equal(read.size, "# Secret plan\n".length);
});

test("binary attachments round-trip byte for byte", async () => {
  const store = wrap(new MemoryStore());
  const bytes = crypto.getRandomValues(new Uint8Array(4096));
  await store.put("assets/x.png", bytes, { contentType: "image/png" });
  const read = new Uint8Array(await (await store.get("assets/x.png")).arrayBuffer());
  assert.deepEqual(read, bytes);
});

test("every object gets its own key: the same body seals differently", async () => {
  const cipher = new ManagedCipher(WS, keys());
  const plain = new TextEncoder().encode("same");
  const a = await cipher.seal(plain);
  const b = await cipher.seal(plain);
  assert.notDeepEqual(a, b);
});

test("conditional writes still guard: a stale etag is refused", async () => {
  const store = wrap(new MemoryStore());
  const first = await store.put("n.md", "one");
  assert.equal(await store.put("n.md", "two", { onlyIf: { etagMatches: "stale" } }), null);
  assert.ok(await store.put("n.md", "two", { onlyIf: { etagMatches: first.etag } }));
});

test("migrating accepts a plain object the walk has not reached", async () => {
  const raw = new MemoryStore();
  await raw.put("old.md", "plain body");
  assert.equal(await (await wrap(raw).get("old.md")).text(), "plain body");
});

test("encrypted mode refuses a plain object rather than serving it", async () => {
  const raw = new MemoryStore();
  await raw.put("planted.md", "attacker text");
  await assert.rejects(wrap(raw, "encrypted").get("planted.md"), (error) => {
    assert.ok(error instanceof ManagedEncryptionError);
    assert.equal(error.code, "ENCRYPTED_UNREADABLE");
    return true;
  });
});

test("deletion markers stay plain and readable in encrypted mode", async () => {
  const raw = new MemoryStore();
  const store = wrap(raw, "encrypted");
  await store.put("gone.md", "", { contentType: LOGICAL_DELETE_CONTENT_TYPE });
  assert.ok(!isManagedEnvelope(raw.objects.get("gone.md").bytes));
  assert.ok(await store.get("gone.md"));
});

test("a wrong key fails closed", async () => {
  const raw = new MemoryStore();
  await wrap(raw).put("n.md", "body");
  const wrong = wrap(raw, "encrypted", { current: "k1", keys: { k1: KEY_B } });
  await assert.rejects(wrong.get("n.md"), { code: "ENCRYPTED_UNREADABLE" });
});

test("a missing generation fails closed", async () => {
  const raw = new MemoryStore();
  await wrap(raw, "migrating", { current: "k2", keys: { k2: KEY_B } }).put("n.md", "body");
  await assert.rejects(wrap(raw).get("n.md"), { code: "KEY_UNAVAILABLE" });
});

test("another workspace's bytes never open here, even with the same key", async () => {
  const raw = new MemoryStore();
  await wrap(raw, "migrating", keys(), "ws_other").put("n.md", "theirs");
  await assert.rejects(wrap(raw).get("n.md"), { code: "ENCRYPTED_UNREADABLE" });
});

test("a flipped bit anywhere is a refusal, never garbage", async () => {
  const raw = new MemoryStore();
  await wrap(raw).put("n.md", "tamper me please");
  const original = raw.objects.get("n.md").bytes;
  for (const index of [8, 12, 30, 80, original.byteLength - 1]) {
    const bytes = original.slice();
    bytes[index] ^= 1;
    raw.objects.set("n.md", { bytes, etag: "t" });
    await assert.rejects(wrap(raw).get("n.md"), ManagedEncryptionError, `byte ${index}`);
  }
});

test("a truncated object is a refusal", async () => {
  const raw = new MemoryStore();
  await wrap(raw).put("n.md", "body");
  raw.objects.set("n.md", { bytes: raw.objects.get("n.md").bytes.slice(0, 40), etag: "t" });
  await assert.rejects(wrap(raw).get("n.md"), { code: "ENCRYPTED_UNREADABLE" });
});

test("older generations keep opening after a rotation", async () => {
  const raw = new MemoryStore();
  await wrap(raw).put("old.md", "written under k1");
  const rotated = wrap(raw, "encrypted", { current: "k2", keys: { k1: KEY_A, k2: KEY_B } });
  assert.equal(await (await rotated.get("old.md")).text(), "written under k1");
  await rotated.put("new.md", "written under k2");
  assert.equal(await (await rotated.get("new.md")).text(), "written under k2");
});

test("a byte copy to another path still opens (the path is not bound)", async () => {
  const raw = new MemoryStore();
  await wrap(raw).put("a.md", "moved");
  raw.objects.set("b.md", { ...raw.objects.get("a.md") });
  assert.equal(await (await wrap(raw).get("b.md")).text(), "moved");
});

test("managedEncryptionFor: absent is off, a mode without a key refuses", () => {
  const refuse = (why) => new StorageUnavailable(why);
  assert.equal(managedEncryptionFor({}, WS, refuse), null);
  assert.equal(managedEncryptionFor({ managedEncryption: null }, WS, refuse), null);
  assert.throws(
    () => managedEncryptionFor({ managedEncryption: { mode: "encrypted" }, encryptionKey: null }, WS, refuse),
    StorageUnavailable,
  );
  assert.throws(
    () => managedEncryptionFor({ managedEncryption: { mode: "sideways" }, encryptionKey: keys() }, WS, refuse),
    StorageUnavailable,
  );
  const config = managedEncryptionFor({ managedEncryption: { mode: "encrypted" }, encryptionKey: keys() }, WS, refuse);
  assert.deepEqual({ ...config, keys: undefined }, { mode: "encrypted", current: "k1", keys: undefined, workspaceId: WS });
});

test("the factory seals through the full stack, logical-delete view included", async () => {
  const backend = new Map();
  const fetchImpl = async (url, init = {}) => {
    const key = new URL(url).pathname;
    if (init.method === "PUT") {
      backend.set(key, new Uint8Array(init.body));
      return new Response(null, { status: 200, headers: { etag: `"${backend.size}"` } });
    }
    if (init.method === "GET") {
      const bytes = backend.get(key);
      if (!bytes) return new Response(null, { status: 404 });
      return new Response(bytes, { status: 200, headers: { etag: '"1"' } });
    }
    return new Response(null, { status: 404 });
  };
  const binding = {
    provider: "r2",
    endpoint: "https://example.invalid",
    bucket: "ctx-test",
    accessKeyId: "AKIAFAKE",
    secretAccessKey: "fake",
    forcePathStyle: true,
    capabilities: { conditionalWrite: true, conditionalCreate: true },
  };
  const store = storeForBinding(binding, {}, {
    fetchImpl,
    managedEncryption: { workspaceId: WS, mode: "encrypted", ...keys() },
  });
  await store.put("1-projects/plan.md", "the plan");
  const [stored] = [...backend.values()];
  assert.ok(isManagedEnvelope(stored), "bytes in the bucket are sealed");
  assert.equal(await (await store.get("1-projects/plan.md")).text(), "the plan");

  const plainStore = storeForBinding(binding, {}, { fetchImpl });
  await assert.doesNotReject(plainStore.get("1-projects/plan.md"));
  assert.ok(!(await (await plainStore.get("1-projects/plan.md")).text()).includes("the plan"));
});

import { checkObject, sealObject } from "../src/store/managedEncryptionWalk.js";

test("the walk seals a plain object in place and verifies it", async () => {
  const raw = new MemoryStore();
  await raw.put("a.md", "plain");
  const cipher = new ManagedCipher(WS, keys());
  assert.equal(await checkObject(raw, cipher, "a.md"), "plain");
  assert.equal(await sealObject(raw, cipher, "a.md"), "sealed");
  assert.equal(await sealObject(raw, cipher, "a.md"), "already");
  assert.equal(await checkObject(raw, cipher, "a.md"), "ok");
  assert.equal(await (await wrap(raw, "encrypted").get("a.md")).text(), "plain");
});

test("the walk never overwrites a save that landed after its read", async () => {
  const raw = new MemoryStore();
  await raw.put("a.md", "old");
  const cipher = new ManagedCipher(WS, keys());
  const realGet = raw.get.bind(raw);
  let raced = false;
  raw.get = async (key) => {
    const object = await realGet(key);
    if (!raced) {
      raced = true;
      await wrap(raw).put("a.md", "typed just now");
    }
    return object;
  };
  assert.equal(await sealObject(raw, cipher, "a.md"), "raced");
  raw.get = realGet;
  assert.equal(await (await wrap(raw).get("a.md")).text(), "typed just now");
});

test("the walk stops on an object its key cannot open", async () => {
  const raw = new MemoryStore();
  await wrap(raw, "migrating", keys(), "ws_other").put("a.md", "x");
  await assert.rejects(sealObject(raw, new ManagedCipher(WS, keys()), "a.md"), ManagedEncryptionError);
  await assert.rejects(checkObject(raw, new ManagedCipher(WS, keys()), "a.md"), ManagedEncryptionError);
});

test("the walk leaves deletion markers plain and passes them", async () => {
  const raw = new MemoryStore();
  await raw.put("gone.md", "", { contentType: LOGICAL_DELETE_CONTENT_TYPE });
  const cipher = new ManagedCipher(WS, keys());
  assert.equal(await sealObject(raw, cipher, "gone.md"), "skipped");
  assert.equal(await checkObject(raw, cipher, "gone.md"), "ok");
});
