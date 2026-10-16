import assert from "node:assert/strict";
import { test } from "node:test";
import { newEntryId, readMeta, writeEntry } from "../src/vault/entries.js";
import { toolVaultFetch } from "../src/tools/vault.js";
import { handleApprovals } from "../src/http/approvals.js";
import { PENDING_PREFIX } from "../src/tools/approvals.js";
import { AUDIT_PREFIX } from "../../../packages/shared/src/storageLayout.cjs";

/*
  The first-use ask (vault board 3): the first time each AI uses a key through
  Context, the person is asked in the app; their answer is written into the
  key, and the AI, told to try again, finds it there.

  Sabotage record (each broken by hand, the named check failed, then restored):
   - `firstUseAllowed` returning allowed for any client → "an AI's first use
     sends nothing and asks the person" fails.
   - the client id dropped from the ask's filing key → "another AI of the same
     person is asked afresh" fails.
   - the "just this once" grant not spent → "just this once is one request"
     fails.
*/

const KEY = "fake-vault-value-not-a-real-key-0077";
const KEYS = { current: "k1", keys: { k1: Buffer.from(new Uint8Array(32).fill(7)).toString("base64") } };

function memoryStore() {
  const objects = new Map();
  return {
    objects,
    async get(key) {
      return objects.has(key) ? { text: async () => objects.get(key), etag: `"${objects.get(key).length}"` } : null;
    },
    async put(key, value) {
      objects.set(key, String(value));
      return { etag: "e" };
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

async function world({ ask = true, people = ["user_a"] } = {}) {
  const store = memoryStore();
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

const pendingCount = (store) => [...store.objects.keys()].filter((key) => key.startsWith(PENDING_PREFIX)).length;

test("an AI's first use sends nothing and asks the person, once however often it tries", async () => {
  const { store, id, calls } = await world();
  const first = await asAI(store, AI, use(id));
  assert.equal(first.isError, true);
  assert.match(first.content[0].text, /Waiting for the person.*try again in a minute.*10 minutes means no/s);
  await asAI(store, AI, { ...use(id), url: "https://api.example.com/v1/other" });
  assert.equal(calls.length, 0);
  assert.equal(pendingCount(store), 1, "one ask per key and AI, whatever the address");
  const listed = await app(store, "GET");
  assert.equal(listed.body.approvals.length, 1);
  const [waiting] = listed.body.approvals;
  assert.equal(waiting.kind, "vault_use");
  assert.deepEqual(waiting.choices, ["approve_always", "approve", "deny"]);
  assert.match(waiting.summary, /let Claude Code use your Stripe key on api\.example\.com/);
  assert.ok(waiting.expires_at - waiting.created_at <= 10 * 60 * 1000);
  assert.equal(JSON.stringify(listed.body).includes(KEY), false);
});

test("yes, from now on: the AI that asked uses the key on every try after", async () => {
  const { store, id, calls } = await world();
  await asAI(store, AI, use(id));
  const [waiting] = (await app(store, "GET")).body.approvals;
  const answer = await app(store, "POST", { id: waiting.id, action: "approve_always" });
  assert.equal(answer.body.status, "approved");
  assert.equal(answer.body.ok, true);
  for (let i = 0; i < 3; i += 1) assert.equal((await asAI(store, AI, use(id))).isError, undefined);
  assert.equal(calls.length, 3);
  const meta = await readMeta(store, KEYS, "ws_1", id);
  assert.deepEqual(meta.proxy.clients.map((client) => client.id), ["client_claude"]);
  const audit = [...store.objects.entries()].filter(([key]) => key.startsWith(AUDIT_PREFIX)).map(([, v]) => JSON.parse(v));
  assert.ok(audit.some((row) => row.action === "vault_use_allowed" && row.details.always === true));
});

test("another AI of the same person is asked afresh", async () => {
  const { store, id, calls } = await world();
  await asAI(store, AI, use(id));
  await asAI(store, OTHER_AI, use(id));
  assert.equal(pendingCount(store), 2, "each AI is its own ask, so a yes to one is never a yes to the other");
  const both = (await app(store, "GET")).body.approvals;
  await app(store, "POST", { id: both.find((a) => /Other AI/.test(a.summary)).id, action: "deny" });
  const [waiting] = (await app(store, "GET")).body.approvals;
  await app(store, "POST", { id: waiting.id, action: "approve_always" });
  const other = await asAI(store, OTHER_AI, use(id));
  assert.equal(other.isError, true);
  assert.equal(calls.length, 0);
  assert.match((await app(store, "GET")).body.approvals[0].summary, /Other AI/);
});

test("just this once is one request", async () => {
  const { store, id, calls } = await world();
  await asAI(store, AI, use(id));
  const [waiting] = (await app(store, "GET")).body.approvals;
  assert.equal((await app(store, "POST", { id: waiting.id, action: "approve" })).body.status, "approved");
  assert.equal((await asAI(store, AI, use(id))).isError, undefined);
  assert.equal((await asAI(store, AI, use(id))).isError, true, "the second try asks again");
  assert.equal(calls.length, 1);
});

test("no leaves the key as it was, and the next try asks again", async () => {
  const { store, id, calls } = await world();
  await asAI(store, AI, use(id));
  const [waiting] = (await app(store, "GET")).body.approvals;
  assert.equal((await app(store, "POST", { id: waiting.id, action: "deny" })).body.status, "denied");
  assert.equal((await asAI(store, AI, use(id))).isError, true);
  assert.equal(calls.length, 0);
  assert.equal(pendingCount(store), 1, "a fresh ask");
});

test("only the app answers, and only for the person who was asked", async () => {
  const { store, id, calls } = await world({ people: ["user_a", "user_b"] });
  await asAI(store, AI, use(id));
  const [waiting] = (await app(store, "GET")).body.approvals;
  assert.equal((await app(store, "POST", { id: waiting.id, action: "approve_always" }, { clientId: "client_claude" })).status, 403);
  assert.equal((await app(store, "GET", null, { userId: "user_b" })).body.approvals.length, 0);
  assert.equal((await app(store, "POST", { id: waiting.id, action: "approve_always" }, { userId: "user_b" })).status, 404);
  assert.equal((await asAI(store, AI, use(id))).isError, true);
  assert.equal(calls.length, 0);
});

test("a yes from someone no longer given the key adds nothing", async () => {
  const { store, id } = await world();
  await asAI(store, AI, use(id));
  const [waiting] = (await app(store, "GET")).body.approvals;
  const meta = await readMeta(store, KEYS, "ws_1", id);
  const { writeMeta } = await import("../src/vault/entries.js");
  await writeMeta(store, KEYS, "ws_1", id, { ...meta, people: ["user_z"] });
  const answer = await app(store, "POST", { id: waiting.id, action: "approve_always" });
  assert.equal(answer.body.ok, false);
  assert.equal((await readMeta(store, KEYS, "ws_1", id)).proxy.clients, undefined);
});

test("from now on is a vault ask's answer only", async () => {
  const { store } = await world();
  const { createPending } = await import("../src/tools/approvals.js");
  const held = await createPending(store, {
    name: "set_visibility",
    args: { path: "a.md", visibility: "team" },
    actor: AI,
    tier: "private",
    scopes: [],
    widening: { summary: "make a.md team", audience: "team" },
    workspaceId: "ws_1",
    texting: false,
  });
  assert.equal((await app(store, "POST", { id: held.id, action: "approve_always" })).status, 400);
  assert.equal(pendingCount(store), 1, "still waiting");
});

test("a key saved with its ask off is used without asking", async () => {
  const { store, id, calls } = await world({ ask: false });
  assert.equal((await asAI(store, AI, use(id))).isError, undefined);
  assert.equal(calls.length, 1);
  assert.equal(pendingCount(store), 0);
});
