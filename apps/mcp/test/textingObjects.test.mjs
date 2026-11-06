// Texting with Tex held in the person object (src/workspaceStore/personTexting.js,
// docs/decisions/texting-assistant/texting-in-objects.md): a text's session opens only for a phone this person's own
// object holds; a pause or an unlink refuses the very next text and every token already open; the control plane's
// copy of connections never brings a texting token in or takes one away; and only the gateway may open a session.
import { test } from "node:test";
import assert from "node:assert/strict";

import { personRows, sessionFor } from "../src/workspaceStore/personRows.js";
import { ACCESS_HOMES, AccessRowRefused } from "../src/workspaceStore/access.js";
import { TEXTS_CLIENT_ID, TEXTING_OPS, TEXTING_TOKEN_MS } from "../src/workspaceStore/personTexting.js";
import { handleWorkspaceStoreDoor } from "../src/workspaceStore/door.js";

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

const hex = (seed) => seed.repeat(64).slice(0, 64);
const PHONE = hex("a1");
const OTHER_PHONE = hex("b2");
const NOW = 1_800_000_000_000;

/** A switched person with their own personal workspace in reach. */
function person({ switched = true, reach = true } = {}) {
  const store = personRows(durableSql());
  store.pin("user_dev");
  if (reach) store.put("reach", [{ workspaceId: "ws_dev", slug: "dev", kind: "personal", role: "owner", groups: [], at: 1 }]);
  if (switched) store.setHome(ACCESS_HOMES.OBJECT);
  return store;
}

const record = (over = {}) => ({ phoneHashes: [PHONE], paused: false, scopes: ["context:read", "context:write", "context:private"], timeZone: "America/New_York", settings: { instructions: "short" }, identity: { name: "Dev" }, at: 10, ...over });

let tokens = 0;
const open = (store, over = {}, now = NOW) => {
  tokens += 1;
  const tokenHash = hex(String(tokens).padStart(2, "0").slice(-2).replace(/[^0-9a-f]/g, "c"));
  return { tokenHash, answer: store.texting.open({ phoneHash: PHONE, tokenHash, refreshHash: hex("ee"), expiresAt: now + TEXTING_TOKEN_MS, at: now, ...over }, now) };
};

test("a linked phone opens a session the object then answers like any connection, with the zone, style and identity", { skip }, () => {
  const store = person();
  store.texting.put(record());
  const { tokenHash, answer } = open(store);
  assert.equal(answer.status, "linked");
  assert.equal(answer.workspaceId, "ws_dev");
  assert.equal(answer.timeZone, "America/New_York");
  assert.deepEqual(answer.settings, { instructions: "short" });
  assert.deepEqual(answer.identity, { name: "Dev" });
  const session = sessionFor(store, tokenHash, NOW + 1_000);
  assert.equal(session.clientId, TEXTS_CLIENT_ID);
  assert.equal(session.actorUserId, "user_dev");
  assert.equal(session.defaultWorkspaceId, "ws_dev");
  assert.deepEqual(session.scopes, record().scopes);
  assert.equal(session.workspaces[0].grantedNames, undefined, "a texting session holds no names, as the control plane's");
  assert.equal(sessionFor(store, tokenHash, NOW + TEXTING_TOKEN_MS + 1), null, "and it lives fifteen minutes");
});

test("ATTACK: a phone this person never linked gets the same miss as no record at all", { skip }, () => {
  const store = person();
  assert.deepEqual(open(store).answer, { status: "unlinked" }, "no record");
  store.texting.put(record());
  assert.deepEqual(open(store, { phoneHash: OTHER_PHONE }).answer, { status: "unlinked" });
  assert.equal(store.live("connections").length, 0, "nothing was kept for a refused phone");
});

test("a person not switched yet, or with no personal workspace of their own in reach, is never answered here", { skip }, () => {
  const before = person({ switched: false });
  before.texting.put(record());
  assert.deepEqual(open(before).answer, { status: "unlinked" });
  const homeless = person({ reach: false });
  homeless.texting.put(record());
  assert.deepEqual(open(homeless).answer, { status: "unlinked" });
});

test("ATTACK: a pause refuses the next text and every token already open, at once", { skip }, () => {
  const store = person();
  store.texting.put(record());
  const { tokenHash } = open(store);
  assert.notEqual(sessionFor(store, tokenHash, NOW + 1), null);
  const { revoked } = store.texting.put(record({ paused: true, at: 11 }));
  assert.equal(revoked, 1);
  assert.equal(sessionFor(store, tokenHash, NOW + 2), null, "the open token is refused on its very next request");
  assert.deepEqual(open(store).answer, { status: "unlinked" });
});

