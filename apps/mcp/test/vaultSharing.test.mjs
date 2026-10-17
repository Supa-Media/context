import assert from "node:assert/strict";
import { test } from "node:test";
import { accessOf, belongsTo, mayUse, maySee, pruneRecords } from "../src/vault/access.js";
import { newEntryId, readMeta, writeEntry } from "../src/vault/entries.js";
import { toolVaultFetch, toolVaultList, toolVaultViewLink } from "../src/tools/vault.js";
import { PENDING_PREFIX } from "../src/tools/approvals.js";

/*
  Sharing a vault key (vault sharing boards, 2026-10-17): a key is given to a
  person, a group or the whole workspace, for their AIs to use or for them to
  see too; each AI's yes belongs to the person who gave it.

  Sabotage record (each broken by hand, the named check failed, then restored):
   - `accessOf` ignoring `level` (everything "see") → "a key given for AIs
     only can't be opened to see" fails.
   - the group check matching any `@name` share regardless of the caller's
     groups → "a group's key reaches its members and nobody else" fails.
   - `belongsTo` dropped from `firstUseAllowed` → "one person's yes never lets
     another person's AI in" fails.
*/

const KEY = "fake-vault-value-not-a-real-key-0099";
const KEYS = { current: "k1", keys: { k1: Buffer.from(new Uint8Array(32).fill(9)).toString("base64") } };

