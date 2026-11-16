// The Lab test chat's other iMessage events (src/labSandbox/inbound.js; docs/decisions/texting-assistant/lab-sandbox.md):
// a text with pictures, a quoted reply, a tapback and an edit, each turned into its ledger event and its `/agent` body
// by the texting Worker's own code (`apps/agent/src/gatewayInbound.js`), as a real one is. Fake ids, words and hosts.
//
// Sabotage (temporary local edits, reverted, 2026-11-16):
//   inbound.js `reactionOf` running every 1:1 tapback          "a ❤️ on a plain text is only noted ..." fails
//   route.js `react` marking a tapback noted itself again      "a tapback goes to the chat object ..." fails
//   inbound.js `pictureFetch` following a redirect unchecked   "a redirect to an address is never followed" fails
//   route.js `addRow` running on the config read at open      "every turn runs the draft as saved now ..." fails
//   route.js `retry` cutting before its checks                 "... a retry that is refused cuts nothing" fails
//   route.js `addRow` cutting without reading `running` again   "... a retry that is refused cuts nothing" fails
//   inbound.js `capped` returning the response as it came      "a picture over 5 MB is not read" fails

import { test } from "node:test";
import assert from "node:assert/strict";

import { LabSandboxObject } from "../src/labSandbox/object.js";
import { callSandbox } from "../src/labSandbox/object.js";
import { inboundEvent, reactionOf, TAPBACK_OF } from "../src/labSandbox/inbound.js";
import { turnRequestBody } from "../src/labSandbox/harness.js";
import { handleLabSandbox, oneRowPerText } from "../src/labSandbox/route.js";
import { guideText } from "../src/texDev/guide.js";
import { durableSql } from "./texStoreFixture.mjs";

const KEY = "a".repeat(64);
const EID = (n) => `17000000000${String(n).padStart(2, "0")}-0000${String(n).padStart(2, "0")}`;

/** PNG bytes with a 4 × 3 header: enough for the Worker's sniff and size check. */
function png() {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, 4);
  new DataView(bytes.buffer).setUint32(20, 3);
  return bytes;
}

/** A picture host: `/a.png` is a PNG, `/hop` redirects to an address, anything else is a 404. */
function pictureHost(seen = []) {
  return async (url, init = {}) => {
    seen.push({ url: String(url), redirect: init.redirect });
    const path = new URL(String(url)).pathname;
    if (path === "/a.png") return new Response(png(), { headers: { "content-type": "image/png" } });
    if (path === "/big.png") return new Response(png(), { headers: { "content-type": "image/png", "content-length": "6000000" } });
    if (path === "/huge.png") return new Response(new Uint8Array(5_100_000), { headers: { "content-type": "image/png" } });
    if (path === "/hop") return new Response(null, { status: 302, headers: { location: "https://10.0.0.1/a.png" } });
    return new Response("nope", { status: 404 });
  };
}

const ONE = { kind: "one" };
const GROUP = { kind: "group", chatKey: KEY, members: "b".repeat(64), people: [{ handle: "ana", name: "Ana" }, { handle: "kai", name: "Kai" }] };

test("a picture text is logged as a picture and its pictures reach the turn as the Worker prepares them", async () => {
  const row = { id: "t1", eid: EID(1), who: "You", text: "", at: 1, prod: false, pics: [{ url: "https://img.example.test/a.png" }, { url: "https://img.example.test/gone.png", name: "gone.png" }] };
  const event = await inboundEvent({ about: ONE, row, rows: [row] });
  assert.equal(event.event, "picture");
  assert.equal(event.text, "");
  const body = await turnRequestBody({ about: ONE, row, rows: [row], turn: "labturn01", fetch: pictureHost() });
  assert.equal(body.question, "");
  assert.equal(body.attachments.length, 2);
  assert.equal(body.attachments[0].mediaType, "image/png");
  assert.equal(typeof body.attachments[0].data, "string");
  assert.match(body.attachments[1].unread, /download failed/, "a picture that would not download is said, as the Worker says it");
});

