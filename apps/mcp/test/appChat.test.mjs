/**
 * The Context app's own chat with Tex (`src/agent/appChatRoute.js`, `src/agent/appChatRows.js`,
 * `src/texChat/appChat.js`; decision docs/decisions/texting-assistant/app-chat.md): its own chat, the same history.
 *
 * Runs under `--experimental-transform-types` with `test/tsRegister.mjs` (`test/run.mjs`), which loads the Worker's
 * TypeScript the chat object's helpers come from.
 *
 * Sabotage record (run 2026-11-19, each break reverted before the next):
 *   1. `ledgerEntries` stopped filtering `via: "app"`: "shows only the app's own chat" failed (the iMessage text showed).
 *   2. The route's owner check dropped `role !== "owner"`: "refuses anyone but the owner's console" failed.
 *   3. `picture` stopped checking the id against the rows: "never serves a picture this chat's rows do not show" failed.
 *   4. `buildRows` let an edit change Tex's text: "an edit names only the person's own text" failed.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { handleAppChat } from "../src/agent/appChatRoute.js";
import { EDIT_WINDOW_MS, buildRows, ledgerEntries } from "../src/agent/appChatRows.js";
import { eventEntry } from "../src/agent/ledger.js";
import { serveAppArrive, serveAppOutbox } from "../../../packages/tex/gateway/texChat/appChat.js";

const USER = "k7m2q9x4b8n3c6v1";
const CHAT = `app:${USER}`;
const NOW = 1_800_000_000_000;
const OWNER = { actorClientId: "context_console", workspaceKind: "personal", role: "owner", actorUserId: USER, workspaceId: "ws1" };
const PIC = "a".repeat(32);
const evId = (at, n = 0) => `${at}${String(n).padStart(4, "0")}`;

function memoryStorage() {
  const map = new Map();
  return {
    map,
    get: async (key) => map.get(key),
    put: async (key, value) => void map.set(key, value),
    delete: async (key) => map.delete(key),
    list: async ({ prefix }) => new Map([...map].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1))),
  };
}

/** A fake TEX_CHAT namespace: one object, answering the outbox, pictures and arrivals; every call is kept. */
function chatNamespace({ events = [], metas = {}, taps = {}, handles = {}, picture = null, arrive = { outcome: "queued" } } = {}) {
  const calls = [];
  const stub = {
    fetch: async (request) => {
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.json() : null;
      calls.push({ path: url.pathname, body });
      if (url.pathname === "/app/outbox") return Response.json({ events, typingAt: null, metas, taps, handles });
      if (url.pathname.startsWith("/app/picture/")) return picture ?? new Response(null, { status: 404 });
      if (url.pathname === "/app/arrive") return Response.json(arrive);
      return new Response(null, { status: 404 });
    },
  };
  return { calls, namespace: { idFromName: (name) => (calls.push({ name }), name), get: () => stub } };
}

const ledgerOf = (entries) => async () => ({ read: async () => ({ entries }) });

function post(body) {
  return new Request("https://gw/tex/app-chat", { method: "POST", body: JSON.stringify(body) });
}

async function call(body, { session = OWNER, entries = [], chat = chatNamespace() } = {}) {
  const response = await handleAppChat(post(body), null, session, "/tex/app-chat", { TEX_CHAT: chat.namespace }, { ledgerOf: ledgerOf(entries), now: () => NOW });
  return { response, chat };
}

const person = (id, at, text, extra = {}) => ({ id, at, chat: CHAT, from: { kind: "person", who: "f".repeat(64) }, kind: "text", text, ...extra });
const tex = (id, at, text, extra = {}) => ({ id, at, chat: CHAT, from: { kind: "tex" }, kind: "text", text, ...extra });

describe("the ledger marks the app's events", () => {
  it("marks an event from the app chat via app, and no other", () => {
    assert.equal(eventEntry(person(evId(NOW), NOW, "hi")).via, "app");
    assert.equal(eventEntry({ ...person(evId(NOW), NOW, "hi"), chat: "+15555550101" }).via, undefined);
  });

  it("shows only the app's own chat, while the ledger keeps both", async () => {
    const app = { ...eventEntry(person(evId(NOW), NOW, "from the app")), seq: 2 };
    const imessage = { ...eventEntry({ ...person(evId(NOW - 5), NOW - 5, "from iMessage"), chat: "photon:+15555550101" }), seq: 1 };
    const entries = await ledgerEntries(ledgerOf([app, imessage]), "ws1");
    assert.deepEqual(buildRows(entries, {}, NOW).map((row) => row.text), ["from the app"]);
  });
});

