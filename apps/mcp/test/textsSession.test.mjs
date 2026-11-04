// A text's session answered by the person object over the gateway's `TexTexts` entrypoint (src/agent/textsSession.js,
// docs/decisions/texting-assistant/texting-in-objects.md): the phone is kept only as a keyed hash, a workspace id is a
// locator and never proof, every miss is the same "unlinked" so the Worker falls back to Convex, Convex keeps its copy of
// the grant (and its say on whether the phone is linked) before the token goes out, and who is texting comes from the object instead of Convex.
import { test } from "node:test";
import assert from "node:assert/strict";

import { openTextsSession, textingPhoneHash, TEXTS_SESSION_PATH } from "../src/agent/textsSession.js";
import { TexTexts } from "../src/index.js";
import { personRows, sessionFor } from "../src/workspaceStore/personRows.js";
import { ACCESS_HOMES, parseToken } from "../src/workspaceStore/access.js";
import { TEXTING_TOKEN_MS } from "../src/workspaceStore/personTexting.js";
import { normalizeSession } from "../src/sessionPayload.js";
import { texterIdentity } from "../src/agent/identity.js";
import { sha256Hex } from "../src/controlPlane/client.js";

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = null;
}
const skip = DatabaseSync === null ? "node:sqlite is not in this Node" : false;

function durableSql() {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query, ...binds) {
      const statement = db.prepare(query);
      if (/^\s*SELECT/i.test(query)) {
        const all = statement.all(...binds);
        return { toArray: () => all };
      }
      statement.run(...binds);
      return { toArray: () => [] };
    },
  };
}

const SECRET = "a-test-gateway-secret-of-length";
const env = { GATEWAY_SECRET: SECRET };
const PHONE = "+15555550100";
const NOW = 1_800_000_000_000;
const IDENTITY = { name: "Dev", handle: "dev", phones: [PHONE], emails: ["dev@example.com"], google: [] };

/** Two switched people, each with their own object, keyed by personal workspace id. */
async function people({ devPhones = [PHONE] } = {}) {
  const objects = new Map();
  for (const [id, user, phones] of [["ws_dev", "user_dev", devPhones], ["ws_eve", "user_eve", []]]) {
    const store = personRows(durableSql());
    store.pin(user);
    store.put("reach", [{ workspaceId: id, slug: id.slice(3), kind: "personal", role: "owner", groups: [], at: 1 }]);
    store.setHome(ACCESS_HOMES.OBJECT);
    const hashes = await Promise.all(phones.map((phone) => textingPhoneHash(SECRET, phone)));
    store.texting.put({ phoneHashes: hashes, paused: false, scopes: ["context:read", "context:write"], timeZone: "America/New_York", settings: { instructions: "short" }, identity: id === "ws_dev" ? IDENTITY : null, at: 10 });
    objects.set(id, store);
  }
  // The access client's shape, answered by the object's own code (`personServe.js` does the same in the object).
  const client = (_env, id) => {
    const store = objects.get(id);
    return store === undefined ? null : { texting: { open: async (fields) => store.texting.open(fields, NOW) } };
  };
  return { objects, client };
}

function ask(body, { path = TEXTS_SESSION_PATH, method = "POST" } = {}) {
  return new Request(`https://texts.internal${path}`, { method, ...(method === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}) });
}

/** Convex's copy: says linked unless told otherwise, and records what it was sent. */
function recorder(status = "linked") {
  const told = [];
  return { told, copy: () => async (fields) => (told.push(fields), { status }), ctx: {} };
}

test("a phone is kept as a keyed hash: fixed for one secret, another for another, never the number's plain sha256", async () => {
  const hash = await textingPhoneHash(SECRET, PHONE);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(await textingPhoneHash(SECRET, PHONE), hash);
  assert.notEqual(await textingPhoneHash(`${SECRET}-rotated`, PHONE), hash);
  assert.notEqual(hash, await sha256Hex(PHONE), "a plain hash of a phone number is a lookup table away from the number");
  // The vector Convex's copy is checked against (apps/convex), so the two hashes of one phone always agree.
  assert.equal(hash, "d98dc104c427289014f707f6544084189bf388eeeaf7ca46a53687a9a6220f46");
  assert.equal(await textingPhoneHash(undefined, PHONE), null, "no secret, no hash, so every phone is unlinked here");
  assert.equal(await textingPhoneHash(SECRET, "5555550100"), null, "only an E.164 number");
});

test("a linked phone gets a fifteen-minute token naming its own object, with the zone and style, once Convex keeps its copy", { skip }, async () => {
  const { objects, client } = await people();
  const { told, copy, ctx } = recorder();
  const response = await openTextsSession(ask({ phone: PHONE, personalWorkspaceId: "ws_dev" }), env, ctx, { objects: client, copy, now: () => NOW });
  const answer = await response.json();
  assert.equal(answer.status, "linked");
  assert.equal(answer.timeZone, "America/New_York");
  assert.deepEqual(answer.settings, { instructions: "short" });
  assert.equal(answer.personalWorkspaceId, "ws_dev");
  assert.deepEqual(parseToken(answer.accessToken), { format: "object", kind: "access", personalWorkspaceId: "ws_dev" });
  const tokenHash = await sha256Hex(answer.accessToken);
  const session = sessionFor(objects.get("ws_dev"), tokenHash, NOW + 1_000);
  assert.equal(session.actorUserId, "user_dev");
  assert.equal(session.expiresAt, NOW + TEXTING_TOKEN_MS);
  assert.deepEqual(session.texterIdentity, IDENTITY, "who is texting rides on the session, from the object");
  assert.equal(told.length, 1);
  assert.equal(told[0].hashedAccessToken, tokenHash);
  assert.equal(told[0].personalWorkspaceId, "ws_dev");
  assert.equal(JSON.stringify(told[0]).includes(answer.accessToken), false, "Convex is told the hash, never the token");
});

