import assert from "node:assert/strict";
import { test } from "node:test";
import { changeEntry, newEntryId, readMeta, readSecret, writeEntry, writeMeta } from "../src/vault/entries.js";

/*
  Editing a key in place (Settings › Vault): its meta and its secret change
  together, on condition of the version read, so an edit landing at the same
  moment as Cut off never writes the cut AI back.

  Sabotage record: changeEntry writing without `onlyIf` → "an edit racing Cut
  off keeps the cut" fails.
*/

const KEYS = { current: "k1", keys: { k1: Buffer.from(new Uint8Array(32).fill(9)).toString("base64") } };

function memoryStore({ conditionalWrite = true } = {}) {
  const objects = new Map();
  const versions = new Map();
  let counter = 0;
  const store = {
    capabilities: { conditionalWrite },
    beforePut: null,
    async get(key) {
      if (!objects.has(key)) return null;
      const text = objects.get(key);
      return { text: async () => text, etag: versions.get(key) };
    },
    async put(key, value, options = {}) {
      if (store.beforePut) {
        const hook = store.beforePut;
        store.beforePut = null;
        await hook();
      }
      const expected = options.onlyIf?.etagMatches;
      if (conditionalWrite && expected !== undefined && versions.get(key) !== expected) return null;
      objects.set(key, String(value));
      versions.set(key, `"v${++counter}"`);
      return { etag: versions.get(key) };
    },
  };
  return store;
}

async function world(options) {
  const store = memoryStore(options);
  const id = newEntryId();
  await writeEntry(store, KEYS, "ws_1", {
    id,
    meta: {
      type: "login",
      name: "Bank",
      sites: ["bank.example.test"],
      people: ["user_a"],
      fields: [],
      proxy: { host: "api.example.com", style: "bearer", ask: true, clients: [{ id: "c1", name: "Claude", at: 1 }] },
      createdBy: "user_a",
      createdAt: 1,
      updatedAt: 1,
    },
    secret: { username: "me@example.test", password: "fake-old-password", fields: [] },
  });
  return { store, id };
}

const newPassword = (meta, secret) => ({ meta: { ...meta, updatedAt: 2 }, secret: { ...secret, password: "fake-new-password" } });

test("an edit changes the secret and keeps the meta it read", async () => {
  const { store, id } = await world();
  const result = await changeEntry(store, KEYS, "ws_1", id, newPassword);
  assert.equal(result.written.secret.password, "fake-new-password");
  assert.equal((await readSecret(store, KEYS, "ws_1", id)).password, "fake-new-password");
  assert.equal((await readSecret(store, KEYS, "ws_1", id)).username, "me@example.test");
  assert.equal((await readMeta(store, KEYS, "ws_1", id)).updatedAt, 2);
});

test("an edit racing Cut off keeps the cut", async () => {
  const { store, id } = await world();
  store.beforePut = async () => {
    const meta = await readMeta(store, KEYS, "ws_1", id);
    await writeMeta(store, KEYS, "ws_1", id, { ...meta, proxy: { ...meta.proxy, clients: [] } });
  };
  const result = await changeEntry(store, KEYS, "ws_1", id, newPassword);
  assert.equal(result.written.secret.password, "fake-new-password");
  assert.deepEqual((await readMeta(store, KEYS, "ws_1", id)).proxy.clients, []);
  assert.equal((await readSecret(store, KEYS, "ws_1", id)).password, "fake-new-password");
});

test("no change writes nothing; storage without conditional writes writes once", async () => {
  const { store, id } = await world();
  assert.deepEqual(await changeEntry(store, KEYS, "ws_1", id, () => null), { written: null });
  const plain = await world({ conditionalWrite: false });
  const result = await changeEntry(plain.store, KEYS, "ws_1", plain.id, newPassword);
  assert.equal(result.written.secret.password, "fake-new-password");
  assert.equal((await readSecret(plain.store, KEYS, "ws_1", plain.id)).password, "fake-new-password");
});

test("a missing entry is a conflict, never a new entry", async () => {
  const { store } = await world();
  assert.deepEqual(await changeEntry(store, KEYS, "ws_1", newEntryId(), newPassword), { conflict: true });
});