describe("buildRows", () => {
  it("folds an edit into the person's own text and marks it edited", () => {
    const sent = person(evId(NOW - 10), NOW - 10, "helo");
    const edit = person(evId(NOW - 5), NOW - 5, "hello", { edited: true, replyTo: sent.id, quoted: "helo" });
    const rows = buildRows([], { events: [sent, edit], handles: { [sent.id]: "app:00" } }, NOW);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].text, "hello");
    assert.equal(rows[0].edited, true);
    assert.equal(rows[0].editable, true);
  });

  it("an edit names only the person's own text", () => {
    const said = tex(evId(NOW - 10), NOW - 10, "Tex's words");
    const edit = person(evId(NOW - 5), NOW - 5, "changed", { edited: true, replyTo: said.id });
    const rows = buildRows([], { events: [said, edit] }, NOW);
    assert.equal(rows[0].text, "Tex's words");
    assert.equal(rows[0].edited, undefined);
  });

  it("an unsend empties the text, drops its pictures, and it can no longer be edited or tapped", () => {
    const sent = person(evId(NOW - 10), NOW - 10, "oops", { kind: "picture" });
    const unsend = person(evId(NOW - 5), NOW - 5, "", { unsent: true, replyTo: sent.id });
    const rows = buildRows([], { events: [sent, unsend], metas: { [sent.id]: { pics: [PIC] } }, taps: { [sent.id]: { emoji: "❤️" } }, handles: { [sent.id]: "h" } }, NOW);
    assert.equal(rows[0].unsent, true);
    assert.equal(rows[0].text, "");
    assert.equal(rows[0].pics, undefined);
    assert.equal(rows[0].reactions, undefined);
    assert.equal(rows[0].editable, undefined);
  });

  it("shows the person's pictures by the ids kept beside the event, and Tex's by its address", () => {
    const mine = person(evId(NOW - 10), NOW - 10, "look", { kind: "picture" });
    const theirs = tex(evId(NOW - 5), NOW - 5, `https://app-chat.invalid/pic/${"b".repeat(32)}.png`, { kind: "picture" });
    const rows = buildRows([], { events: [mine, theirs], metas: { [mine.id]: { pics: [PIC, "../nope"] } } }, NOW);
    assert.deepEqual(rows[0].pics, [PIC]);
    assert.equal(rows[0].text, "look");
    assert.deepEqual(rows[1].pics, ["b".repeat(32)]);
    assert.equal(rows[1].text, "");
  });

  it("puts the person's tapback and Tex's on the texts they are on", () => {
    const said = tex(evId(NOW - 10), NOW - 10, "Done");
    const mine = person(evId(NOW - 8), NOW - 8, "thanks");
    const texTap = { ...tex(evId(NOW - 6), NOW - 6, "❤️"), kind: "reaction", covers: [mine.id] };
    const rows = buildRows([], { events: [said, mine, texTap], taps: { [said.id]: { emoji: "😂" }, [mine.id]: { emoji: "<b>" } } }, NOW);
    assert.deepEqual(rows[0].reactions, [{ who: "me", emoji: "😂" }]);
    assert.deepEqual(rows[1].reactions, [{ who: "tex", emoji: "❤️" }]);
    assert.equal(rows.length, 2);
  });

  it("carries a reply's quoted words", () => {
    const said = tex(evId(NOW - 10), NOW - 10, "Send it?");
    const reply = person(evId(NOW - 8), NOW - 8, "which one?", { replyTo: said.id, quoted: "Send it?" });
    assert.deepEqual(buildRows([], { events: [said, reply] }, NOW)[1].replyTo, { id: said.id, text: "Send it?" });
  });

  it("keeps a reply to a picture by the row the app noted, since a picture has no words to find it by", () => {
    const picture = person(evId(NOW - 10), NOW - 10, "", { kind: "picture" });
    const reply = person(evId(NOW - 8), NOW - 8, "this one");
    const rows = buildRows([], { events: [picture, reply], metas: { [picture.id]: { pics: [PIC] }, [reply.id]: { replyTo: picture.id } } }, NOW);
    assert.deepEqual(rows[1].replyTo, { id: picture.id });
  });

  it("keeps an ask open until the person says or taps anything after it, on any line", () => {
    const said = tex(evId(NOW - 10), NOW - 10, "Send it?", { turn: "t1" });
    const ask = { ...tex(evId(NOW - 9), NOW - 9, ""), kind: "ask", ask: "rec1", turn: "t1" };
    assert.deepEqual(buildRows([], { events: [said, ask] }, NOW)[0].ask, { id: "rec1", open: true });
    // Answered over iMessage: not a row in the app, but the buttons go.
    const texted = { ...eventEntry({ ...person(evId(NOW - 5), NOW - 5, "yes"), chat: "photon:+15555550101" }), seq: 9 };
    const afterText = buildRows([texted], { events: [said, ask] }, NOW);
    assert.equal(afterText.length, 1);
    assert.deepEqual(afterText[0].ask, { id: "rec1", open: false });
    assert.deepEqual(buildRows([], { events: [said, ask], taps: { [said.id]: { emoji: "👍" } } }, NOW)[0].ask, { id: "rec1", open: false });
  });

  it("follows a second edit back to the text, which stays editable by the handle the chat object moved to the edit", () => {
    const sent = person(evId(NOW - 10), NOW - 10, "helo");
    const first = person(evId(NOW - 8), NOW - 8, "hello", { edited: true, replyTo: sent.id });
    const second = person(evId(NOW - 6), NOW - 6, "hello!", { edited: true, replyTo: first.id });
    const out = {};
    const rows = buildRows([], { events: [sent, first, second], handles: { [second.id]: "app:aa" } }, NOW, out);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].text, "hello!");
    assert.equal(rows[0].editable, true);
    assert.equal(out.handles[sent.id], "app:aa");
  });

  it("shows an edit the edit node found changed nothing, from the words the app kept", () => {
    const sent = person(evId(NOW - 10), NOW - 10, "teh plan");
    const [row] = buildRows([], { events: [sent], metas: { [sent.id]: { text: "the plan" } } }, NOW);
    assert.equal(row.text, "the plan");
    assert.equal(row.edited, true);
  });

  it("lets the person change a text only within the window and while its handle is known", () => {
    const old = person(evId(NOW - EDIT_WINDOW_MS - 1), NOW - EDIT_WINDOW_MS - 1, "old");
    const fresh = person(evId(NOW - 1), NOW - 1, "new");
    const unknown = person(evId(NOW - 2, 1), NOW - 2, "no handle");
    const rows = buildRows([], { events: [old, unknown, fresh], handles: { [old.id]: "h1", [fresh.id]: "h2" } }, NOW);
    assert.deepEqual(rows.map((row) => row.editable === true), [false, false, true]);
    assert.deepEqual(rows.map((row) => row.unsendable === true), [false, false, true]);
    const picture = person(evId(NOW - 1, 2), NOW - 1, "", { kind: "picture" });
    const [shown] = buildRows([], { events: [picture], metas: { [picture.id]: { pics: [PIC] } }, handles: { [picture.id]: "h3" } }, NOW);
    assert.equal(shown.unsendable, true, "a picture can be taken back");
    assert.equal(shown.editable, undefined, "but not edited");
  });
});

