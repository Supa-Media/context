/**
 * The app chat's approval cards (`packages/tex/gateway/agent/appChatRoute.js` op `answer`, `appChatCards.js`;
 * decision docs/decisions/texting-assistant/app-chat.md): what Tex holds for the person's OK shows as one card, an
 * email's body editable in place, Send and Not now; a yes replied onto the card answers that card.
 *
 * Send is the texted approval path, never a new one: the route arms that one ask and hands the chat object the same 👍
 * a person's tapback is, with the words of the ask as it now stands, and the gateway's turn settles it
 * (`thumbsUpIsYes`). Not now settles nothing and runs nothing.
 *
 * Sabotage record (run 2026-11-20, each break reverted before the next):
 *   1. `answerCard` stopped checking the row is Tex's own card: "only a card on this chat's Tex text is answered" failed.
 *   2. The 👍's words were the row's old text instead of the revised ask line: "an edited body goes ... the words of
 *      the ask as it now stands" failed.
 *   3. `send` stopped arming a replied card: "a yes replied onto a card arms that card's ask" failed.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { handleAppChat } from "../../../packages/tex/gateway/agent/appChatRoute.js";
import { askLine } from "../../../packages/tex/gateway/agent/textedApprovals.js";
import { createPending, listPending } from "../src/tools/approvals.js";
import { emailCopy, readEmail } from "../src/tools/email.js";
import { createMemoryStore } from "./gmailSync/fixtures.mjs";

const USER = "k7m2q9x4b8n3c6v1";
const CHAT = `app:${USER}`;
const NOW = 1_800_000_000_000;
const OWNER = { actorClientId: "context_console", workspaceKind: "personal", role: "owner", actorUserId: USER, workspaceId: "ws1" };
const TEX_ACTOR = { workspaceId: "ws1", userId: USER, clientId: "context_texts", client: "Tex" };
const EMAIL = { from: "me@example.test", to: ["kameela@example.test"], subject: "Two more guests", body: "Hi Kameela,\n\nCould we add 2 more guests?\n\nThanks!" };

async function heldEmail(store, args = EMAIL, actor = TEX_ACTOR) {
  const record = await createPending(store, {
    name: "send_email",
    args,
    actor,
    tier: "private",
    scopes: [],
    widening: { summary: `send an email to ${args.to[0]}`, audience: "outside" },
    detail: emailCopy(readEmail(args).email),
    workspaceId: "ws1",
    texting: true,
    armed: false,
    now: NOW - 60_000,
  });
  return record;
}

/** The chat's ledger: Tex's ask text for `record`, and its ask event. */
function askEntries(record, { askAt = NOW - 50_000 } = {}) {
  const from = { kind: "tex" };
  return [
    { v: 1, id: "ev1", eid: "17999999500000001", at: askAt, kind: "text", event: "text", via: "app", from, text: askLine([record]), turn: "turn0001" },
    { v: 1, id: "ev2", eid: "17999999500000002", at: askAt + 1, kind: "text", event: "ask", via: "app", from, text: "", ask: record.id, turn: "turn0001" },
  ];
}

function chatNamespace({ cards = {} } = {}) {
  const calls = [];
  const stub = {
    fetch: async (request) => {
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.json() : null;
      calls.push({ path: url.pathname, body });
      if (url.pathname === "/app/outbox") return Response.json({ events: [], typingAt: null, metas: {}, taps: {}, handles: {}, cards });
      if (url.pathname === "/app/arrive") return Response.json({ outcome: "queued" });
      if (url.pathname === "/app/card") return Response.json({ ok: true });
      return new Response(null, { status: 404 });
    },
  };
  return { calls, namespace: { idFromName: (name) => name, get: () => stub } };
}

async function call(body, { store, entries, chat = chatNamespace(), session = OWNER }) {
  const ledgerOf = async () => ({ read: async () => ({ entries }) });
  const response = await handleAppChat(new Request("https://gw/tex/app-chat", { method: "POST", body: JSON.stringify(body) }), store, session, "/tex/app-chat", { TEX_CHAT: chat.namespace }, { ledgerOf, now: () => NOW });
  return { response, chat, json: await response.clone().json().catch(() => null) };
}

