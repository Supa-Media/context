/**
 * `fill_login` (`src/agent/fillLogin.js`): the agent signs in with a saved
 * login and never holds it. These drive `webSession` with a fake browser and
 * a real sealed vault entry and prove: the site checked is where the browser
 * is, never what the model says; a password goes only into a password box;
 * the person's grant decides whose logins exist; and no tool result, refused
 * or not, carries the username or the password.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { webSession } from "../src/agent/computer.js";
import { BROWSE_TOOL } from "../src/agent/browse.js";
import { FILL_LOGIN_TOOL, MAX_FILLS_PER_TURN } from "../src/agent/fillLogin.js";
import { newEntryId, writeEntry } from "../src/vault/entries.js";

const PASSWORD = "hunter2-correct-horse";
const USERNAME = "seyi@example.test";
const KEYS = { current: "k1", keys: { k1: Buffer.from(new Uint8Array(32).fill(7)).toString("base64") } };

function memoryStore() {
  const objects = new Map();
  return {
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

async function vaultWith({ workspaceId = "ws_1", userId = "user_a", people = ["user_a"] } = {}) {
  const store = memoryStore();
  const id = newEntryId();
  await writeEntry(store, KEYS, workspaceId, {
    id,
    meta: { name: "Netflix", sites: ["netflix.com"], people, createdBy: "user_a", createdAt: 1, updatedAt: 1 },
    secret: { username: USERNAME, password: PASSWORD },
  });
  Object.defineProperty(store, "encryptionKey", { value: KEYS, enumerable: false });
  store.actor = { workspaceId, userId, workspaceKind: "personal" };
  return { store, id };
}

/** A browser whose box 1 is an email box and box 2 a password box, like the real one checks. */
function fakeComputer() {
  const calls = [];
  const typed = {};
  let at = null;
  const kinds = { 1: "username", 2: "password" };
  return {
    calls,
    typed,
    goTo(url) {
      at = url;
    },
    async readPage(url) {
      return { url, title: "", text: "x", links: [] };
    },
    async browse(session, steps) {
      calls.push(steps);
      const ran = [];
      for (const step of steps) {
        if (step.do === "goto") at = step.url;
        if (step.do === "fill") {
          if (new URL(at).origin !== step.origin) ran.push({ do: "fill", ok: false, reason: "origin mismatch" });
          else if (kinds[step.ref] !== step.field) ran.push({ do: "fill", ok: false, reason: `that is not a ${step.field} box` });
          else {
            typed[step.ref] = step.value;
            ran.push({ do: "fill", ok: true });
          }
          continue;
        }
        ran.push({ do: step.do, ok: true });
      }
      return {
        session: "sess-fake",
        ran,
        page: {
          url: at,
          title: "Sign in",
          text: "Sign in",
          elements: [
            { ref: 1, kind: "input email", label: "Email", filled: Boolean(typed[1]) },
            { ref: 2, kind: "input password", label: "Password", filled: Boolean(typed[2]) },
            { ref: 3, kind: "button", label: "Sign in" },
          ],
        },
      };
    },
    async closeBrowser() {},
  };
}

const fills = (computer) => computer.calls.flat().filter((s) => s.do === "fill");
const leaks = (result) => {
  const shown = JSON.stringify(result);
  return shown.includes(PASSWORD) || shown.includes(USERNAME);
};

async function signInPage(store, url = "https://www.netflix.com/login") {
  const computer = fakeComputer();
  const web = webSession(computer, `sign in to ${url} and check my plan`, { store });
  const opened = await web.call(BROWSE_TOOL, { steps: [{ do: "goto", url }] });
  assert.notEqual(opened.isError, true);
  return { computer, web };
}

test("fill_login is offered only with a browser and the turn's vault", async () => {
  const { store } = await vaultWith();
  assert.ok(webSession(fakeComputer(), "hi", { store }).tools.some((t) => t.name === FILL_LOGIN_TOOL));
  assert.ok(!webSession(fakeComputer(), "hi").tools.some((t) => t.name === FILL_LOGIN_TOOL));
  assert.ok(!webSession(null, "hi", { store, search: async () => [] }).tools.some((t) => t.name === FILL_LOGIN_TOOL));
});

