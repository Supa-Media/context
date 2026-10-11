import assert from "node:assert/strict";
import { test } from "node:test";
import { VAULT_PREFIX, newEntryId, readMeta, siteHost, siteMatches, writeEntry, writeMeta } from "../src/vault/entries.js";
import { VaultRefused, openForFill } from "../src/vault/fill.js";
import { openPart } from "../src/vault/seal.js";
import { toolVaultAddLink, toolVaultList, toolVaultShareLink, toolVaultViewLink } from "../src/tools/vault.js";
import { fieldSummaries, normalizeFields } from "../src/vault/fields.js";
import { createVaultMethods } from "../src/controlPlane/vault.js";

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

const STRIPE_DEV = "sk_test_fake_dev_0000";
const STRIPE_PROD = "sk_live_fake_prod_9999";

async function secretVault({ sites = ["dashboard.stripe.com"] } = {}) {
  const store = memoryStore();
  const id = newEntryId();
  const { fields } = normalizeFields([
    { name: "STRIPE_SECRET_KEY", perEnv: true, values: { dev: STRIPE_DEV, staging: "", prod: STRIPE_PROD } },
    { name: "Account number", perEnv: false, values: { _: "acct_fake_42" } },
  ]);
  await writeEntry(store, KEYS, "ws_1", {
    id,
    meta: { type: "secret", name: "Stripe", sites, fields: fieldSummaries(fields), people: ["user_a"], createdBy: "user_a", createdAt: 1, updatedAt: 1 },
    secret: { fields },
  });
  Object.defineProperty(store, "encryptionKey", { value: KEYS, enumerable: false });
  store.actor = { workspaceId: "ws_1", userId: "user_a", workspaceKind: "shared" };
  return { store, id };
}

test("a secret's values and field names never reach the bucket in the clear, and vault_list names fields without values", async () => {
  const { store, id } = await secretVault();
  const raw = store.objects.get(`${VAULT_PREFIX}${id}.json`);
  for (const plain of [STRIPE_DEV, STRIPE_PROD, "acct_fake_42", "STRIPE_SECRET_KEY", "Stripe"]) {
    assert.equal(raw.includes(plain), false, `${plain} is in the bucket`);
  }
  const listed = resultText(await toolVaultList(store));
  assert.match(listed, /STRIPE_SECRET_KEY \[dev, prod\]/);
  assert.match(listed, /Account number/);
  for (const value of [STRIPE_DEV, STRIPE_PROD, "acct_fake_42"]) assert.equal(listed.includes(value), false);
});

test("the fill step types one field for one environment, on the entry's site only", async () => {
  const { store, id } = await secretVault();
  const origin = "https://dashboard.stripe.com";
  assert.equal((await openForFill(store, undefined, { entryId: id, origin, field: "STRIPE_SECRET_KEY", env: "prod" })).value, STRIPE_PROD);
  assert.equal((await openForFill(store, undefined, { entryId: id, origin, field: "Account number" })).value, "acct_fake_42");
  // Staging was left blank, an env is required for a per-environment field, and a secret has no password.
  for (const ask of [{ field: "STRIPE_SECRET_KEY", env: "staging" }, { field: "STRIPE_SECRET_KEY" }, { field: "NOPE" }, {}]) {
    await assert.rejects(openForFill(store, undefined, { entryId: id, origin, ...ask }), (e) => e.code === "no_field");
  }
  await assert.rejects(openForFill(store, undefined, { entryId: id, origin: "https://stripe.com.evil.example", field: "Account number" }), (e) => e.code === "wrong_site");
  const siteless = await secretVault({ sites: [] });
  await assert.rejects(openForFill(siteless.store, undefined, { entryId: siteless.id, origin, field: "Account number" }), (e) => e.code === "wrong_site");
});

test("fields are named like env variables or labels, unique ignoring case, and capped", () => {
  assert.equal(normalizeFields([{ name: "A", values: { _: "1" } }, { name: "a", values: { _: "2" } }]).error !== null, true);
  assert.equal(normalizeFields([{ name: "../x", values: { _: "1" } }]).error !== null, true);
  assert.equal(normalizeFields([{ name: "K", values: { _: "x".repeat(8193) } }]).error !== null, true);
  assert.equal(normalizeFields(Array.from({ length: 31 }, (_, i) => ({ name: `K${i}` }))).error !== null, true);
  const { fields } = normalizeFields([{ name: "K", perEnv: true, values: { dev: "d", prod: "", other: "x" } }]);
  assert.deepEqual(fields, [{ name: "K", perEnv: true, values: { dev: "d" } }]);
  assert.deepEqual(fieldSummaries(fields), [{ name: "K", perEnv: true, set: ["dev"] }]);
});

test("asking to see or save a secret sends the control plane ids only; the form's prefill rides on the URL", async () => {
  const { store, id } = await secretVault();
  const posted = [];
  const methods = createVaultMethods({
    post: async (path, body) => (posted.push(body), { url: "https://context.example/vault/tok" }),
    required: (parsed, key) => parsed[key],
  });
  Object.defineProperty(store, "vaultLinks", { value: { request: (request) => methods.vaultRequest("at", "ws_1", request) } });
  const added = resultText(await toolVaultAddLink(store, { type: "secret", name: "Stripe", fields: ["STRIPE_SECRET_KEY"] }));
  assert.match(added, /type=secret/);
  assert.match(added, /fields=STRIPE_SECRET_KEY/);
  assert.match(added, /envs=1/);
  const viewed = resultText(await toolVaultViewLink(store, { entry: id, env: "prod" }));
  assert.match(viewed, /env=prod/);
  assert.deepEqual(posted.map(({ accessToken, expectedWorkspaceId, ...rest }) => rest), [{ kind: "add" }, { kind: "view", entryId: id }]);
  store.actor = { ...store.actor, userId: "user_b" };
  assert.equal((await toolVaultViewLink(store, { entry: id })).isError, true);
  assert.equal(posted.length, 2);
});
