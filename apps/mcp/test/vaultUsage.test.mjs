import assert from "node:assert/strict";
import { test } from "node:test";
import { newEntryId, readMeta, writeEntry, writeMeta } from "../src/vault/entries.js";
import { toolVaultFetch } from "../src/tools/vault.js";
import { handleApprovals } from "../src/http/approvals.js";
import { keptPath, waitingAsks } from "../src/vault/usage.js";

/*
  What Settings › Vault says about a key's use (vault board 2): counts and the
  last address per AI, the AIs the person said no to, and the asks waiting.

  Sabotage record (each broken by hand, the named check failed, then restored):
   - noteUse writing with writeMeta instead of changeMeta → "a use racing Cut
     off never writes the AI back" fails.
   - keptPath keeping the query → "each AI's uses are counted" fails.
   - the yes not clearing the earlier no → "a No is remembered" fails.
*/

const KEY = "fake-vault-value-not-a-real-key-0077";
const KEYS = { current: "k1", keys: { k1: Buffer.from(new Uint8Array(32).fill(7)).toString("base64") } };

function memoryStore({ conditionalWrite = true } = {}) {
  const objects = new Map();
  const versions = new Map();
  let counter = 0;
  return {
    objects,
    capabilities: { conditionalWrite },
    async get(key) {
      return objects.has(key) ? { text: async () => objects.get(key), etag: versions.get(key) } : null;
    },
    async put(key, value, options = {}) {
      const expected = options.onlyIf?.etagMatches;
      if (conditionalWrite && expected !== undefined && versions.get(key) !== expected) return null;
      objects.set(key, String(value));
      versions.set(key, `"v${++counter}"`);
      return { etag: versions.get(key) };
    },
    async delete(key) {
      const had = objects.has(key);
      objects.delete(key);
      return had ? {} : null;
    },
    async list({ prefix }) {
      return { objects: [...objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false };
    },
  };
}

async function world({ ask = true, people = ["user_a"], conditionalWrite = true } = {}) {
  const store = memoryStore({ conditionalWrite });
  const id = newEntryId();
  await writeEntry(store, KEYS, "ws_1", {
    id,
    meta: {
      type: "secret",
      name: "Stripe",
      sites: [],
      people,
      fields: [{ name: "K", perEnv: false, set: ["_"] }],
      proxy: { host: "api.example.com", style: "bearer", ask },
      createdBy: "user_a",
      createdAt: 1,
      updatedAt: 1,
    },
    secret: { fields: [{ name: "K", perEnv: false, values: { _: KEY } }] },
  });
  Object.defineProperty(store, "encryptionKey", { value: KEYS, enumerable: false });
  const calls = [];
  Object.defineProperty(store, "vaultProxy", {
    value: { fetch: async (url, init) => (calls.push({ url, init }), new Response("{}", { headers: { "content-type": "application/json" } })) },
    enumerable: false,
  });
  return { store, id, calls };
}

const AI = { workspaceId: "ws_1", userId: "user_a", clientId: "client_claude", client: "Claude Code", workspaceKind: "shared" };
const OTHER_AI = { ...AI, clientId: "client_other", client: "Other AI" };
const use = (id) => ({ entry: id, field: "K", url: "https://api.example.com/v1/items" });

async function asAI(store, actor, request) {
  store.actor = actor;
  return toolVaultFetch(store, request);
}

async function app(store, method, body, { userId = "user_a", clientId = "context_console" } = {}) {
  const session = { actorClientId: clientId, actorUserId: userId, workspaceId: "ws_1", workspaceKind: "shared", scope: "private", workspaces: [] };
  const response = await handleApprovals(
    new Request("https://gateway.example/approvals", { method, ...(body ? { body: JSON.stringify(body) } : {}) }),
    store,
    session,
  );
  return { status: response.status, body: await response.json() };
}


const yes = async (store) => {
  const [waiting] = (await app(store, "GET")).body.approvals;
  return app(store, "POST", { id: waiting.id, action: "approve_always" });
};

test("each AI's uses are counted with the last address, never its query", async () => {
  const { store, id } = await world();
  await asAI(store, AI, use(id));
  await yes(store);
  await asAI(store, AI, use(id));
  await asAI(store, AI, { ...use(id), url: "https://api.example.com/v1/customers?email=someone%40example.com", method: "post" });
  const meta = await readMeta(store, KEYS, "ws_1", id);
  assert.deepEqual(
    meta.proxy.uses.map(({ id: who, name, count, method, path }) => ({ who, name, count, method, path })),
    [{ who: "client_claude", name: "Claude Code", count: 2, method: "POST", path: "/v1/customers" }],
  );
  assert.equal(JSON.stringify(meta).includes("someone"), false);
  assert.equal(keptPath("/a/b?x=1#y"), "/a/b");
});

test("a No is remembered with the AI's name, and a later yes clears it", async () => {
  const { store, id } = await world();
  await asAI(store, AI, use(id));
  const [waiting] = (await app(store, "GET")).body.approvals;
  await app(store, "POST", { id: waiting.id, action: "deny" });
  let meta = await readMeta(store, KEYS, "ws_1", id);
  assert.deepEqual(meta.proxy.refused.map(({ id: who, name }) => ({ who, name })), [{ who: "client_claude", name: "Claude Code" }]);
  await asAI(store, AI, use(id));
  await yes(store);
  meta = await readMeta(store, KEYS, "ws_1", id);
  assert.deepEqual(meta.proxy.refused, []);
  assert.deepEqual(meta.proxy.clients.map((client) => client.id), ["client_claude"]);
});

test("asks waiting are counted once per AI per key, for the person asked, while they last", async () => {
  const { store, id } = await world({ people: ["user_a", "user_b"] });
  await asAI(store, AI, use(id));
  await asAI(store, AI, use(id));
  await asAI(store, OTHER_AI, use(id));
  assert.equal((await waitingAsks(store, "user_a")).get(id), 2);
  assert.equal((await waitingAsks(store, "user_b")).size, 0);
  assert.equal((await waitingAsks(store, "user_a", Date.now() + 11 * 60 * 1000)).size, 0, "no answer in 10 minutes is a no");
});

test("a use racing Cut off never writes the AI back", async () => {
  const { store, id } = await world();
  await asAI(store, AI, use(id));
  await yes(store);
  // Cut off lands between the use's read of the key and its write.
  const get = store.get.bind(store);
  let reads = 0;
  store.get = async (key) => {
    const found = await get(key);
    if (found === null) return null;
    // What was read is the key as it stood before Cut off.
    const text = await found.text();
    if (key.includes(id) && ++reads === 3) {
      const meta = await readMeta({ ...store, get }, KEYS, "ws_1", id);
      await writeMeta({ ...store, get }, KEYS, "ws_1", id, { ...meta, proxy: { ...meta.proxy, clients: [] } });
    }
    return { etag: found.etag, text: async () => text };
  };
  await asAI(store, AI, use(id));
  store.get = get;
  assert.ok(reads > 3, "the use read the key again after its write was refused");
  const meta = await readMeta(store, KEYS, "ws_1", id);
  assert.deepEqual(meta.proxy.clients, []);
  assert.equal(meta.proxy.uses.at(-1).count, 1, "and still counted the use");
});

test("storage without conditional writes uses the key and records no count", async () => {
  const { store, id, calls } = await world({ ask: false, conditionalWrite: false });
  assert.equal((await asAI(store, AI, use(id))).isError, undefined);
  assert.equal(calls.length, 1);
  assert.equal((await readMeta(store, KEYS, "ws_1", id)).proxy.uses, undefined);
});
