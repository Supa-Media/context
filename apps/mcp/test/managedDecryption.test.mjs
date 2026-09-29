/**
 * The way back: a managed workspace walked from sealed to plain, and a seal
 * whose read-back fails putting the original back instead of leaving a bad
 * copy behind.
 *
 * ## Sabotage record (temporary local edits, reverted; failures measured)
 *
 *   `decrypting` mode sealing its writes                                    1
 *   `decrypting` mode refusing a sealed object                              1
 *   `unsealObject` writing without `etagMatches`                            1
 *   `unsealObject` returning "unsealed" without comparing the read-back     1
 *   `sealObject` throwing VERIFY_FAILED without restoring the original      2
 *   the restore written unconditionally (over a newer save)                 1
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  ManagedCipher,
  ManagedEncryptionError,
  isManagedEnvelope,
  withManagedEncryption,
} from "../src/store/managedEncryption.js";
import { checkPlainObject, sealObject, unsealObject } from "../src/store/managedEncryptionWalk.js";
import { LOGICAL_DELETE_CONTENT_TYPE, MARKDOWN_CONTENT_TYPE } from "../src/store/index.js";

const KEY = Buffer.alloc(32, 7).toString("base64");
const WS = "ws_one";
const dataKey = { current: "k1", keys: { k1: KEY } };
const cipher = () => new ManagedCipher(WS, dataKey);
const wrap = (store, mode) => withManagedEncryption(store, { workspaceId: WS, mode, ...dataKey });

class MemoryStore {
  constructor() {
    this.objects = new Map();
    this.n = 0;
  }
  async get(key) {
    const hit = this.objects.get(key);
    if (!hit) return null;
    const bytes = hit.bytes;
    return {
      etag: hit.etag,
      contentType: hit.contentType,
      arrayBuffer: async () => bytes.slice().buffer,
      text: async () => new TextDecoder().decode(bytes),
    };
  }
  async put(key, value, options = {}) {
    const existing = this.objects.get(key);
    if (options.onlyIf?.etagMatches && existing?.etag !== options.onlyIf.etagMatches) return null;
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
    const etag = `e${++this.n}`;
    this.objects.set(key, { bytes, etag, contentType: options.contentType });
    return { etag };
  }
  bytes(key) {
    return this.objects.get(key)?.bytes ?? null;
  }
  text(key) {
    return new TextDecoder().decode(this.bytes(key));
  }
}

async function sealedStore(body = "# Plan\n") {
  const raw = new MemoryStore();
  await wrap(raw, "encrypted").put("plan.md", body, { contentType: MARKDOWN_CONTENT_TYPE });
  assert.ok(isManagedEnvelope(raw.bytes("plan.md")));
  return raw;
}

test("decrypting mode reads both kinds and writes plain", async () => {
  const raw = await sealedStore();
  await raw.put("plain.md", "already plain");
  const store = wrap(raw, "decrypting");
  assert.equal(await (await store.get("plan.md")).text(), "# Plan\n");
  assert.equal(await (await store.get("plain.md")).text(), "already plain");
  await store.put("new.md", "typed during the walk back", { contentType: MARKDOWN_CONTENT_TYPE });
  assert.equal(isManagedEnvelope(raw.bytes("new.md")), false);
  assert.equal(raw.text("new.md"), "typed during the walk back");
});

test("decrypting mode still refuses a sealed object that will not open", async () => {
  const raw = new MemoryStore();
  await withManagedEncryption(raw, { workspaceId: "ws_other", mode: "encrypted", ...dataKey }).put("x.md", "x");
  await assert.rejects(wrap(raw, "decrypting").get("x.md"), ManagedEncryptionError);
});

test("the walk back unseals in place, keeps the content type, and verifies", async () => {
  const raw = await sealedStore();
  assert.equal(await checkPlainObject(raw, "plan.md"), "sealed");
  assert.equal(await unsealObject(raw, cipher(), "plan.md"), "unsealed");
  assert.equal(raw.text("plan.md"), "# Plan\n");
  assert.equal(raw.objects.get("plan.md").contentType, MARKDOWN_CONTENT_TYPE);
  assert.equal(await unsealObject(raw, cipher(), "plan.md"), "already");
  assert.equal(await checkPlainObject(raw, "plan.md"), "ok");
});

test("the walk back never overwrites a save that landed after its read", async () => {
  const raw = await sealedStore("old");
  const realGet = raw.get.bind(raw);
  let raced = false;
  raw.get = async (key) => {
    const object = await realGet(key);
    if (!raced) {
      raced = true;
      await wrap(raw, "decrypting").put("plan.md", "typed just now");
    }
    return object;
  };
  assert.equal(await unsealObject(raw, cipher(), "plan.md"), "raced");
  assert.equal(raw.text("plan.md"), "typed just now");
});

test("the walk back stops on a sealed object its key cannot open, and leaves it", async () => {
  const raw = new MemoryStore();
  await withManagedEncryption(raw, { workspaceId: "ws_other", mode: "encrypted", ...dataKey }).put("x.md", "x");
  const before = raw.bytes("x.md");
  await assert.rejects(unsealObject(raw, cipher(), "x.md"), ManagedEncryptionError);
  assert.deepEqual(raw.bytes("x.md"), before);
});

test("the walk back leaves deletion markers as they are", async () => {
  const raw = new MemoryStore();
  await raw.put("gone.md", "", { contentType: LOGICAL_DELETE_CONTENT_TYPE });
  assert.equal(await unsealObject(raw, cipher(), "gone.md"), "already");
  assert.equal(await checkPlainObject(raw, "gone.md"), "ok");
});

/** A bucket that stores what it is given but returns other bytes once. */
function corruptingOnce(raw, key) {
  const realGet = raw.get.bind(raw);
  let reads = 0;
  raw.get = async (k) => {
    const object = await realGet(k);
    if (k !== key || object === null) return object;
    reads += 1;
    if (reads !== 2) return object;
    return { ...object, arrayBuffer: async () => new TextEncoder().encode("not what was written").buffer };
  };
}