describe("the app chat's approval cards", () => {
  it("a held email shows as a card with its fields and body, and no ask text to read", async () => {
    const store = createMemoryStore();
    const record = await heldEmail(store);
    const { json } = await call({ op: "get" }, { store, entries: askEntries(record) });
    const card = json.rows[0].ask.card;
    assert.equal(card.kind, "email");
    assert.equal(card.state, "wait");
    assert.equal(card.to, "kameela@example.test");
    assert.equal(card.subject, "Two more guests");
    assert.equal(card.body, EMAIL.body);
    assert.equal(card.editable, true);
  });

  it("Send with an edited body rewrites the held email and sends the 👍 on the words of the ask as it now stands", async () => {
    const store = createMemoryStore();
    const record = await heldEmail(store);
    const { response, chat, json } = await call({ op: "answer", msgId: "17999999500000001", choice: "send", body: "Hi Kameela,\n\nCould we add 3 more guests?" }, { store, entries: askEntries(record) });
    assert.equal(response.status, 200);
    assert.equal(json.state, "sending");
    const [live] = await listPending(store, { userId: USER, now: NOW });
    assert.equal(live.record.args.body, "Hi Kameela,\n\nCould we add 3 more guests?");
    assert.equal(live.record.texting, true, "that one ask is armed for the yes");
    const arrive = chat.calls.find((c) => c.path === "/app/arrive").body;
    assert.equal(arrive.kind, "react");
    assert.equal(arrive.message.reaction.how, "Liked");
    assert.equal(arrive.message.reaction.words, askLine([live.record]).trim());
    assert.match(arrive.message.reaction.words, /3 more guests/);
    const kept = chat.calls.find((c) => c.path === "/app/card").body;
    assert.deepEqual({ state: kept.state, body: kept.body, inbox: kept.inbox }, { state: "sending", body: "Hi Kameela,\n\nCould we add 3 more guests?", inbox: CHAT });
  });

  it("Send re-arms a card Tex has since moved on from", async () => {
    const store = createMemoryStore();
    const record = await heldEmail(store);
    // Disarmed, as when Tex has since asked something else: still pending, no longer what a bare yes reaches.
    const [entry] = await listPending(store, { userId: USER, now: NOW });
    await store.put(entry.key, JSON.stringify({ ...entry.record, texting: false }));
    assert.equal((await listPending(store, { userId: USER, texting: true, chat: null, now: NOW })).length, 0);
    const { response } = await call({ op: "answer", msgId: "17999999500000001", choice: "send" }, { store, entries: askEntries(record) });
    assert.equal(response.status, 200);
    assert.equal((await listPending(store, { userId: USER, texting: true, chat: null, now: NOW })).length, 1);
  });

  it("Not now keeps the draft: nothing settles, nothing runs, no turn starts", async () => {
    const store = createMemoryStore();
    const record = await heldEmail(store);
    const { response, chat, json } = await call({ op: "answer", msgId: "17999999500000001", choice: "hold" }, { store, entries: askEntries(record) });
    assert.equal(response.status, 200);
    assert.equal(json.state, "held");
    assert.equal(chat.calls.some((c) => c.path === "/app/arrive"), false);
    assert.equal(chat.calls.find((c) => c.path === "/app/card").body.state, "held");
    assert.equal((await listPending(store, { userId: USER, now: NOW })).length, 1);
  });

  it("a held card says so, and can still be sent", async () => {
    const store = createMemoryStore();
    const record = await heldEmail(store);
    const chat = chatNamespace({ cards: { [record.id]: { state: "held", at: NOW - 1 } } });
    assert.equal((await call({ op: "get" }, { store, entries: askEntries(record), chat })).json.rows[0].ask.card.state, "held");
    assert.equal((await call({ op: "answer", msgId: "17999999500000001", choice: "send" }, { store, entries: askEntries(record), chat })).response.status, 200);
  });

  it("only a card on this chat's Tex text is answered, and only while it waits", async () => {
    const store = createMemoryStore();
    const record = await heldEmail(store);
    const entries = askEntries(record);
    assert.equal((await call({ op: "answer", msgId: "nope", choice: "send" }, { store, entries })).response.status, 400);
    assert.equal((await call({ op: "answer", msgId: "17999999500000001", choice: "maybe" }, { store, entries })).response.status, 400);
    assert.equal((await call({ op: "answer", msgId: "17999999500000001", choice: "send", body: 7 }, { store, entries })).response.status, 400);
    const sending = chatNamespace({ cards: { [record.id]: { state: "sending", at: NOW - 1 } } });
    assert.equal((await call({ op: "answer", msgId: "17999999500000001", choice: "send" }, { store, entries, chat: sending })).response.status, 409);
  });

  it("another person's held email is never shown or sent from this chat", async () => {
    const store = createMemoryStore();
    const record = await heldEmail(store, EMAIL, { ...TEX_ACTOR, userId: "someoneelse00000" });
    const entries = askEntries(record);
    const got = await call({ op: "get" }, { store, entries });
    assert.notEqual(got.json.rows[0].ask.card?.state, "wait");
    const sent = await call({ op: "answer", msgId: "17999999500000001", choice: "send", body: "changed" }, { store, entries });
    assert.ok(sent.response.status >= 400);
    assert.equal(sent.chat.calls.some((c) => c.path === "/app/arrive"), false);
  });

  it("a yes replied onto a card arms that card's ask; other words do not", async () => {
    const store = createMemoryStore();
    const record = await heldEmail(store);
    const entries = askEntries(record);
    const replied = await call({ op: "send", text: "go ahead", replyTo: "17999999500000001" }, { store, entries });
    assert.equal(replied.response.status, 200);
    assert.equal((await listPending(store, { userId: USER, texting: true, chat: null, now: NOW })).length, 1);
    assert.equal(replied.chat.calls.find((c) => c.path === "/app/card")?.body.state, "sending");

    const store2 = createMemoryStore();
    const record2 = await heldEmail(store2);
    const other = await call({ op: "send", text: "what time is it there?", replyTo: "17999999500000001" }, { store: store2, entries: askEntries(record2) });
    assert.equal(other.response.status, 200);
    assert.equal((await listPending(store2, { userId: USER, texting: true, chat: null, now: NOW })).length, 0);
  });
});