test("ATTACK: an unlinked phone's open token is refused at once, and another linked phone's is not touched by a later write", { skip }, () => {
  const store = person();
  store.texting.put(record({ phoneHashes: [PHONE, OTHER_PHONE] }));
  const { tokenHash } = open(store);
  store.texting.put(record({ phoneHashes: [PHONE, OTHER_PHONE], timeZone: "Europe/London", at: 11 }));
  assert.notEqual(sessionFor(store, tokenHash, NOW + 1), null, "a zone change revokes nothing");
  store.texting.put(record({ phoneHashes: [OTHER_PHONE], at: 12 }));
  assert.equal(sessionFor(store, tokenHash, NOW + 2), null);
  assert.deepEqual(open(store).answer, { status: "unlinked" });
  assert.equal(open(store, { phoneHash: OTHER_PHONE }).answer.status, "linked");
});

test("an older write never brings a removed phone back", { skip }, () => {
  const store = person();
  store.texting.put(record({ phoneHashes: [], at: 20 }));
  assert.equal(store.texting.put(record({ at: 19 })).kept, false);
  assert.deepEqual(open(store).answer, { status: "unlinked" });
});

test("ATTACK: the control plane's copy of connections never carries a texting token in, and never takes one away", { skip }, () => {
  const store = person();
  store.texting.put(record());
  const { tokenHash, answer } = open(store);
  assert.throws(() => store.put("connections", [{ grantId: "g_forged", clientId: TEXTS_CLIENT_ID, workspaceId: "ws_dev", scopes: ["context:read"], tokenHash: hex("dd"), refreshHash: hex("ef"), expiresAt: NOW + 60_000, status: "active", at: 1 }]), AccessRowRefused);
  store.snapshot("connections", { epoch: "e1", rows: [], last: true, mode: "replace" });
  assert.notEqual(sessionFor(store, tokenHash, NOW + 1), null, "a replacing copy left the texting connection alone");
  assert.equal(store.live("connections")[0].grantId, answer.grantId);
});

test("expired texting connections are dropped when the next text opens, so they never pile up", { skip }, () => {
  const store = person();
  store.texting.put(record());
  open(store, {}, NOW);
  open(store, {}, NOW + 60_000);
  assert.equal(store.live("connections").length, 2);
  open(store, {}, NOW + TEXTING_TOKEN_MS + 120_000);
  assert.equal(store.live("connections").length, 1);
});

test("a session asks for a fifteen-minute token with a refresh hash nobody holds, or is refused", { skip }, () => {
  const store = person();
  store.texting.put(record());
  assert.throws(() => open(store, { expiresAt: NOW + 24 * 60 * 60 * 1000 }), AccessRowRefused);
  assert.throws(() => open(store, { refreshHash: "nope" }), AccessRowRefused);
  assert.throws(() => store.texting.put({ ...record(), phoneHashes: ["+15555550100"] }), AccessRowRefused, "a phone is kept as its hash, never the number");
});

test("ATTACK: the control plane's door may write the record but never open a text's session", async () => {
  const env = { GATEWAY_SECRET: "gateway-secret" };
  const request = new Request("https://mcp.example/internal/workspace-store", {
    method: "POST",
    headers: { authorization: "Bearer gateway-secret", "x-workspace-ticket": "ticket", "x-tex-call": encodeURIComponent(JSON.stringify({ op: TEXTING_OPS.OPEN })) },
    body: "{}",
  });
  const response = await handleWorkspaceStoreDoor(request, env, { controlPlane: { openTexStoreTicket: async () => ({ workspaceId: "ws_dev", owners: [] }) } });
  assert.equal(response.status, 403);
});

test("the object serves the record and the session by name, and refuses a call meant for another person", { skip }, async () => {
  const { servePersonCall } = await import("../src/workspaceStore/personServe.js");
  const { workspaceRows } = await import("../src/workspaceStore/rows.js");
  const sql = durableSql();
  const store = { person: personRows(sql), rows: workspaceRows(sql) };
  store.person.pin("user_dev");
  store.person.put("reach", [{ workspaceId: "ws_dev", slug: "dev", kind: "personal", role: "owner", groups: [], at: 1 }]);
  store.person.setHome(ACCESS_HOMES.OBJECT);
  const call = async (op, fields) => await (await servePersonCall(store, op, { personalWorkspaceId: "ws_dev", ...fields }, NOW)).json();
  assert.deepEqual(await call(TEXTING_OPS.PUT, { record: record() }), { kept: true, revoked: 0 });
  assert.equal((await call(TEXTING_OPS.GET, {})).record.timeZone, "America/New_York");
  const opened = await call(TEXTING_OPS.OPEN, { phoneHash: PHONE, tokenHash: hex("0f"), refreshHash: hex("ee"), expiresAt: NOW + TEXTING_TOKEN_MS, at: NOW });
  assert.equal(opened.status, "linked");
  const elsewhere = await servePersonCall(store, TEXTING_OPS.OPEN, { personalWorkspaceId: "ws_someone_else", phoneHash: PHONE, tokenHash: hex("0e"), refreshHash: hex("ee"), expiresAt: NOW + TEXTING_TOKEN_MS }, NOW);
  assert.notEqual(elsewhere.status, 200, "an object pinned to one person never answers for another");
});