test("a redirect to an address is never followed", async () => {
  const seen = [];
  const row = { id: "t1", eid: EID(1), who: "You", text: "look", at: 1, prod: false, pics: [{ url: "https://img.example.test/hop" }] };
  const body = await turnRequestBody({ about: ONE, row, rows: [row], turn: "labturn01", fetch: pictureHost(seen) });
  assert.ok(body.attachments[0].unread, "no bytes from the address");
  assert.deepEqual(seen.map((s) => s.url), ["https://img.example.test/hop"]);
  assert.equal(seen[0].redirect, "manual");
});

test("a picture over 5 MB is not read, whether it says its size or not", async () => {
  const row = { id: "t1", eid: EID(1), who: "You", text: "look", at: 1, prod: false, pics: [{ url: "https://img.example.test/big.png" }, { url: "https://img.example.test/huge.png" }] };
  const body = await turnRequestBody({ about: ONE, row, rows: [row], turn: "labturn01", fetch: pictureHost() });
  assert.equal(body.attachments.length, 2);
  for (const a of body.attachments) assert.equal(a.unread, "It is over the 5 MB a Lab test picture can be.", "no bytes past the ceiling, and the turn told why");
});

test("a quoted reply names the text it answers: its words in a 1:1, Tex's words or only that it was one in a group", async () => {
  const rows = [
    { id: "r1", eid: EID(1), who: "Tex", text: "Dinner is at 7.", at: 1, prod: true },
    { id: "r2", eid: EID(2), who: "ana", text: "I'll bring pie", at: 2, prod: true },
  ];
  const one = { id: "t3", eid: EID(3), who: "You", text: "make it 8", at: 3, prod: false, replyTo: "r1" };
  const event = await inboundEvent({ about: ONE, row: one, rows: [...rows, one] });
  assert.equal(event.replyTo, EID(1));
  assert.equal(event.quoted, "Dinner is at 7.");
  assert.equal((await turnRequestBody({ about: ONE, row: one, rows: [...rows, one], turn: "labturn01" })).quoted, "Dinner is at 7.");
  const onTex = { ...one, who: "kai" };
  const groupBody = await turnRequestBody({ about: GROUP, row: onTex, rows: [...rows, onTex], turn: "labturn02" });
  assert.equal(groupBody.quoted, "Dinner is at 7.");
  const onAna = { ...one, who: "kai", replyTo: "r2" };
  const replied = await turnRequestBody({ about: GROUP, row: onAna, rows: [...rows, onAna], turn: "labturn03" });
  assert.equal(replied.quoted, undefined, "a group reply under a person's text never carries their words");
  assert.equal(replied.replied, true);
  assert.deepEqual(replied.group.chat, [{ from: "ana", text: "I'll bring pie" }], "the chat since Tex's last text, the asked text left out");
});