test("a seal whose read-back does not match puts the original back", async () => {
  const raw = new MemoryStore();
  await raw.put("a.md", "the only copy", { contentType: MARKDOWN_CONTENT_TYPE });
  corruptingOnce(raw, "a.md");
  await assert.rejects(sealObject(raw, cipher(), "a.md"), (error) => error.code === "VERIFY_FAILED");
  assert.equal(raw.text("a.md"), "the only copy");
  assert.equal(raw.objects.get("a.md").contentType, MARKDOWN_CONTENT_TYPE);
});

test("an unseal whose read-back does not match puts the sealed copy back", async () => {
  const raw = await sealedStore("# Secret plan\n");
  const sealed = raw.bytes("plan.md");
  corruptingOnce(raw, "plan.md");
  await assert.rejects(unsealObject(raw, cipher(), "plan.md"), (error) => error.code === "VERIFY_FAILED");
  assert.deepEqual(raw.bytes("plan.md"), sealed);
  assert.equal(await (await wrap(raw, "encrypted").get("plan.md")).text(), "# Secret plan\n");
});

test("the restore never overwrites a save that landed after the bad write", async () => {
  const raw = new MemoryStore();
  await raw.put("a.md", "original");
  const realGet = raw.get.bind(raw);
  let reads = 0;
  raw.get = async (k) => {
    const object = await realGet(k);
    reads += 1;
    if (reads !== 2) return object;
    // Somebody saves between our write and our read-back, and the read-back
    // we see is garbage with our own etag.
    const ours = object.etag;
    await wrap(raw, "migrating").put("a.md", "typed just now");
    return { ...object, etag: ours, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
  };
  await assert.rejects(sealObject(raw, cipher(), "a.md"), (error) => error.code === "VERIFY_FAILED");
  raw.get = realGet;
  assert.equal(await (await wrap(raw, "migrating").get("a.md")).text(), "typed just now");
});