function memoryStore() {
  const objects = new Map();
  const versions = new Map();
  let counter = 0;
  return {
    objects,
    capabilities: { conditionalWrite: true },
    async get(key) {
      return objects.has(key) ? { text: async () => objects.get(key), etag: versions.get(key) } : null;
    },
    async put(key, value, options = {}) {
      const expected = options.onlyIf?.etagMatches;
      if (expected !== undefined && versions.get(key) !== expected) return null;
      objects.set(key, String(value));
      versions.set(key, `"v${++counter}"`);
      return { etag: versions.get(key) };
    },
    async delete(key) {
      objects.delete(key);
      return {};
    },
    async list({ prefix }) {
      return { objects: [...objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false };
    },
  };
}

const SAVER = "user_saver";
const meta = (extra = {}) => ({ name: "Convex", sites: [], people: [SAVER], createdBy: SAVER, createdAt: 1, updatedAt: 1, ...extra });

test("the person who saved a key always sees it; one given before levels existed sees it too", () => {
  assert.equal(accessOf(meta(), SAVER), "see");
  assert.equal(accessOf(meta({ people: [SAVER, "user_old"] }), "user_old"), "see");
  assert.equal(accessOf(meta(), "user_other"), null);
  assert.equal(accessOf(meta(), ""), null);
});

test("a key given for AIs only can't be opened to see", () => {
  const given = meta({ people: [SAVER, "user_b"], shares: [{ to: "user_b", level: "use", by: SAVER, at: 2 }] });
  assert.equal(accessOf(given, "user_b"), "use");
  assert.equal(mayUse(given, "user_b"), true);
  assert.equal(maySee(given, "user_b"), false);
});

test("a group's key reaches its members and nobody else", () => {
  const given = meta({ shares: [{ to: "@team-leads", level: "use", by: SAVER, at: 2 }] });
  assert.equal(accessOf(given, "user_b", ["@team-leads"]), "use");
  assert.equal(accessOf(given, "user_b", ["team-leads"]), "use", "names come with or without the @");
  assert.equal(accessOf(given, "user_b", new Set(["@team-leads"])), "use");
  assert.equal(accessOf(given, "user_c", ["@team-other"]), null);
  assert.equal(accessOf(given, "user_c"), null);
});

test("the whole workspace means every member, and the most generous share wins", () => {
  const given = meta({
    people: [SAVER, "user_b"],
    shares: [
      { to: "*", level: "use", by: SAVER, at: 2 },
      { to: "user_b", level: "see", by: SAVER, at: 3 },
    ],
  });
  assert.equal(accessOf(given, "user_anyone"), "use");
  assert.equal(accessOf(given, "user_b"), "see");
  const narrowed = meta({
    people: [SAVER, "user_b"],
    shares: [
      { to: "user_b", level: "use", by: SAVER, at: 2 },
      { to: "@team-leads", level: "see", by: SAVER, at: 3 },
    ],
  });
  assert.equal(accessOf(narrowed, "user_b", ["@team-leads"]), "see");
});

test("a share with a level that isn't one grants nothing", () => {
  assert.equal(accessOf(meta({ shares: [{ to: "*", level: "admin", by: SAVER, at: 2 }] }), "user_b"), null);
  assert.equal(accessOf(meta({ shares: [{ to: "@Bad Name", level: "see", by: SAVER, at: 2 }] }), "user_b", ["@Bad Name"]), null);
});

test("an AI record belongs to its person, and an old one to whoever saved the key", () => {
  const key = meta();
  assert.equal(belongsTo({ id: "c", by: "user_b" }, "user_b", key), true);
  assert.equal(belongsTo({ id: "c", by: "user_b" }, SAVER, key), false);
  assert.equal(belongsTo({ id: "c" }, SAVER, key), true);
  assert.equal(belongsTo({ id: "c" }, "user_b", key), false);
});

test("taking a key back takes that person's AIs with it", () => {
  const key = meta({
    proxy: {
      host: "api.example.com",
      clients: [{ id: "c1", by: "user_b" }, { id: "c2" }],
      once: [{ id: "c1", by: "user_b", until: 9 }],
      uses: [{ id: "c1", by: "user_b", count: 1 }],
      refused: [{ id: "c3", by: "user_b" }],
    },
  });
  const pruned = pruneRecords(key, (userId) => userId !== "user_b");
  assert.deepEqual(pruned.proxy.clients, [{ id: "c2" }]);
  assert.deepEqual(pruned.proxy.once, []);
  assert.deepEqual(pruned.proxy.uses, []);
  assert.deepEqual(pruned.proxy.refused, []);
});

async function world(shares, people = [SAVER]) {
  const store = memoryStore();
  const id = newEntryId();
  await writeEntry(store, KEYS, "ws_1", {
    id,
    meta: {
      type: "secret",
      name: "Convex",
      sites: [],
      people,
      shares,
      fields: [{ name: "K", perEnv: false, set: ["_"] }],
      proxy: { host: "api.example.com", style: "bearer", ask: true, clients: [{ id: "client_claude", name: "Claude Code", at: 1, by: SAVER }] },
      createdBy: SAVER,
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
  Object.defineProperty(store, "vaultLinks", {
    value: { request: async () => ({ url: "https://context.example/vault/t" }) },
    enumerable: false,
  });
  return { store, id, calls };
}

const actor = (userId, groups = []) => ({
  workspaceId: "ws_1",
  workspaceKind: "shared",
  userId,
  groups,
  clientId: "client_claude",
  client: "Claude Code",
});
const use = (id) => ({ entry: id, field: "K", url: "https://api.example.com/v1/items" });
const pending = (store) => [...store.objects.keys()].filter((key) => key.startsWith(PENDING_PREFIX)).length;

test("one person's yes never lets another person's AI in", async () => {
  const { store, id, calls } = await world([{ to: "@team-leads", level: "use", by: SAVER, at: 2 }]);
  store.actor = actor(SAVER);
  const own = await toolVaultFetch(store, use(id));
  assert.equal(own.isError, undefined, own.content?.[0]?.text);
  assert.equal(calls.length, 1);
  // The same app, connected by somebody the key was given to through a group.
  store.actor = actor("user_b", ["@team-leads"]);
  const theirs = await toolVaultFetch(store, use(id));
  assert.equal(theirs.isError, true);
  assert.match(theirs.content[0].text, /Waiting for the person/);
  assert.equal(calls.length, 1, "no request went out for them");
  assert.equal(pending(store), 1, "they are asked, by their own ask");
});

test("a key given to a group is listed and usable by its members only", async () => {
  const { store, id } = await world([{ to: "@team-leads", level: "use", by: SAVER, at: 2 }]);
  store.actor = actor("user_b", ["@team-leads"]);
  assert.match((await toolVaultList(store, {})).content[0].text, new RegExp(id));
  store.actor = actor("user_c", ["@team-other"]);
  assert.doesNotMatch((await toolVaultList(store, {})).content[0].text, new RegExp(id));
  const refused = await toolVaultFetch(store, use(id));
  assert.match(refused.content[0].text, /no such entry/);
});

test("a key given for AIs only gets no link to see it; given to see, it does", async () => {
  const { store, id } = await world([{ to: "*", level: "use", by: SAVER, at: 2 }]);
  store.actor = actor("user_b");
  const refused = await toolVaultViewLink(store, { entry: id });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /for their AIs to use, not to see/);
  const seen = await world([{ to: "*", level: "see", by: SAVER, at: 2 }]);
  seen.store.actor = actor("user_b");
  const link = await toolVaultViewLink(seen.store, { entry: seen.id });
  assert.equal(link.isError, undefined);
});

test("the stored key keeps the yes with the person who gave it", async () => {
  const { store, id } = await world([]);
  const read = await readMeta(store, KEYS, "ws_1", id);
  assert.equal(read.proxy.clients[0].by, SAVER);
  assert.equal(JSON.stringify([...store.objects.values()]).includes(KEY), false, "the value stays sealed");
});