test("a tapback is logged as its line; a ❓ runs the turn as the tapback; a ❤️ on a plain text is only noted and goes with the next text", async () => {
  assert.deepEqual(Object.keys(TAPBACK_OF), ["❤️", "👍", "👎", "😂", "‼️", "❓"]);
  const tex = { id: "r1", eid: EID(1), who: "Tex", text: "Booked the table for 7.", at: 1, prod: true };
  const asked = await reactionOf({ about: ONE, target: tex, emoji: "❓", as: "You", rows: [tex] });
  assert.equal(asked.runs, true);
  assert.equal(asked.line, '❓ on Tex\'s message "Booked the table for 7."');
  const row = { id: "t2", eid: EID(2), who: "You", kind: "reaction", emoji: "❓", on: "r1", text: asked.line, at: 2, prod: false };
  const event = await inboundEvent({ about: ONE, row, rows: [tex, row] });
  assert.equal(event.event, "reaction");
  assert.equal(event.text, asked.line);
  const body = await turnRequestBody({ about: ONE, row, rows: [tex, row], turn: "labturn01" });
  assert.equal(body.question, "❓");
  assert.equal(body.quoted, "Booked the table for 7.");
  assert.equal(body.tapback, "Questioned");

  const loved = await reactionOf({ about: ONE, target: tex, emoji: "❤️", as: "You", rows: [tex] });
  assert.equal(loved.runs, false, "Messages' ❤️ on a text that asks nothing is noted, never answered");
  const noted = { id: "t3", eid: EID(3), who: "You", kind: "reaction", emoji: "❤️", on: "r1", text: loved.line, at: 3, prod: false, noted: true };
  const next = { id: "t4", eid: EID(4), who: "You", text: "thanks", at: 4, prod: false };
  const later = await turnRequestBody({ about: ONE, row: next, rows: [tex, noted, next], turn: "labturn02" });
  assert.deepEqual(later.reacted, [{ how: "Loved", words: "Booked the table for 7." }]);
  assert.equal((await reactionOf({ about: ONE, target: { ...tex, text: "Want me to book it?" }, emoji: "👍", as: "You", rows: [tex] })).runs, true, "a 👍 on a question is its answer");
});

test("a group tapback reads on as its line; the asker's 👍 on Tex's ask goes as the tapback", async () => {
  const ask = { id: "r2", eid: EID(2), who: "Tex", text: "Here's the email I'd send. Give this a 👍 and I'll send it.", at: 2, prod: false, reply: "t1" };
  const rows = [{ id: "t1", eid: EID(1), who: "kai", text: "@tex email the coach", at: 1, prod: false }, ask];
  const other = await reactionOf({ about: GROUP, target: ask, emoji: "👍", as: "ana", rows });
  assert.equal(other.runs, true);
  const line = { id: "t3", eid: EID(3), who: "ana", kind: "reaction", emoji: "👍", on: "r2", text: other.line, at: 3, prod: false };
  const read = await turnRequestBody({ about: GROUP, row: line, rows: [...rows, line], turn: "labturn01" });
  assert.equal(read.question, other.line);
  assert.equal(read.tapback, undefined, "somebody else's 👍 is never the asker's yes");
  const own = { ...line, who: "kai" };
  const held = await turnRequestBody({ about: GROUP, row: own, rows: [...rows, own], turn: "labturn02" });
  assert.equal(held.question, "👍");
  assert.equal(held.tapback, "Liked");
  assert.equal(held.group.from, "kai");
});