test("ATTACK: a phone Convex no longer counts as linked gets no token, whatever the object still holds", { skip }, async () => {
  const { client } = await people();
  const { copy, ctx } = recorder("unlinked");
  const response = await openTextsSession(ask({ phone: PHONE, personalWorkspaceId: "ws_dev" }), env, ctx, { objects: client, copy, now: () => NOW });
  assert.deepEqual(await response.json(), { status: "unlinked" }, "an unlink or a pause the object has not caught up on still refuses");
});

test("ATTACK: a workspace id that names somebody else's object is the same miss, and that object keeps nothing", { skip }, async () => {
  const { objects, client } = await people();
  const { told, copy, ctx } = recorder();
  const response = await openTextsSession(ask({ phone: PHONE, personalWorkspaceId: "ws_eve" }), env, ctx, { objects: client, copy, now: () => NOW });
  assert.deepEqual(await response.json(), { status: "unlinked" });
  assert.equal(objects.get("ws_eve").live("connections").length, 0);
  assert.equal(told.length, 0, "and Convex is told nothing");
  const nobody = await openTextsSession(ask({ phone: PHONE, personalWorkspaceId: "ws_nobody" }), env, ctx, { objects: client, copy, now: () => NOW });
  assert.deepEqual(await nobody.json(), { status: "unlinked" }, "an id with no object reads the same as one that refused");
});

test("ATTACK: a phone hashed under another secret never matches, so a leaked record opens nothing elsewhere", { skip }, async () => {
  const { client } = await people();
  const { copy, ctx } = recorder();
  const response = await openTextsSession(ask({ phone: PHONE, personalWorkspaceId: "ws_dev" }), { GATEWAY_SECRET: `${SECRET}-other` }, ctx, { objects: client, copy, now: () => NOW });
  assert.deepEqual(await response.json(), { status: "unlinked" });
  const unset = await openTextsSession(ask({ phone: PHONE, personalWorkspaceId: "ws_dev" }), {}, ctx, { objects: client, copy, now: () => NOW });
  assert.deepEqual(await unset.json(), { status: "unlinked" });
});

test("an object that cannot answer, or a Convex that cannot keep its copy, is a miss the Worker falls back from", { skip }, async () => {
  const { copy, ctx } = recorder();
  const down = () => ({ texting: { open: async () => { throw new Error("object down"); } } });
  assert.deepEqual(await (await openTextsSession(ask({ phone: PHONE, personalWorkspaceId: "ws_dev" }), env, ctx, { objects: down, copy, now: () => NOW })).json(), { status: "unlinked" });
  const { client } = await people();
  const failing = () => async () => { throw new Error("convex down"); };
  const answer = await (await openTextsSession(ask({ phone: PHONE, personalWorkspaceId: "ws_dev" }), env, {}, { objects: client, copy: failing, now: () => NOW })).json();
  assert.deepEqual(answer, { status: "unlinked" }, "a token Convex has no copy of would fail every control-plane call it carries");
});

test("anything but a well-formed ask on the one path is refused before any object is opened", async () => {
  let opened = 0;
  const objects = () => {
    opened += 1;
    return null;
  };
  const call = (request) => openTextsSession(request, env, {}, { objects, copy: () => async () => ({ status: "linked" }), now: () => NOW });
  assert.equal((await call(ask({ phone: PHONE, personalWorkspaceId: "ws_dev" }, { path: "/agent" }))).status, 404);
  assert.equal((await call(ask(null, { method: "GET" }))).status, 400);
  assert.equal((await call(ask("not json"))).status, 400);
  assert.equal((await call(ask({ phone: "555", personalWorkspaceId: "ws_dev" }))).status, 400);
  assert.equal((await call(ask({ phone: PHONE, personalWorkspaceId: "../ws_dev" }))).status, 400);
  assert.equal((await call(ask({ phone: PHONE, personalWorkspaceId: "ws_dev", pad: "x".repeat(2048) }))).status, 400);
  assert.equal(opened, 0);
});

test("the gateway exports the entrypoint the texting Worker binds to", () => {
  assert.equal(typeof TexTexts.fetch, "function");
});

test("who is texting is read off a text's session, never asked of Convex, and only a text's session carries it", async () => {
  const raw = { grantId: "texts_x", clientId: "context_texts", actorUserId: "user_dev", scopes: ["context:read"], workspaces: [{ workspaceId: "ws_dev", role: "owner", kind: "personal" }], defaultWorkspaceId: "ws_dev", texterIdentity: IDENTITY };
  assert.deepEqual(normalizeSession(raw).texterIdentity, IDENTITY);
  assert.equal(normalizeSession({ ...raw, clientId: "claude" }).texterIdentity, undefined, "another client's session never carries one");
  assert.equal(normalizeSession({ ...raw, texterIdentity: "Dev" }).texterIdentity, undefined);
  let asked = 0;
  const controlPlane = { texterIdentity: async () => { asked += 1; return null; } };
  assert.equal((await texterIdentity(controlPlane, { accessToken: "t", workspaceId: "ws_dev", texterIdentity: IDENTITY })).name, "Dev");
  assert.equal(await texterIdentity(controlPlane, { accessToken: "t", workspaceId: "ws_dev", texterIdentity: null }), null, "an object with no identity yet is nobody known, still without Convex");
  assert.equal(asked, 0);
});
