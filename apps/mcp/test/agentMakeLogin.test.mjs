/**
 * `make_login` (`src/agent/makeLogin.js`): Tex creates a new account and the
 * gateway makes the password. These drive `makeLoginTool` with a fake browser
 * and a memory store that share one ordered event log, and prove: the vault
 * write lands before any box is typed; what was typed is what was saved; no
 * tool result or log line carries the password or the username; a failed save
 * types nothing; an account the person already has is never made again; and a
 * retry on the same page refills the same password.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { MAKE_LOGIN_DEFINITION, MAKE_LOGIN_TOOL, makeLoginTool, MAX_NEW_LOGINS_PER_TURN } from "../../../packages/tex/gateway/agent/makeLogin.js";
import { newEntryId, listMeta, writeEntry } from "../src/vault/entries.js";
import { openForFill } from "../src/vault/fill.js";
import { actorMayUse } from "../src/vault/access.js";
import { newPassword, randomBelow, PASSWORD_LENGTH } from "../src/vault/newPassword.js";

const USERNAME = "seyi.new@example.test";
const KEYS = { current: "k1", keys: { k1: Buffer.from(new Uint8Array(32).fill(7)).toString("base64") } };
const ORIGIN = "https://www.shop.example.test";
const HOST = "shop.example.test";

/** A memory object store whose writes also land in the caller's ordered event log. */
function memoryStore(log, { failPut = false } = {}) {
  const objects = new Map();
  return {
    async get(key) {
      return objects.has(key) ? { text: async () => objects.get(key) } : null;
    },
    async put(key, value) {
      if (failPut) throw new Error("storage is down");
      objects.set(key, String(value));
      log.push({ type: "put", key });
    },
    async delete(key) {
      objects.delete(key);
    },
    async list({ prefix }) {
      return { objects: [...objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false };
    },
  };
}

function vaultStore({ log = [], actor = { workspaceId: "ws_1", userId: "user_a", workspaceKind: "personal", role: "owner" }, failPut } = {}) {
  const store = memoryStore(log, { failPut });
  Object.defineProperty(store, "encryptionKey", { value: KEYS, enumerable: false });
  store.actor = actor;
  return store;
}

/** A browser on `origin` whose boxes take any value of the right kind; every typed box is logged in order. */
function fakeBrowser(log, origin = ORIGIN) {
  const kinds = { 1: "username", 2: "password", 3: "password" };
  const typed = [];
  return {
    typed,
    currentOrigin: () => origin,
    async fillSecret(step) {
      const ok = step.origin === origin && kinds[step.ref] === step.field;
      const result = ok ? { ok: true } : { ok: false, reason: `that is not a ${step.field} box` };
      if (ok) {
        typed.push({ ref: step.ref, field: step.field, value: step.value });
        log.push({ type: "fill", ref: step.ref, field: step.field });
      }
      return result;
    },
  };
}

const entries = (store) => listMeta(store, KEYS, store.actor.workspaceId);
const leaks = (value, secrets) => secrets.some((s) => JSON.stringify(value).includes(s));

test("generator: unique, classed, sized, unbiased", () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i += 1) {
    const pw = newPassword();
    assert.equal(pw.length, PASSWORD_LENGTH);
    assert.match(pw, /[a-z]/);
    assert.match(pw, /[A-Z]/);
    assert.match(pw, /[2-9]/);
    assert.match(pw, /[!@#$%^&*\-_=+?]/);
    seen.add(pw);
  }
  assert.equal(seen.size, 2000);
  for (let i = 0; i < 200; i += 1) assert.doesNotMatch(newPassword({ symbols: false }), /[!@#$%^&*\-_=+?]/);
  assert.equal(newPassword({ length: 5 }).length, 12);
  assert.equal(newPassword({ length: 500 }).length, 64);
  assert.equal(newPassword({ length: 1.5 }).length, PASSWORD_LENGTH);
  assert.equal(newPassword({ length: 30 }).length, 30);

  const buckets = new Array(10).fill(0);
  for (let i = 0; i < 20000; i += 1) {
    const n = randomBelow(10);
    assert.ok(n >= 0 && n < 10);
    buckets[n] += 1;
  }
  for (const count of buckets) assert.ok(Math.abs(count - 2000) <= 300, `bucket ${count} is outside 15% of 2000`);
  assert.throws(() => randomBelow(0), RangeError);
});

test("the vault write lands before any box is typed, and what is saved is what is typed", async () => {
  const log = [];
  const store = vaultStore({ log });
  const browser = fakeBrowser(log);
  const tool = makeLoginTool(browser, store);
  const result = await tool.call({ username: USERNAME, username_ref: 1, password_ref: 2, confirm_ref: 3, name: "Example Shop" });
  assert.notEqual(result.isError, true, result.content[0].text);

  const firstFill = log.findIndex((e) => e.type === "fill");
  assert.ok(firstFill > 0, "a put comes before the first fill");
  assert.equal(log[0].type, "put");
  assert.equal(log.filter((e) => e.type === "put").length, 1);

  const [meta] = await entries(store);
  assert.equal(meta.meta.createdBy, "user_a");
  assert.deepEqual(meta.meta.sites, [HOST]);
  assert.equal(meta.meta.madeBy, "tex");
  const id = meta.id;
  const saved = await openForFill(store, undefined, { entryId: id, origin: ORIGIN });
  assert.equal(saved.username, USERNAME);
  assert.equal(saved.name, "Example Shop");
  const password = browser.typed.find((t) => t.ref === 2).value;
  assert.equal(saved.password, password);
  assert.equal(browser.typed.find((t) => t.ref === 3).value, password);
  assert.equal(browser.typed.find((t) => t.ref === 1).value, USERNAME);
  assert.equal(password.length, PASSWORD_LENGTH);
  assert.match(result.content[0].text, new RegExp(`id ${id}`));
});

test("no tool result or log line carries the password or the username", async () => {
  const log = [];
  const store = vaultStore({ log });
  const browser = fakeBrowser(log);
  const tool = makeLoginTool(browser, store);
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  let result;
  try {
    result = await tool.call({ username: USERNAME, username_ref: 1, password_ref: 2 });
  } finally {
    console.log = original;
  }
  assert.notEqual(result.isError, true);
  assert.ok(lines.length > 0, "the call logs its one line");
  const password = browser.typed.find((t) => t.ref === 2).value;
  assert.equal(leaks(result, [password, USERNAME]), false);
  for (const line of lines) {
    assert.equal(line.includes(password), false);
    assert.equal(line.includes(USERNAME), false);
    assert.equal(line.includes(HOST), false);
  }
});

test("a failed vault write is an error, and nothing is typed", async () => {
  const log = [];
  const store = vaultStore({ log, failPut: true });
  const browser = fakeBrowser(log);
  const result = await makeLoginTool(browser, store).call({ username: USERNAME, password_ref: 2 });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /nothing was typed/);
  assert.equal(browser.typed.length, 0);
  assert.equal(log.filter((e) => e.type === "fill").length, 0);
  assert.equal(leaks(result, [USERNAME]), false);
});

test("an account the person already has on that site is refused, and nothing is written", async () => {
  const log = [];
  const store = vaultStore({ log });
  const existingId = newEntryId();
  await writeEntry(store, KEYS, "ws_1", {
    id: existingId,
    meta: { name: "Shop", sites: [HOST], people: ["user_a"], createdBy: "user_a", createdAt: 1, updatedAt: 1 },
    secret: { username: "old@example.test", password: "old-password-1" },
  });
  const before = (await entries(store)).length;
  const browser = fakeBrowser(log);
  const result = await makeLoginTool(browser, store).call({ username: USERNAME, password_ref: 2 });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /send action fill_login/);
  assert.match(result.content[0].text, new RegExp(`id ${existingId}`));
  assert.equal((await entries(store)).length, before);
  assert.equal(browser.typed.length, 0);
  assert.equal(log.filter((e) => e.type === "put").length, 1, "only the earlier login was written");
});

test("a retry on the same page in the same turn refills the same password, with no second entry", async () => {
  const log = [];
  const store = vaultStore({ log });
  const browser = fakeBrowser(log);
  const tool = makeLoginTool(browser, store);
  assert.notEqual((await tool.call({ username: USERNAME, username_ref: 1, password_ref: 2, confirm_ref: 3 })).isError, true);
  const again = await tool.call({ username: USERNAME, username_ref: 1, password_ref: 2, confirm_ref: 3 });
  assert.notEqual(again.isError, true, again.content[0].text);
  assert.equal((await entries(store)).length, 1);
  assert.equal(log.filter((e) => e.type === "put").length, 1);
  const passwords = browser.typed.filter((t) => t.ref === 2).map((t) => t.value);
  assert.equal(passwords.length, 2);
  assert.equal(passwords[0], passwords[1]);
  assert.equal(leaks(again, passwords), false);
});

test("a group chat's login is the tagger's, shared to that chat, and usable by it", async () => {
  const log = [];
  const actor = { workspaceId: "ws_1", userId: "sponsor", taggerId: "tagger", chat: "chat_k", clientId: "context_texts_group", role: "editor" };
  const store = vaultStore({ log, actor });
  const result = await makeLoginTool(fakeBrowser(log), store).call({ username: USERNAME, password_ref: 2 });
  assert.notEqual(result.isError, true, result.content[0].text);
  const [{ meta }] = await entries(store);
  assert.equal(meta.createdBy, "tagger");
  assert.ok(meta.shares.some((share) => share.to === "#chat:chat_k" && share.level === "use"));
  assert.equal(actorMayUse(meta, actor), true);
});

test("no browser origin, or a page that is not https, saves nothing", async () => {
  for (const origin of [null, "http://shop.example.test", "not a url"]) {
    const log = [];
    const store = vaultStore({ log });
    const browser = fakeBrowser(log, origin);
    const result = await makeLoginTool(browser, store).call({ username: USERNAME, password_ref: 2 });
    assert.equal(result.isError, true);
    assert.equal(log.length, 0);
    assert.equal(browser.typed.length, 0);
  }
});

test("the definition is named, has no example sites, and never publishes a password", () => {
  assert.equal(MAKE_LOGIN_DEFINITION.name, MAKE_LOGIN_TOOL);
  assert.deepEqual(MAKE_LOGIN_DEFINITION.inputSchema.required, ["username", "password_ref"]);
  assert.equal(MAX_NEW_LOGINS_PER_TURN, 2);
  assert.match(MAKE_LOGIN_DEFINITION.description, /You never see the password/);
});

test("a read-only grant saves and types nothing", async () => {
  const log = [];
  const store = vaultStore({ log, actor: { workspaceId: "ws_1", userId: "user_a", workspaceKind: "shared", role: "member" } });
  const browser = fakeBrowser(log);
  const result = await makeLoginTool(browser, store).call({ username: USERNAME, password_ref: 2 });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /read only/);
  assert.equal(log.length, 0);
  assert.equal(browser.typed.length, 0);
});

test("a login for the site saved in another workspace the turn reaches is the existing account: refused", async () => {
  const log = [];
  const other = vaultStore({ actor: { workspaceId: "ws_2", userId: "user_a", workspaceKind: "shared", role: "editor" } });
  await writeEntry(other, KEYS, "ws_2", {
    id: newEntryId(),
    meta: { name: "Shop", sites: [HOST], people: ["user_a"], createdBy: "user_a", createdAt: 1, updatedAt: 1 },
    secret: { username: "x", password: "y" },
  });
  const store = vaultStore({ log });
  store.contexts = [{ name: "@team" }];
  store.openContext = async (name) => (name === "@team" ? { store: other } : null);
  const browser = fakeBrowser(log);
  const result = await makeLoginTool(browser, store).call({ username: USERNAME, password_ref: 2 });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /fill_login/);
  assert.equal(log.length, 0);
  assert.equal((await entries(store)).length, 0);
});
