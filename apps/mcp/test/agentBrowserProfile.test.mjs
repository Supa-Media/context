/**
 * Tex's saved Browserbase profile, the default home of its browser's
 * sign-ins, with the sealed jar kept beside it (`src/agent/browserProfile.js`;
 * decided by the owner, 2026-10-29).
 *
 * Sabotage record (2026-10-29): sending `profileNew` on every call fails "a
 * new profile is given the jar's cookies once"; letting `browseResult` pass
 * `profileGone` on fails "a lost profile is released…"; dropping the jar's
 * `forget` from `signOut` fails "signing Tex out lets the browser go…".
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { JAR_KEY, browserJar } from "../src/agent/browserJar.js";
import { browserProfile } from "../src/agent/browserProfile.js";
import { resetBrowserbaseProbe, siteShotsComputer } from "../src/agent/browserProviders.js";
import { computerFor, webSession } from "../src/agent/computer.js";

const OWNER = "a".repeat(64);
const PROFILE = "0b6c0e3e-7a43-4b1e-9d0a-2f5a1c9e8d71";
const material = Buffer.from(new Uint8Array(32).fill(9)).toString("base64");
const KEYS = { current: "k1", keys: { k1: material } };
const READ = { cookies: [{ name: "sid", value: "s3cret", domain: ".app.example", path: "/" }], storage: {} };

function memoryStore({ kind = "personal", answer = { profileId: PROFILE, created: true } } = {}) {
  const objects = new Map();
  const asked = [];
  const store = {
    objects,
    asked,
    async get(key) {
      return objects.has(key) ? { text: async () => objects.get(key) } : null;
    },
    async put(key, value) {
      objects.set(key, String(value));
    },
    async delete(key) {
      objects.delete(key);
    },
    actor: { workspaceId: "ws_1", userId: "user_a" },
    contexts: [{ current: true, kind, name: "seyi" }],
    browserProfiles: {
      async get(owner, chat) {
        asked.push({ get: owner, chat });
        if (answer instanceof Error) throw answer;
        return answer;
      },
      async forget(owner) {
        asked.push({ forget: owner });
        return { forgotten: 1 };
      },
    },
  };
  Object.defineProperty(store, "encryptionKey", { value: KEYS, enumerable: false });
  return store;
}

function browser(replies = []) {
  const sent = [];
  const binding = {
    async fetch(url, init) {
      const body = JSON.parse(init.body);
      sent.push({ path: new URL(url).pathname, body });
      const extra = replies.shift() ?? {};
      return Response.json({ session: "bb-1", ran: [{ do: "read", ok: true }], page: { url: "https://app.example/", title: "App", text: "Hi", elements: [] }, jar: READ, ...extra });
    },
  };
  return { sent, env: { SITE_SHOTS: binding } };
}

test("the browser opens the person's profile; a new profile is given the jar's cookies once", async () => {
  resetBrowserbaseProbe();
  const store = memoryStore();
  const { sent, env } = browser();
  const computer = siteShotsComputer(env, { owner: OWNER, jar: browserJar(store), profile: browserProfile(store, { owner: OWNER }) });
  const result = await computer.browse(null, [{ do: "read" }]);
  await computer.browse("bb-1", [{ do: "read" }]);
  assert.equal(sent[0].body.profile, PROFILE);
  assert.equal(sent[0].body.profileNew, true);
  assert.equal(sent[1].body.profile, PROFILE);
  assert.equal(sent[1].body.profileNew, undefined);
  // Asked for once a question, and never shown to the turn.
  assert.equal(store.asked.filter((a) => a.get).length, 1);
  assert.equal(JSON.stringify(result).includes(PROFILE), false);
  // The jar is still sealed after the run: the fallback and the copy the person leaves with.
  assert.ok(store.objects.get(JAR_KEY));
});

test("a lost profile is released, the answer says nothing of it, and the next question asks again", async () => {
  resetBrowserbaseProbe();
  const store = memoryStore();
  const { env } = browser([{ profileGone: true }]);
  const profile = browserProfile(store, { owner: OWNER });
  const result = await siteShotsComputer(env, { owner: OWNER, jar: browserJar(store), profile }).browse(null, [{ do: "read" }]);
  assert.equal("profileGone" in result, false);
  assert.deepEqual(store.asked.at(-1), { forget: OWNER });
  assert.equal(await profile.load(), null);
});

test("a control plane that cannot answer leaves the browser on the jar", async () => {
  resetBrowserbaseProbe();
  const store = memoryStore({ answer: new Error("down") });
  const { sent, env } = browser();
  await siteShotsComputer(env, { owner: OWNER, jar: browserJar(store), profile: browserProfile(store, { owner: OWNER }) }).browse(null, [{ do: "read" }]);
  assert.equal(sent[0].body.profile, undefined);
  assert.equal(sent[0].body.keep, true);
});

test("a group chat's profile is asked for with the chat's hash, never its key, and only where its jar is kept", async () => {
  const group = { key: "c".repeat(64), members: "d".repeat(64) };
  const shared = memoryStore({ kind: "shared" });
  await browserProfile(shared, { owner: OWNER, group }).load();
  assert.match(shared.asked[0].chat, /^[0-9a-f]{64}$/);
  assert.notEqual(shared.asked[0].chat, group.key);
  // A shared workspace's turn with no chat keeps no jar, so asks for no profile.
  resetBrowserbaseProbe();
  const { sent, env } = browser();
  await computerFor(env, { owner: OWNER, store: memoryStore({ kind: "shared" }) }).browse(null, [{ do: "read" }]);
  assert.equal(sent[0].body.profile, undefined);
  assert.equal(browserProfile({}, { owner: OWNER }), null);
  assert.equal(browserProfile(shared, { owner: "user_1" }), null);
});

test("signing Tex out lets the browser go, releases the profile and drops the jar", async () => {
  resetBrowserbaseProbe();
  const store = memoryStore();
  await browserJar(store).save(READ);
  const { sent, env } = browser();
  const web = webSession(computerFor(env, { owner: OWNER, store }), "sign out of everything", { store });
  assert.ok(web.tools.some((tool) => tool.name === "sign_out_browser"));
  const answer = await web.call("sign_out_browser", {});
  assert.equal(answer.isError, undefined);
  assert.deepEqual(sent[0], { path: "/browse/close", body: { provider: "browserbase", owner: OWNER } });
  assert.deepEqual(store.asked.at(-1), { forget: OWNER });
  assert.equal(store.objects.has(JAR_KEY), false);
  assert.equal(await browserJar(store).load(), null);
});

test("no browser, no sign-out tool", () => {
  const web = webSession(null, "sign out", {});
  assert.equal(web.tools.some((tool) => tool.name === "sign_out_browser"), false);
});
