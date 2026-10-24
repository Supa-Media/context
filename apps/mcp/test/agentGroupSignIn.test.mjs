/**
 * A group chat signs in with an email and a one-time code, and stays signed in
 * for its later asks (the owner, 2026-10-24: Tex refused a site with no
 * password, asking for a vault login that could not exist).
 *
 * The chat has its own Browserbase browser (`groupBrowserOwner`), so the code
 * texted after Tex asks lands in the same browser, and its own sealed jar in
 * the shared workspace (`browserJar.js`), filed by the chat and the exact set
 * of people in it. It never opens a person's own jar or browser.
 *
 * Sabotage record (2026-10-24): giving a group turn `computerFor(env)` again
 * fails "a group turn's browser is the chat's"; dropping `members` from the
 * jar's seal fails "somebody added to the chat starts signed out"; letting a
 * group open the personal jar key fails "a group never opens a person's own
 * jar"; dropping GROUP_CODE_SIGN_IN_LINE from the group prompt fails "the
 * group is told".
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { GROUP_JAR_PREFIX, JAR_KEY, browserJar } from "../src/agent/browserJar.js";
import { browserOwner, groupBrowserOwner, resetBrowserbaseProbe } from "../src/agent/browserProviders.js";
import { openTurnWeb } from "../src/agent/turnWeb.js";
import { GROUP_CODE_SIGN_IN_LINE, groupPrompt } from "../src/agent/groupTurn.js";
import { CODE_SIGN_IN_LINE, webPrompt } from "../src/agent/computer.js";
import { BROWSE_TOOL } from "../src/agent/browse.js";
import { FILL_LOGIN_TOOL } from "../src/agent/fillLogin.js";

const material = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");
const KEYS = { current: "k1", keys: { k1: material } };
const GROUP = { key: "a".repeat(64), members: "b".repeat(64), from: "seyi", chat: [] };
const SIGNED_IN = {
  cookies: [{ name: "sessionKey", value: "claude-s3cret", domain: ".claude.ai", path: "/", secure: true, httpOnly: true }],
  storage: {},
};

function memoryStore({ kind = "shared", workspaceId = "ws_shared" } = {}) {
  const objects = new Map();
  const store = {
    objects,
    async get(key) {
      return objects.has(key) ? { text: async () => objects.get(key) } : null;
    },
    async put(key, value) {
      objects.set(key, String(value));
    },
    actor: { workspaceId, userId: "user_a" },
    contexts: [{ current: true, kind, name: "supa" }],
  };
  Object.defineProperty(store, "encryptionKey", { value: KEYS, enumerable: false });
  return store;
}

test("a group chat's sign-ins are sealed in its shared workspace, never at the person's jar", async () => {
  const store = memoryStore();
  await browserJar(store, { group: GROUP }).save(SIGNED_IN);
  const keys = [...store.objects.keys()];
  assert.equal(keys.length, 1);
  assert.ok(keys[0].startsWith(GROUP_JAR_PREFIX), keys[0]);
  assert.notEqual(keys[0], JAR_KEY);
  assert.equal(store.objects.get(keys[0]).includes("claude-s3cret"), false, "the bucket alone never yields the sign-in");
  assert.deepEqual(await browserJar(store, { group: GROUP }).load(), SIGNED_IN);
});

test("somebody added to the chat starts signed out, and another chat never opens it", async () => {
  const store = memoryStore();
  await browserJar(store, { group: GROUP }).save(SIGNED_IN);
  const [key] = store.objects.keys();
  const sealed = store.objects.get(key);
  for (const other of [{ ...GROUP, members: "c".repeat(64) }, { ...GROUP, key: "d".repeat(64) }]) {
    assert.equal(await browserJar(store, { group: other }).load(), null);
    // Even the sealed bytes copied to where that chat's jar would be do not open.
    const copy = memoryStore();
    await browserJar(copy, { group: other }).save({ cookies: [], storage: { "https://x.example": { t: "1" } } });
    const [otherKey] = copy.objects.keys();
    copy.objects.set(otherKey, sealed);
    assert.equal(await browserJar(copy, { group: other }).load(), null);
  }
});

test("a group never opens a person's own jar, and a person's turn never opens a chat's", async () => {
  const personal = memoryStore({ kind: "personal", workspaceId: "ws_shared" });
  await browserJar(personal).save(SIGNED_IN);
  // A group's jar is only ever a shared workspace's.
  assert.equal(browserJar(personal, { group: GROUP }), null);
  const shared = memoryStore();
  assert.equal(browserJar(shared), null);
  // The person's sealed jar copied to the chat's place does not open as the chat's.
  await browserJar(shared, { group: GROUP }).save({ cookies: [], storage: { "https://x.example": { t: "1" } } });
  const [chatKey] = shared.objects.keys();
  shared.objects.set(chatKey, personal.objects.get(JAR_KEY));
  assert.equal(await browserJar(shared, { group: GROUP }).load(), null);
  assert.equal(browserJar(shared, { group: { ...GROUP, members: "not-a-hash" } }), null);
});

test("a chat's browser tag is its own: never a person's, and new when the people change", async () => {
  const env = { GATEWAY_SECRET: "test-secret" };
  const chat = await groupBrowserOwner(env, GROUP);
  assert.match(chat, /^[0-9a-f]{64}$/);
  assert.notEqual(chat, await browserOwner(env, "user_a"));
  assert.notEqual(chat, await groupBrowserOwner(env, { ...GROUP, members: "c".repeat(64) }));
  assert.equal(chat, await groupBrowserOwner(env, { ...GROUP }));
  assert.equal(await groupBrowserOwner({}, GROUP), null);
  assert.equal(await groupBrowserOwner(env, null), null);
});

test("a group turn's browser is the chat's: Browserbase by the chat's tag, with the chat's jar, carried on in the next turn", async () => {
  resetBrowserbaseProbe();
  const store = memoryStore();
  const sent = [];
  const SITE_SHOTS = {
    async fetch(_url, init) {
      const body = JSON.parse(init.body);
      sent.push(body);
      return Response.json({
        session: "bb-group",
        ran: body.steps.map((s) => ({ do: s.do, ok: true })),
        page: { url: "https://claude.ai/login", title: "Claude", text: "Enter the code we emailed you", elements: [] },
        jar: SIGNED_IN,
      });
    },
  };
  const env = { SITE_SHOTS, GATEWAY_SECRET: "test-secret" };
  const session = { actorUserId: "user_a", workspaceId: "ws_shared", egress: {} };
  const ledger = { tainted: true };
  const ASK = "Tex sign in at https://claude.ai/login as dev2@example.com";
  const open = () => openTurnWeb(env, { session, texting: false, group: GROUP, question: ASK, vouched: ASK, channel: null, store, dispatch: null, ledger });

  const first = await open();
  assert.ok(first.web.tools.some((tool) => tool.name === BROWSE_TOOL));
  await first.web.call(BROWSE_TOOL, { steps: [{ do: "goto", url: "https://claude.ai/login" }] });
  assert.equal(sent[0].provider, "browserbase");
  assert.equal(sent[0].owner, await groupBrowserOwner(env, GROUP));
  assert.notEqual(sent[0].owner, await browserOwner(env, "user_a"));
  assert.equal(sent[0].keep, true);

  // The code comes in a later text: the next turn carries on in the same browser, signed-in jar sent along.
  const second = await open();
  const resumed = await second.web.call(BROWSE_TOOL, { steps: [{ do: "read" }] });
  assert.notEqual(resumed.isError, true, JSON.stringify(resumed));
  assert.equal(sent[1].owner, sent[0].owner);
  assert.deepEqual(sent[1].jar, SIGNED_IN);
});

test("the group is told a code sign-in needs no saved login, and a person's own texts are too", () => {
  const told = groupPrompt(GROUP, "supa");
  assert.ok(told.includes(GROUP_CODE_SIGN_IN_LINE));
  assert.match(told, /stays signed in for this chat's later asks/);
  assert.match(told, /never typed in the chat/);
  assert.doesNotMatch(told, /You can sign in only with a login saved/);
  assert.ok(webPrompt(new Set([BROWSE_TOOL, FILL_LOGIN_TOOL])).includes(CODE_SIGN_IN_LINE));
});
