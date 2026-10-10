import assert from "node:assert/strict";
import { test } from "node:test";
import { VAULT_PREFIX, newEntryId, readMeta, siteHost, siteMatches, writeEntry, writeMeta } from "../src/vault/entries.js";
import { VaultRefused, openForFill } from "../src/vault/fill.js";
import { openPart } from "../src/vault/seal.js";
import { toolVaultAddLink, toolVaultList, toolVaultShareLink } from "../src/tools/vault.js";

const PASSWORD = "hunter2-correct-horse";
const USERNAME = "seyi@example.test";
const material = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");
const KEYS = { current: "k1", keys: { k1: material } };

function memoryStore() {
  const objects = new Map();
  return {
    objects,
    async get(key) {
      return objects.has(key) ? { text: async () => objects.get(key) } : null;
    },
    async put(key, value) {
      objects.set(key, String(value));
    },
    async delete(key) {
      objects.delete(key);
    },
    async list({ prefix }) {
      return { objects: [...objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false };
    },
  };
}

async function vaultWith({ people = ["user_a"], workspaceKind = "shared", userId = "user_a" } = {}) {
  const store = memoryStore();
  const id = newEntryId();
  await writeEntry(store, KEYS, "ws_1", {
    id,
    meta: { name: "Netflix", sites: ["netflix.com"], people, createdBy: "user_a", createdAt: 1, updatedAt: 1 },
    secret: { username: USERNAME, password: PASSWORD },
  });
  Object.defineProperty(store, "encryptionKey", { value: KEYS, enumerable: false });
  store.actor = { workspaceId: "ws_1", userId, workspaceKind };
  return { store, id };
}

function resultText(result) {
  return JSON.stringify(result);
}

test("a bucket read of a vault entry never yields the login, its name or its site", async () => {
  const { store, id } = await vaultWith();
  const raw = store.objects.get(`${VAULT_PREFIX}${id}.json`);
  assert.ok(raw);
  for (const plain of [PASSWORD, USERNAME, "Netflix", "netflix.com", "user_a"]) {
    assert.equal(raw.includes(plain), false, `${plain} is in the bucket`);
  }
});

test("a sealed part opens only as itself: not on another entry, workspace or part", async () => {
  const { store, id } = await vaultWith();
  const record = JSON.parse(store.objects.get(`${VAULT_PREFIX}${id}.json`));
  const other = newEntryId();
  await assert.rejects(openPart(KEYS, { workspaceId: "ws_1", entryId: other, part: "secret" }, record.secret));
  await assert.rejects(openPart(KEYS, { workspaceId: "ws_2", entryId: id, part: "secret" }, record.secret));
  await assert.rejects(openPart(KEYS, { workspaceId: "ws_1", entryId: id, part: "meta" }, record.secret));
  const wrongKey = { current: "k1", keys: { k1: Buffer.from(new Uint8Array(32).fill(8)).toString("base64") } };
  await assert.rejects(openPart(wrongKey, { workspaceId: "ws_1", entryId: id, part: "secret" }, record.secret));
  const opened = await openPart(KEYS, { workspaceId: "ws_1", entryId: id, part: "secret" }, record.secret);
  assert.equal(opened.password, PASSWORD);
});

test("a site fills on itself and beneath it, never on a lookalike or plain http", () => {
  assert.equal(siteHost("https://www.Netflix.com/login"), "www.netflix.com");
  assert.equal(siteHost("netflix.com"), "netflix.com");
  assert.equal(siteHost("https://user:pw@netflix.com"), null);
  assert.equal(siteHost("localhost"), null);
  assert.equal(siteHost("10.0.0.1"), null);
  const sites = ["netflix.com"];
  assert.equal(siteMatches(sites, "https://netflix.com"), true);
  assert.equal(siteMatches(sites, "https://www.netflix.com"), true);
  assert.equal(siteMatches(sites, "https://accounts.netflix.com"), true);
  assert.equal(siteMatches(["www.netflix.com"], "https://netflix.com"), true);
  assert.equal(siteMatches(sites, "https://netflix.com.evil.example"), false);
  assert.equal(siteMatches(sites, "https://evilnetflix.com"), false);
  assert.equal(siteMatches(sites, "http://netflix.com"), false);
  assert.equal(siteMatches(sites, "not a url"), false);
});

test("the fill step opens a login only for its people, on its site", async () => {
  const { store, id } = await vaultWith();
  const filled = await openForFill(store, undefined, { entryId: id, origin: "https://www.netflix.com" });
  assert.equal(filled.password, PASSWORD);
  assert.equal(filled.username, USERNAME);

  await assert.rejects(openForFill(store, undefined, { entryId: id, origin: "https://netflix.com.evil.example" }), (e) => e instanceof VaultRefused && e.code === "wrong_site");
  await assert.rejects(openForFill(store, undefined, { entryId: newEntryId(), origin: "https://netflix.com" }), (e) => e.code === "not_found");
  store.actor = { ...store.actor, userId: "user_b" };
  await assert.rejects(openForFill(store, undefined, { entryId: id, origin: "https://netflix.com" }), (e) => e.code === "not_yours");
});

test("sharing adds a person: after it, they can have it filled, and nobody else can", async () => {
  const { store, id } = await vaultWith();
  const meta = await readMeta(store, KEYS, "ws_1", id);
  await writeMeta(store, KEYS, "ws_1", id, { ...meta, people: [...meta.people, "user_b"] });
  store.actor = { ...store.actor, userId: "user_b" };
  assert.equal((await openForFill(store, undefined, { entryId: id, origin: "https://netflix.com" })).password, PASSWORD);
  store.actor = { ...store.actor, userId: "user_c" };
  await assert.rejects(openForFill(store, undefined, { entryId: id, origin: "https://netflix.com" }), (e) => e.code === "not_yours");
});

test("no vault tool result ever carries a username or password", async () => {
  const { store, id } = await vaultWith();
  const requests = [];
  Object.defineProperty(store, "vaultLinks", {
    value: { request: async (request) => (requests.push(request), { url: "https://context.example/vault/tok" }) },
  });
  const results = [
    await toolVaultList(store),
    await toolVaultAddLink(store, { name: "Netflix", site: "netflix.com" }),
    await toolVaultShareLink(store, { entry: id, with: "@sayo" }),
  ];
  for (const result of results) {
    const text = resultText(result);
    assert.equal(text.includes(PASSWORD), false);
    assert.equal(text.includes(USERNAME), false);
  }
  assert.match(resultText(results[0]), /Netflix/);
  assert.match(resultText(results[0]), new RegExp(id));
  assert.deepEqual(requests[1], { kind: "share", entryId: id, handle: "sayo" });
  for (const request of requests) assert.equal(resultText(request).includes(PASSWORD), false);
});

test("vault_list shows only the logins this person may use", async () => {
  const { store } = await vaultWith({ people: ["user_a"], userId: "user_b" });
  assert.doesNotMatch(resultText(await toolVaultList(store)), /Netflix/);
});

test("a personal workspace's logins are never offered for sharing", async () => {
  const { store, id } = await vaultWith({ workspaceKind: "personal" });
  let asked = false;
  Object.defineProperty(store, "vaultLinks", { value: { request: async () => ((asked = true), { url: "https://x.example/v" }) } });
  const result = await toolVaultShareLink(store, { entry: id, with: "@sayo" });
  assert.equal(result.isError, true);
  assert.equal(asked, false);
});

test("an agent cannot ask to share a login it may not use", async () => {
  const { store, id } = await vaultWith({ people: ["user_a"], userId: "user_b" });
  let asked = false;
  Object.defineProperty(store, "vaultLinks", { value: { request: async () => ((asked = true), { url: "https://x.example/v" }) } });
  const result = await toolVaultShareLink(store, { entry: id, with: "@sayo" });
  assert.equal(result.isError, true);
  assert.equal(asked, false);
});