describe("POST /tex/app-chat", () => {
  it("every answer carries the open CORS header, so the console on another origin can read it", async () => {
    // Without it the browser hid a 200 and the app said "I could not reach Tex" (Dev2, 2026-11-19).
    const sent = await call({ op: "send", text: "hi" }, { chat: chatNamespace({ arrive: { outcome: "queued", ev: "17000000000000001" } }) });
    assert.equal(sent.response.status, 200);
    assert.equal(sent.response.headers.get("access-control-allow-origin"), "*");
    const listed = await call({ op: "get" });
    assert.equal(listed.response.status, 200);
    assert.equal(listed.response.headers.get("access-control-allow-origin"), "*");
    const refused = await call({ op: "get" }, { session: { ...OWNER, actorClientId: "someone_else" } });
    assert.equal(refused.response.status, 403);
    assert.equal(refused.response.headers.get("access-control-allow-origin"), "*");
  });

  it("refuses anyone but the owner's console on their personal workspace", async () => {
    for (const session of [
      { ...OWNER, actorClientId: "some_ai_client" },
      { ...OWNER, workspaceKind: "shared" },
      { ...OWNER, role: "editor" },
      { ...OWNER, actorUserId: "NOT A USER" },
      null,
    ]) {
      const { response, chat } = await call({ op: "get" }, { session });
      assert.equal(response.status, 403);
      assert.equal(chat.calls.length, 0);
    }
  });

  it("sends to the session's own chat, whatever the body names", async () => {
    const { response, chat } = await call({ op: "send", text: " hi ", chatId: "app:someoneelse", from: "+15555550101" });
    assert.equal(response.status, 200);
    const arrive = chat.calls.find((c) => c.path === "/app/arrive").body;
    assert.equal(arrive.inbox, CHAT);
    assert.equal(arrive.message.chatId, CHAT);
    assert.equal(arrive.message.from, CHAT);
    assert.equal(arrive.message.text, "hi");
    assert.ok(chat.calls.every((c) => c.name === undefined || c.name === `chat:${CHAT}`));
  });

  it("answers the event id the chat object logged a send under", async () => {
    const { response } = await call({ op: "send", text: "hi" }, { chat: chatNamespace({ arrive: { outcome: "queued", ev: "17000000000000001" } }) });
    assert.deepEqual(await response.json(), { msgId: "17000000000000001" });
  });

  it("takes pictures only as a list of up to four, and needs words or a picture", async () => {
    assert.equal((await call({ op: "send", text: "", pictures: [] })).response.status, 400);
    assert.equal((await call({ op: "send", text: "x", pictures: ["a", "b", "c", "d", "e"] })).response.status, 400);
    assert.equal((await call({ op: "send", text: "x", pictures: [42] })).response.status, 400);
    const { response, chat } = await call({ op: "send", pictures: ["iVBORw0KGgo="] });
    assert.equal(response.status, 200);
    assert.deepEqual(chat.calls.find((c) => c.path === "/app/arrive").body.pictures, ["iVBORw0KGgo="]);
  });

  it("takes a reply, a tapback, an edit and an unsend only on rows of this chat", async () => {
    const said = tex(evId(NOW - 10), NOW - 10, "Done");
    const mine = person(evId(NOW - 5), NOW - 5, "thx");
    const chat = () => chatNamespace({ events: [said, mine], handles: { [mine.id]: "app:aa" } });
    assert.equal((await call({ op: "send", text: "x", replyTo: "nope" }, { chat: chat() })).response.status, 400);
    assert.equal((await call({ op: "react", msgId: "nope", emoji: "❤️" }, { chat: chat() })).response.status, 400);
    assert.equal((await call({ op: "react", msgId: said.id, emoji: "🤡" }, { chat: chat() })).response.status, 400);
    assert.equal((await call({ op: "edit", msgId: said.id, text: "mine now" }, { chat: chat() })).response.status, 400);

    const tapped = await call({ op: "react", msgId: said.id, emoji: "❤️" }, { chat: chat() });
    assert.equal(tapped.response.status, 200);
    const tap = tapped.chat.calls.find((c) => c.path === "/app/arrive").body;
    assert.deepEqual(tap.message.reaction, { how: "Loved", words: "Done", onTex: true });
    assert.deepEqual(tap.tap, { on: said.id, emoji: "❤️" });

    const approvedTwice = await call({ op: "react", msgId: said.id, emoji: "👍", answer: true }, { chat: chatNamespace({ events: [said, mine], taps: { [said.id]: { emoji: "👍" } } }) });
    assert.equal(approvedTwice.chat.calls.find((c) => c.path === "/app/arrive").body.message.reaction.removed, undefined, "Approve twice never takes the yes back");

    const again = await call({ op: "react", msgId: said.id, emoji: "❤️" }, { chat: chatNamespace({ events: [said, mine], taps: { [said.id]: { emoji: "❤️" } } }) });
    const untap = again.chat.calls.find((c) => c.path === "/app/arrive").body;
    assert.equal(untap.message.reaction.removed, true, "the same tapback again takes it back");
    assert.deepEqual(untap.tap, { on: said.id, emoji: null });

    const edited = await call({ op: "edit", msgId: mine.id, text: "thanks" }, { chat: chat() });
    const edit = edited.chat.calls.find((c) => c.path === "/app/arrive").body;
    assert.equal(edit.kind, "edit");
    assert.equal(edit.message.kind, "edited");
    assert.equal(edit.message.messageId, "app:aa");
    assert.equal(edit.message.previous, "thx");

    const unsent = await call({ op: "unsend", msgId: mine.id }, { chat: chat() });
    const unsend = unsent.chat.calls.find((c) => c.path === "/app/arrive").body;
    assert.equal(unsend.message.kind, "unsent");
    assert.equal(unsend.message.text, undefined);

    const picture = person(evId(NOW - 4), NOW - 4, "", { kind: "picture" });
    const gone = await call({ op: "unsend", msgId: picture.id }, { chat: chatNamespace({ events: [picture], metas: { [picture.id]: { pics: [PIC] } }, handles: { [picture.id]: "app:bb" } }) });
    assert.deepEqual(gone.chat.calls.find((c) => c.path === "/app/arrive").body.forget, [PIC], "an unsent picture's bytes are deleted");
  });

  it("never serves a picture this chat's rows do not show, and serves one that is as an inert picture", async () => {
    const mine = person(evId(NOW - 5), NOW - 5, "", { kind: "picture" });
    const picture = new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { headers: { "content-type": "image/png" } });
    const chat = chatNamespace({ events: [mine], metas: { [mine.id]: { pics: [PIC] } }, picture });
    const other = await call({ op: "picture", id: "c".repeat(32) }, { chat });
    assert.equal(other.response.status, 404);
    assert.ok(!chat.calls.some((c) => c.path?.startsWith("/app/picture/")));
    const { response } = await call({ op: "picture", id: PIC }, { chat });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.match(response.headers.get("content-security-policy"), /sandbox/);
  });

  it("refuses a picture the chat object answers with a type that could carry a script", async () => {
    const mine = person(evId(NOW - 5), NOW - 5, "", { kind: "picture" });
    const picture = new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } });
    const { response } = await call({ op: "picture", id: PIC }, { chat: chatNamespace({ events: [mine], metas: { [mine.id]: { pics: [PIC] } }, picture }) });
    assert.equal(response.status, 404);
  });
});