/** The route over a fake control plane and a turn that only records what it was handed. */
function routeWorld() {
  const objects = new Map();
  const ns = {
    idFromName: (name) => ({ name }),
    get: (id) => ({
      fetch: (request) => {
        if (!objects.has(id.name)) objects.set(id.name, new LabSandboxObject({ storage: { sql: durableSql(), setAlarm: async () => {}, deleteAlarm: async () => {}, deleteAll: async () => {} } }));
        return objects.get(id.name).fetch(request);
      },
    }),
  };
  const env = { LAB_SANDBOX: ns, CONTROL_PLANE_URL: "https://control.example.invalid", GATEWAY_SECRET: "gw-secret-example-not-real-000000" };
  const original = globalThis.fetch;
  const testDraft = { id: "secret-test", set: "test", kind: "one", members: [], msgs: [{ id: "m1", who: "You", text: "x" }] };
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const answer = (value) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
    if (!String(url).endsWith("/gateway/tex/lab-sandbox")) return answer({});
    if (body.accessToken !== ALICE) return answer({ status: "refused" });
    if (body.action === "who") return answer({ status: "ok", userId: "u_alice", chats: [{ key: KEY, name: "Team", people: 3 }] });
    if (body.action === "set") return answer(body.args.id === "secret-test" ? { status: "ok", conv: JSON.stringify(testDraft) } : { status: "not_found" });
    if (body.action === "sets") return answer({ status: "ok", drafts: [{ id: "fresh-one", set: "dev", conv: JSON.stringify({ id: "fresh-one", title: "Fresh", set: "dev", kind: "group", members: ["Mia", "Kai"], msgs: [{ id: "m1", who: "Mia", text: "hi" }] }) }] });
    if (body.action === "draft") await world.onDraft?.();
    if (body.action === "draft") return answer(world.draft ? { status: "ok", graph: JSON.stringify(world.draft) } : { status: "not_found" });
    if (body.action === "session") {
      const session = { grantId: "g1", clientId: "context_texts", actorUserId: "u_alice", scopes: ["context:read"], defaultWorkspaceId: "ws_alice", workspaces: [{ workspaceId: "ws_alice", role: "owner", kind: "personal", slug: "alfa" }] };
      if (body.args.chat === "me") return answer({ status: "ok", session, people: [{ handle: "alfa", name: "You" }] });
      if (body.args.chat === KEY) return answer({ status: "ok", session, people: [{ handle: "ana", name: "Ana" }, { handle: "kai", name: "Kai" }], chat: { slug: "team", engagement: "helpful", engagementChosen: true } });
      return answer({ status: "not_found", error: "There is no such chat." });
    }
    return answer({ status: "bad_request" });
  };
  const turns = [];
  // A turn that answers at once: what the route handed it kept, its reply row written, the chat let go.
  const runTurn = async (args) => {
    turns.push(args);
    await callSandbox(args.stub, "row.add", { row: { id: `${args.row.id}r`, eid: EID(90 + turns.length), reply: args.row.id, who: "Tex", text: `answer ${turns.length}`, at: Date.now(), prod: false } });
    await callSandbox(args.stub, "meta", { key: "running", value: null });
  };
  const call = async (body) => {
    const response = await handleLabSandbox(new Request("https://gateway.example.invalid/tex-lab/sandbox", { method: "POST", headers: { authorization: `Bearer ${ALICE}`, "content-type": "application/json" }, body: JSON.stringify(body) }), env, null, { runTurn });
    return { status: response.status, body: await response.json() };
  };
  const sends = async () => {
    const index = await callSandbox(ns.get(ns.idFromName("labsandbox:u_alice:index0000000000")), "state", {});
    return Number(index.meta[`sends:${new Date().toISOString().slice(0, 10)}`] ?? 0);
  };
  // The chat's own object (not the per-person index), to change under a call in flight.
  const chat = () => ns.get({ name: [...objects.keys()].find((k) => !k.endsWith("index0000000000")) });
  const world = { call, turns, sends, chat, draft: null, onDraft: null, restore: () => (globalThis.fetch = original) };
  return world;
}

const ALICE = "tok_alice_example_000000000000";