test("it fills both boxes on the login's own site, and the model sees only that it worked", async () => {
  const { store, id } = await vaultWith();
  const { computer, web } = await signInPage(store);
  const result = await web.call(FILL_LOGIN_TOOL, { entry: id, username_ref: 1, password_ref: 2 });
  assert.notEqual(result.isError, true);
  assert.match(result.content[0].text, /Filled the login for Netflix/);
  assert.equal(leaks(result), false);
  assert.deepEqual(computer.typed, { 1: USERNAME, 2: PASSWORD });
  assert.deepEqual(
    fills(computer).map(({ ref, origin, field }) => ({ ref, origin, field })),
    [
      { ref: 1, origin: "https://www.netflix.com", field: "username" },
      { ref: 2, origin: "https://www.netflix.com", field: "password" },
    ],
  );
  // The next reading says the boxes are filled, never with what.
  const after = await web.call(BROWSE_TOOL, { steps: [{ do: "read" }] });
  assert.match(after.content[0].text, /\(filled\)/);
  assert.equal(leaks(after), false);
});

test("the site is where the browser is: a model naming the right one fills nothing elsewhere", async () => {
  const { store, id } = await vaultWith();
  const { computer, web } = await signInPage(store, "https://netflix.com.evil.example/login");
  const result = await web.call(FILL_LOGIN_TOOL, { entry: id, password_ref: 2, origin: "https://netflix.com" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /different site/);
  assert.equal(fills(computer).length, 0);
  assert.equal(leaks(result), false);
});

test("before the browser opens a page there is nothing to fill", async () => {
  const { store, id } = await vaultWith();
  const computer = fakeComputer();
  const web = webSession(computer, "sign in to netflix.com", { store });
  const result = await web.call(FILL_LOGIN_TOOL, { entry: id, password_ref: 2 });
  assert.equal(result.isError, true);
  assert.equal(computer.calls.length, 0);
});

test("a password the browser refuses to put in a non-password box comes back as a refusal, not a value", async () => {
  const { store, id } = await vaultWith();
  const { computer, web } = await signInPage(store);
  const result = await web.call(FILL_LOGIN_TOOL, { entry: id, password_ref: 1 });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not a password box/);
  assert.equal(leaks(result), false);
  assert.deepEqual(computer.typed, {});
});

test("someone else's login, or one that does not exist, is the same refusal", async () => {
  const { store, id } = await vaultWith({ people: ["user_b"] });
  const { computer, web } = await signInPage(store);
  const notYours = await web.call(FILL_LOGIN_TOOL, { entry: id, password_ref: 2 });
  const missing = await web.call(FILL_LOGIN_TOOL, { entry: newEntryId(), password_ref: 2 });
  assert.equal(notYours.content[0].text, missing.content[0].text);
  assert.equal(fills(computer).length, 0);
});

test("the model's arguments are checked before anything opens", async () => {
  const { store, id } = await vaultWith();
  const { computer, web } = await signInPage(store);
  for (const args of [{ entry: "../x", password_ref: 2 }, { entry: id }, { entry: id, password_ref: "2" }, { entry: id, password_ref: 2, username_ref: -1 }]) {
    assert.equal((await web.call(FILL_LOGIN_TOOL, args)).isError, true);
  }
  assert.equal(fills(computer).length, 0);
});

test("a shared workspace's login is opened through the grant's own routing, and a refused one does not exist", async () => {
  const own = await vaultWith();
  const team = await vaultWith({ workspaceId: "ws_team" });
  const opened = [];
  own.store.openContext = async (name) => {
    opened.push(name);
    if (name !== "@team") throw new Error("not a member");
    return { store: team.store };
  };
  const { computer, web } = await signInPage(own.store);
  const ok = await web.call(FILL_LOGIN_TOOL, { entry: team.id, password_ref: 2, context: "@team" });
  assert.notEqual(ok.isError, true);
  assert.equal(computer.typed[2], PASSWORD);
  const refused = await web.call(FILL_LOGIN_TOOL, { entry: team.id, password_ref: 2, context: "@stranger" });
  assert.equal(refused.isError, true);
  assert.deepEqual(opened, ["@team", "@stranger"]);
  // Without a context the team's entry is not in the person's own vault.
  const notHere = await web.call(FILL_LOGIN_TOOL, { entry: team.id, password_ref: 2 });
  assert.equal(notHere.isError, true);
});

test(`one question fills at most ${MAX_FILLS_PER_TURN} times`, async () => {
  const { store, id } = await vaultWith();
  const { computer, web } = await signInPage(store);
  for (let i = 0; i < MAX_FILLS_PER_TURN; i += 1) await web.call(FILL_LOGIN_TOOL, { entry: id, password_ref: 2 });
  const over = await web.call(FILL_LOGIN_TOOL, { entry: id, password_ref: 2 });
  assert.equal(over.isError, true);
  assert.equal(fills(computer).length, MAX_FILLS_PER_TURN);
});