describe("the app chat's object", () => {
  function state() {
    const storage = memoryStorage();
    return { storage, blockConcurrencyWhile: (run) => run() };
  }
  const arrive = (body) => new Request("https://chat/app/arrive", { method: "POST", body: JSON.stringify(body) });
  const PNG = btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3));

  it("keeps a send's pictures, hands them over at addresses only its own fetch answers, and keeps their ids by event", async () => {
    const s = state();
    await s.storage.put("__inbox_name", CHAT);
    let handed = null;
    const open = async () => ({
      fetch: async (request) => {
        handed = await request.json();
        await s.storage.put("evhandles", [{ h: handed.messageId, ev: "17000000000000001" }]);
        return Response.json({ outcome: "queued" });
      },
    });
    const answer = await serveAppArrive(arrive({ kind: "one", inbox: CHAT, message: { kind: "message", messageId: "app:01", chatId: CHAT, from: CHAT, text: "" }, pictures: [PNG] }), { state: s, open, now: () => NOW });
    assert.equal(answer.status, 200);
    assert.deepEqual(await answer.json(), { outcome: "queued", ev: "17000000000000001" });
    assert.equal(handed.attachments.length, 1);
    assert.match(handed.attachments[0].url, /^https:\/\/app-chat\.invalid\/pic\/[0-9a-f]{32}\.png$/);
    const outbox = await (await serveAppOutbox(s.storage)).json();
    assert.equal(outbox.metas["17000000000000001"].pics.length, 1);
    assert.deepEqual(outbox.handles, { "17000000000000001": "app:01" });
  });

  it("refuses bytes that are not a picture, and gives the send back", async () => {
    const s = state();
    await s.storage.put("__inbox_name", CHAT);
    const answer = await serveAppArrive(arrive({ kind: "one", inbox: CHAT, message: { messageId: "x" }, pictures: [btoa("<svg onload=x>")] }), { state: s, open: async () => null, now: () => NOW });
    assert.equal(answer.status, 400);
    assert.equal((await s.storage.get("app:sends")).n, 0);
  });

  it("answers only to the chat it was placed for", async () => {
    const s = state();
    await s.storage.put("__inbox_name", CHAT);
    const answer = await serveAppArrive(arrive({ kind: "one", inbox: "app:a0000000000000000b", message: { messageId: "x" } }), { state: s, open: async () => null, now: () => NOW });
    assert.equal(answer.status, 400);
  });

  it("takes only an app chat, and only the three kinds of call", async () => {
    const s = state();
    for (const body of [{ kind: "group", inbox: CHAT, message: {} }, { kind: "one", inbox: "+15555550101", message: {} }, { kind: "toString", inbox: CHAT, message: {} }]) {
      assert.equal((await serveAppArrive(arrive(body), { state: s, open: async () => null, now: () => NOW })).status, 400);
    }
  });
});