test("pictures, replies, tapbacks, edits and unsends are refused when they are not what a chat can carry", async () => {
  const w = routeWorld();
  try {
    const { body: opened } = await w.call({ op: "open", source: "maya" });
    const sandboxId = opened.sandboxId;
    const real = opened.rows[0].id;
    const pic = (url) => ({ url });
    assert.equal((await w.call({ op: "send", sandboxId, text: "", pics: [pic("http://img.example.test/a.png")] })).status, 400, "http is refused");
    assert.equal((await w.call({ op: "send", sandboxId, text: "", pics: [pic("https://10.0.0.1/a.png")] })).status, 400, "an address is refused");
    assert.equal((await w.call({ op: "send", sandboxId, text: "x", pics: [{ url: "https://img.example.test/a.svg", type: "image/svg+xml" }] })).status, 400, "only picture types");
    assert.equal((await w.call({ op: "send", sandboxId, text: "x", pics: Array.from({ length: 7 }, () => pic("https://img.example.test/a.png")) })).status, 400, "at most 6");
    assert.equal((await w.call({ op: "send", sandboxId, text: "" })).status, 400, "an empty text needs a picture");
    assert.equal((await w.call({ op: "send", sandboxId, text: "x", replyTo: "no-such-row" })).status, 404);
    assert.equal((await w.call({ op: "react", sandboxId, msgId: real, emoji: "🎉" })).status, 400, "Messages' six tapbacks only");
    assert.equal((await w.call({ op: "react", sandboxId, msgId: "no-such-row", emoji: "❤️" })).status, 404);
    assert.equal((await w.call({ op: "edit", sandboxId, msgId: real, text: "changed" })).status, 400, "a real text is never edited");
    const sent = await w.call({ op: "send", sandboxId, text: "hello" });
    assert.equal(sent.status, 200);
    assert.equal((await w.call({ op: "edit", sandboxId, msgId: `${sent.body.msgId}r`, text: "changed" })).status, 400, "Tex's text is never edited");
    assert.equal((await w.call({ op: "unsend", sandboxId, msgId: real })).status, 400, "a real text is never unsent");
    assert.equal((await w.call({ op: "unsend", sandboxId, msgId: `${sent.body.msgId}r` })).status, 400, "Tex's text is never unsent");
    assert.equal((await w.call({ op: "edit", sandboxId, msgId: sent.body.msgId, text: "  " })).status, 400, "an edit has words");
    const rows = (await w.call({ op: "get", sandboxId })).body.rows;
    assert.equal(rows.find((r) => r.id === sent.body.msgId).text, "hello", "an edit refused changes nothing");
    assert.equal(w.turns.length, 1);
  } finally {
    w.restore();
  }
});

test("a picture text and a quoted reply run a turn and show on their rows; retry sends them again whole", async () => {
  const w = routeWorld();
  try {
    const { body: opened } = await w.call({ op: "open", source: "maya" });
    const sandboxId = opened.sandboxId;
    const pics = [{ url: "https://img.example.test/a.png", type: "image/png", name: "a.png" }];
    const sent = await w.call({ op: "send", sandboxId, text: "", pics, replyTo: opened.rows[0].id });
    assert.equal(sent.status, 200);
    const row = (await w.call({ op: "get", sandboxId })).body.rows.find((r) => r.id === sent.body.msgId);
    assert.deepEqual(row.pics, pics);
    assert.equal(row.replyTo, opened.rows[0].id);
    assert.equal(await w.sends(), 1);
    const retried = await w.call({ op: "retry", sandboxId, msgId: sent.body.msgId });
    assert.equal(retried.status, 200);
    assert.deepEqual(w.turns.at(-1).row.pics, pics);
    assert.equal(w.turns.at(-1).row.replyTo, opened.rows[0].id);
    assert.equal(await w.sends(), 2);
  } finally {
    w.restore();
  }
});

test("every turn runs the draft as saved now, not as it was at open; a retry that is refused cuts nothing", async () => {
  const w = routeWorld();
  try {
    w.draft = { nodes: [{ id: "decide", on: true }], edges: [] };
    const { body: opened } = await w.call({ op: "open", source: "maya", versionId: "d1" });
    const sandboxId = opened.sandboxId;
    const sent = await w.call({ op: "send", sandboxId, text: "one" });
    assert.equal(sent.status, 200);
    assert.equal(w.turns.at(-1).config.nodes[0].on, true);
    // The Lab saves an edit to the draft: the next turn runs it.
    w.draft = { nodes: [{ id: "decide", on: false }], edges: [] };
    assert.equal((await w.call({ op: "retry", sandboxId, msgId: sent.body.msgId })).status, 200);
    assert.equal(w.turns.at(-1).config.nodes[0].on, false);
    const texts = async () => (await w.call({ op: "get", sandboxId })).body.rows.filter((r) => !r.prod).map((r) => r.text);
    const before = await texts();
    const last = (await w.call({ op: "get", sandboxId })).body.rows.filter((r) => !r.prod && !r.reply).at(-1).id;
    // The draft is deleted: the retry is refused, and the text and its reply are still there.
    w.draft = null;
    assert.equal((await w.call({ op: "retry", sandboxId, msgId: last })).status, 404);
    assert.deepEqual(await texts(), before);
    // A text that starts running while the retry's checks are out is not cut from under its turn.
    w.draft = { nodes: [{ id: "decide", on: true }], edges: [] };
    w.onDraft = async () => {
      w.onDraft = null;
      await callSandbox(w.chat(), "meta", { key: "running", value: { msgId: last, at: Date.now() } });
    };
    assert.equal((await w.call({ op: "retry", sandboxId, msgId: last })).status, 409);
    assert.deepEqual(await texts(), before);
  } finally {
    w.restore();
  }
});

test("a tapback goes to the chat object like a text and is counted; get shows it on the text", async () => {
  const w = routeWorld();
  try {
    const { body: opened } = await w.call({ op: "open", source: "maya" });
    const sandboxId = opened.sandboxId;
    const sent = await w.call({ op: "send", sandboxId, text: "hello" });
    const tex = `${sent.body.msgId}r`;
    // Whether a tapback is noted or answered is the chat object's call (`reactions.ts`), never the route's.
    const loved = await w.call({ op: "react", sandboxId, msgId: tex, emoji: "❤️" });
    assert.equal(loved.status, 200);
    assert.deepEqual(Object.keys(loved.body), ["msgId"]);
    assert.equal(w.turns.length, 2, "handed on like any text");
    assert.equal(w.turns[1].row.kind, "reaction");
    assert.equal(await w.sends(), 2, "counted");
    const asked = await w.call({ op: "react", sandboxId, msgId: tex, emoji: "❓" });
    assert.equal(w.turns.length, 3);
    const rows = (await w.call({ op: "get", sandboxId })).body.rows;
    assert.deepEqual(rows.find((r) => r.id === tex).reactions, [{ who: "You", emoji: "❤️" }, { who: "You", emoji: "❓" }]);
    const event = rows.find((r) => r.id === loved.body.msgId);
    assert.equal(event.kind, "reaction");
    assert.equal(event.on, tex);
    assert.equal(event.noted, undefined, "never pre-decided");
    assert.match(event.text, /^❤️ \(yes\) on Tex's message "answer 1"$/);
    assert.equal((await w.call({ op: "react", sandboxId, msgId: loved.body.msgId, emoji: "👍" })).status, 400, "a tapback is never tapped");
    await w.call({ op: "drop", sandboxId, msgId: asked.body.msgId });
    const after = (await w.call({ op: "get", sandboxId })).body.rows;
    assert.deepEqual(after.find((r) => r.id === tex).reactions, [{ who: "You", emoji: "❤️" }], "a dropped tapback leaves the text");
  } finally {
    w.restore();
  }
});

test("chats say their kind and people; sets lists Training and Dev only; the Test Set never opens", async () => {
  const w = routeWorld();
  try {
    assert.deepEqual((await w.call({ op: "chats" })).body.chats, [{ chatId: "me", name: "You and Tex", kind: "1:1", people: 1 }, { chatId: KEY, name: "Team", kind: "group", people: 3 }]);
    const sets = (await w.call({ op: "sets" })).body.sets;
    assert.ok(sets.length > 1);
    assert.ok(sets.every((s) => s.set === "training" || s.set === "dev"));
    assert.deepEqual(sets.find((s) => s.id === "fresh-one"), { id: "fresh-one", title: "Fresh", set: "dev", kind: "group", people: 2, texts: 1 });
    assert.ok(sets.some((s) => s.id === "maya-and-tex"));
    assert.equal((await w.call({ op: "open", source: "set", convId: "secret-test" })).status, 403);
    assert.equal((await w.call({ op: "open", source: "set", convId: "group-1", chatId: KEY })).status, 200);
  } finally {
    w.restore();
  }
});

test("an edit goes to the chat object as the person's change, beside the text", async () => {
  const w = routeWorld();
  try {
    const { body: opened } = await w.call({ op: "open", source: "maya" });
    const sandboxId = opened.sandboxId;
    const sent = await w.call({ op: "send", sandboxId, text: "dinner at 7?" });
    // Node `edit` is the chat object's to ask (`editStep.ts`, over `/texts/edit`), never the route's.
    const edited = await w.call({ op: "edit", sandboxId, msgId: sent.body.msgId, text: "dinner at 8?" });
    assert.equal(edited.status, 200);
    assert.deepEqual(Object.keys(edited.body), ["msgId"]);
    assert.equal(w.turns.length, 2, "handed on like any text");
    assert.equal(w.turns[1].row.kind, "edit");
    const rows = (await w.call({ op: "get", sandboxId })).body.rows;
    const row = rows.find((r) => r.id === edited.body.msgId);
    assert.equal(row.on, sent.body.msgId);
    assert.equal(row.text, "dinner at 8?");
    assert.equal(row.edited, true);
    assert.equal(rows.find((r) => r.id === sent.body.msgId).text, "dinner at 7?", "the text itself keeps its words, as the ledger does");
    assert.equal((await w.call({ op: "edit", sandboxId, msgId: edited.body.msgId, text: "x" })).status, 400, "an edit row is not edited itself");
    const retried = await w.call({ op: "retry", sandboxId, msgId: edited.body.msgId });
    assert.equal(retried.status, 200);
    const after = (await w.call({ op: "get", sandboxId })).body.rows;
    assert.equal(after.filter((r) => r.kind === "edit").length, 1, "retry sends the edit again in place of the old one");
  } finally {
    w.restore();
  }
});

test("an unsend goes to the chat object, marks the text taken back, and leaves it out of the chat lines", async () => {
  const w = routeWorld();
  try {
    const { body: opened } = await w.call({ op: "open", source: "chat", chatId: KEY });
    const sandboxId = opened.sandboxId;
    const sent = await w.call({ op: "send", sandboxId, text: "who has the ferry times", as: "ana" });
    assert.equal((await w.call({ op: "unsend", sandboxId, msgId: sent.body.msgId, as: "kai" })).status, 403, "only its sender takes a text back");
    const unsent = await w.call({ op: "unsend", sandboxId, msgId: sent.body.msgId, as: "ana" });
    assert.equal(unsent.status, 200);
    assert.equal(w.turns.length, 2, "handed on like any text");
    assert.equal(w.turns[1].row.kind, "unsend");
    const rows = (await w.call({ op: "get", sandboxId })).body.rows;
    assert.equal(rows.find((r) => r.id === sent.body.msgId).unsent, true);
    const row = rows.find((r) => r.id === unsent.body.msgId);
    assert.equal(row.kind, "unsend");
    assert.equal(row.text, "");
    assert.equal((await w.call({ op: "edit", sandboxId, msgId: sent.body.msgId, text: "x", as: "ana" })).status, 400, "a text taken back is not edited");
    assert.equal((await w.call({ op: "unsend", sandboxId, msgId: sent.body.msgId, as: "ana" })).status, 400, "nor taken back twice");
    // The next text's chat lines leave out both the text taken back and its unsend.
    await w.call({ op: "send", sandboxId, text: "@tex anyone?", as: "kai" });
    const all = (await callSandbox(w.chat(), "state", {})).rows;
    const asked = w.turns[2].row;
    const body = await turnRequestBody({ about: w.turns[2].about, row: asked, rows: all.slice(0, all.findIndex((r) => r.id === asked.id) + 1), turn: "labturn09" });
    assert.ok(!body.group.chat.some((line) => line.text.includes("ferry")), "a text taken back is gone from the chat lines");
    assert.equal(body.group.chat.length, 0);
  } finally {
    w.restore();
  }
});

test("a group test text's turn gets what the control plane said about the chat, for the chat object's answers", async () => {
  const w = routeWorld();
  try {
    const { body: opened } = await w.call({ op: "open", source: "chat", chatId: KEY });
    assert.equal((await w.call({ op: "send", sandboxId: opened.sandboxId, as: "ana", text: "@tex hi" })).status, 200);
    assert.deepEqual(w.turns.at(-1).chat, { slug: "team", engagement: "helpful", engagementChosen: true });
  } finally {
    w.restore();
  }
});

test("tex_dev's guide documents the sandbox's pictures, replies, tapbacks, edits, unsends and sets", () => {
  const line = guideText().split("\n").find((l) => l.startsWith("- sandbox "));
  for (const word of ["pics", "replyTo", '"react"', "emoji", '"edit"', '"unsend"', '"sets"', "edit step"]) assert.ok(line.includes(word), `the guide's sandbox line names ${word}`);
  assert.ok(!line.includes("Tex doesn't receive edits yet"));
});

test("a voice note's two ledger entries open as one row, the one with words, not the empty audio", async () => {
  // 2026-11-16, Dev2's 1:1: the audio and what was heard share one event id, and the rows are keyed by it.
  const eid = EID(7);
  const entries = [
    { v: 1, id: "ev1h", eid, at: 7, kind: "text", event: "file", from: { kind: "person" }, heard: "voice", text: "How long does it keep?" },
    { v: 1, id: "ev1", eid, at: 7, kind: "text", event: "file", from: { kind: "person" }, text: "" },
    { v: 1, id: "ev2", eid: EID(8), at: 8, kind: "text", event: "text", from: { kind: "tex" }, text: "About 3 months." },
  ];
  const one = oneRowPerText(entries);
  assert.deepEqual(one.map((e) => e.text), ["How long does it keep?", "About 3 months."]);
  assert.deepEqual(oneRowPerText([entries[1], entries[0]]).map((e) => e.text), ["How long does it keep?"], "whichever comes first");
  const object = () => new LabSandboxObject({ storage: { sql: durableSql(), setAlarm: async () => {}, deleteAlarm: async () => {} } });
  const stub = (o) => ({ fetch: (request) => o.fetch(request) });
  const about = { kind: "one", ledgerChat: "texts" };
  const row = (e) => ({ id: e.eid, eid: e.eid, who: "You", text: e.text, at: e.at, prod: true });
  const kept = object();
  await callSandbox(stub(kept), "init", { about, rows: one.map(row), history: entries });
  const got = await callSandbox(stub(kept), "state", {});
  assert.deepEqual(got.rows.map((r) => r.text), ["How long does it keep?", "About 3 months."]);
  // Without the dedupe, the object keeps whichever entry came first (INSERT OR IGNORE since #3383): the empty audio one.
  const raw = object();
  await callSandbox(stub(raw), "init", { about, rows: [entries[1], entries[0], entries[2]].map(row), history: entries });
  assert.deepEqual((await callSandbox(stub(raw), "state", {})).rows.map((r) => r.text), ["", "About 3 months."]);
});

test("a failure inside the route answers words the Lab can show, never a bare server_error", async () => {
  const env = { LAB_SANDBOX: { idFromName: () => ({}), get: () => ({ fetch: async () => { throw new Error("boom"); } }) }, CONTROL_PLANE_URL: "https://control.example.invalid", GATEWAY_SECRET: "gw-secret-example-not-real-000000" };
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("control plane down"); };
  const logged = [];
  const log = console.log;
  console.log = (line) => logged.push(line);
  try {
    const response = await handleLabSandbox(new Request("https://gateway.example.invalid/tex-lab/sandbox", { method: "POST", headers: { authorization: `Bearer ${ALICE}` }, body: JSON.stringify({ op: "chats" }) }), env, null);
    const body = await response.json();
    assert.ok(response.status >= 500);
    assert.notEqual(body.error, "server_error");
    assert.match(body.error, /test chat|control plane/);
  } finally {
    globalThis.fetch = original;
    console.log = log;
  }
});
