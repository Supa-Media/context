// The Tex page's thinking, advisor and mail-check views, rebuilt from the
// chat's one log (src/texStore/pageViews.js), and an append reaching an open page.
import { test } from "node:test";
import assert from "node:assert/strict";

import { TexStore } from "../src/texStore.js";
import { logChatOf, pageViews, sectionsForKinds } from "../src/texStore/pageViews.js";
import { PAGE_LIVE_PATH, PAGE_VIEWER_HEADER } from "../src/texStore/pageLive.js";
import { arrivedSql, durableSql } from "./texStoreFixture.mjs";

/** A chat's log with `texLedger`'s read: `before` newest first, `kinds`, `limit`, `slim`. */
function fakeLedger(chats) {
  return {
    reads: 0,
    read(chat, { after = 0, before = null, kinds = null, limit = 5000, slim = false } = {}) {
      this.reads += 1;
      let entries = (chats[chat] ?? []).map((entry, index) => ({ ...entry, seq: index + 1 }));
      if (kinds) entries = entries.filter((entry) => kinds.includes(entry.kind));
      entries = before ? entries.filter((entry) => entry.seq < before).reverse() : entries.filter((entry) => entry.seq > after);
      entries = entries.slice(0, limit).map((entry) => {
        const copy = structuredClone(entry);
        if (slim) {
          delete copy.args;
          delete copy.result;
          if (copy.kind === "reply") delete copy.text;
        }
        return copy;
      });
      return { manifest: {}, entries };
    },
  };
}

const T0 = Date.UTC(2026, 10, 2, 12);
const person = (eid, at, text, name) => ({ v: 1, id: `ev${eid}`, eid, at, kind: "text", from: { kind: "person", ...(name ? { name } : {}) }, text });
const tex = (eid, at, turn, covers, text) => ({ v: 1, id: `ev${eid}`, eid, at, kind: "text", from: { kind: "tex" }, turn, covers, text });

/** Two turns: one that asked the advisor, checked an email and replied; one that stayed quiet. */
function oneToOne() {
  return [
    person("a1", T0 - 86_400_000, "old news"),
    { v: 1, id: "q1", at: T0 - 86_400_000 + 5, kind: "reply", turn: "turnold1", text: "noted", ms: 900 },
    tex("a2", T0 - 86_400_000 + 6, "turnold1", ["a1"], "noted"),
    person("b1", T0, "email Jo about Friday"),
    { v: 1, id: "th1", at: T0 + 10, kind: "thinking", turn: "turnaaaa1", text: "They want Jo told about Friday." },
    { v: 1, id: "tl1", at: T0 + 20, kind: "tool", turn: "turnaaaa1", name: "ask_advisor", args: {}, ok: true, ms: 1200, result: "Say Friday, not Thursday." },
    { v: 1, id: "tl2", at: T0 + 30, kind: "tool", turn: "turnaaaa1", name: "read_note", args: { path: "x.md" }, ok: true, ms: 40, result: "x".repeat(100) },
    { v: 1, id: "mc1", at: T0 + 40, kind: "mail_check", turn: "turnaaaa1", to: "jo@example.com", subject: "Friday", verdict: "unsure", why: "no time named" },
    { v: 1, id: "rp1", at: T0 + 50, kind: "reply", turn: "turnaaaa1", text: "Drafted it, want me to send?", ms: 3100 },
    tex("b2", T0 + 51, "turnaaaa1", ["b1"], "Drafted it, want me to send?"),
    person("c1", T0 + 100, "ok thanks"),
    { v: 1, id: "th2", at: T0 + 110, kind: "thinking", turn: "turnbbbb2", text: "Nothing to do." },
  ];
}

test("thinking: one item per turn, newest first, with what it answered, its thought, what it did and its reply", () => {
  const views = pageViews(() => fakeLedger({ texts: oneToOne() }));
  const page = views.list("thinking", { chat: "texts", limit: 3, since: T0 });
  assert.equal(page.count, 2);
  assert.deepEqual(page.items.map((turn) => turn.id), ["turnbbbb2", "turnaaaa1", "turnold1"]);
  const [quiet, busy] = page.items;
  assert.equal(quiet.reply, null);
  // A quiet turn names nothing it answered: the texts just before it are what it read.
  assert.equal(quiet.said, "ok thanks");
  assert.deepEqual(quiet.did, []);
  assert.equal(busy.who, "You");
  assert.equal(busy.said, "email Jo about Friday");
  assert.equal(busy.thought, "They want Jo told about Friday.");
  assert.equal(busy.reply, "Drafted it, want me to send?");
  assert.equal(busy.ms, 3100);
  assert.deepEqual(busy.did.map((action) => action.kind), ["advisor", "tool", "mailcheck"]);
  assert.equal(busy.did[0].ref, "tl1");
  assert.equal(busy.did[1].label, "read note");
  // A tool's arguments and result never reach the page's turn.
  assert.ok(!JSON.stringify(page).includes("x".repeat(100)));
  // Paging on.
  const first = views.list("thinking", { chat: "texts", limit: 1, since: T0 });
  assert.ok(first.cursor);
  const next = views.list("thinking", { chat: "texts", limit: 1, cursor: first.cursor, since: T0 });
  assert.deepEqual(next.items.map((turn) => turn.id), ["turnaaaa1"]);
});

test("advisor and mail checks: each ask and each check, the checker's verdict read for the page", () => {
  const views = pageViews(() => fakeLedger({ texts: oneToOne() }));
  const advisor = views.list("advisor", { chat: "texts", since: T0 });
  assert.equal(advisor.count, 1);
  assert.deepEqual(advisor.items[0], { id: "tl1", at: T0 + 20, question: "email Jo about Friday", answer: "Say Friday, not Thursday.", read: "Read the whole turn", ms: 1200 });
  const mail = views.list("mailcheck", { chat: "texts", since: T0 });
  assert.deepEqual(mail.items[0], { id: "mc1", at: T0 + 40, to: "jo@example.com", subject: "Friday", verdict: "waiting", why: "no time named", from: "your texts" });
  assert.equal(views.waiting("texts", { now: T0 + 1000 }), 1);
  assert.equal(views.waiting("texts", { now: T0 + 2 * 86_400_000 }), 0);
});

test("a group's views read the group's own log, named by its key, and name the sender", () => {
  const key = "b".repeat(64);
  const views = pageViews(() => fakeLedger({ [key]: [person("g1", T0, "dinner at 8?", "Ada Lovelace"), tex("g2", T0 + 5, "turngggg1", ["g1"], "Booked.")], texts: oneToOne() }));
  const page = views.list("thinking", { chat: key, since: T0 });
  assert.deepEqual(page.items.map((turn) => [turn.who, turn.said]), [["Ada", "dinner at 8?"]]);
  assert.equal(logChatOf({ groupKey: key }), key);
  assert.equal(logChatOf({ phone: "+15555550100" }), "texts");
  assert.equal(logChatOf(null), "texts");
});

test("no log yet: every view is empty, never an error", () => {
  const views = pageViews(() => undefined);
  assert.deepEqual(views.list("thinking", { chat: "texts" }), { items: [], count: 0 });
  assert.deepEqual(views.list("advisor", { chat: "texts" }), { items: [], count: 0 });
  assert.deepEqual(views.list("secrets", { chat: "texts" }), { items: [], count: 0 });
  assert.equal(views.waiting("texts"), 0);
});

test("sections an append changes", () => {
  assert.deepEqual(sectionsForKinds(["text"]), ["thinking", "behind"]);
  assert.deepEqual(sectionsForKinds(["tool"]).sort(), ["advisor", "behind", "thinking"]);
  assert.deepEqual(sectionsForKinds(["mail_check"]), ["mailcheck", "behind"]);
  // A note is still a line in the history: an open history view hears of it.
  assert.deepEqual(sectionsForKinds(["note"]), ["behind"]);
  assert.deepEqual(sectionsForKinds([]), []);
});

test("in the Tex object: an append to the chat's log reaches an open page, and page_list answers from the log", async () => {
  const sql = arrivedSql(durableSql());
  const sockets = [];
  const state = {
    storage: { sql, alarm: null, setAlarm(at) { state.storage.alarm = at; }, deleteAlarm() { state.storage.alarm = null; } },
    blockConcurrencyWhile: (run) => run(),
    held: [],
    acceptWebSocket(ws, tags) { ws.tags = tags; state.held.push(ws); },
    getWebSockets(tag) { return state.held.filter((ws) => ws.tags.includes(tag)); },
  };
  const store = new TexStore(state, {}, {
    dispatch: async () => ({ next: null }),
    pageDeps: {
      pair: () => {
        const ws = { sent: [], readyState: 1, send(frame) { ws.sent.push(JSON.parse(frame)); }, close() { ws.readyState = 3; }, serializeAttachment(v) { ws.att = v; }, deserializeAttachment() { return ws.att; } };
        sockets.push(ws);
        return [{}, ws];
      },
      upgraded: () => ({ status: 101 }),
    },
  });
  store.ready();

  await store.fetch(new Request(`https://tex-store.internal${PAGE_LIVE_PATH}`, { headers: { Upgrade: "websocket", "x-tex-owner": "person:ws_v", [PAGE_VIEWER_HEADER]: JSON.stringify({ deadline: Date.now() + 60_000, chat: null }) } }));
  // The chat's real log, appended through the object as the gateway's writer does (`wire.js` `ledger_append`).
  const now = Date.now();
  const entries = oneToOne().map((entry, index) => ({ ...entry, at: now - 1000 + index }));
  await store.fetch(new Request("https://tex-store.internal/ledger_append", { method: "POST", headers: { "x-tex-owner": "person:ws_v", "x-tex-call": encodeURIComponent(JSON.stringify({ op: "ledger_append", chat: "texts" })) }, body: JSON.stringify(entries) }));
  assert.deepEqual(sockets[0].sent.map((frame) => frame.section).sort(), ["advisor", "behind", "mailcheck", "thinking", "tiles"]);
  const answer = await store.fetch(new Request("https://tex-store.internal/page_list", { method: "POST", headers: { "x-tex-owner": "person:ws_v", "x-tex-call": encodeURIComponent(JSON.stringify({ op: "page_list", chat: "texts", kind: "mailcheck", limit: 5 })) } }));
  const page = await answer.json();
  assert.deepEqual(page.items.map((item) => item.id), ["mc1"]);
  assert.equal(typeof page.waiting, "number");
});

test("thinking: a turn shows each draft that was sent back, with the gates or check that sent it", () => {
  const entries = [
    person("d1", T0, "where should we eat"),
    { v: 1, id: "jg1", at: T0 + 10, kind: "judge", turn: "turndddd1", text: "DRAFT-ONE try Lugo's", by: "gates", round: 0, went: false, judges: [], failed: ["heard_them", "short_and_clean"], notice: "You answered a different question." },
    { v: 1, id: "jg2", at: T0 + 20, kind: "judge", turn: "turndddd1", text: "DRAFT-TWO a list", by: "code", round: 1, went: false, judges: [], failed: [] },
    { v: 1, id: "jg3", at: T0 + 30, kind: "judge", turn: "turndddd1", text: "Red Sorghum.", by: "gates", round: 2, went: true, judges: [], failed: [] },
    { v: 1, id: "rp9", at: T0 + 40, kind: "reply", turn: "turndddd1", text: "Red Sorghum.", ms: 31000 },
    tex("d2", T0 + 41, "turndddd1", ["d1"], "Red Sorghum."),
  ];
  const [turn] = pageViews(() => fakeLedger({ g: entries })).list("thinking", { chat: "g" }).items;
  assert.deepEqual(turn.drafts, [
    { text: "DRAFT-ONE try Lugo's", by: "gates", failed: ["heard_them", "short_and_clean"], notice: "You answered a different question." },
    { text: "DRAFT-TWO a list", by: "code", failed: [] },
  ]);
  assert.equal(turn.reply, "Red Sorghum.");
  const [plain] = pageViews(() => fakeLedger({ texts: oneToOne() })).list("thinking", { chat: "texts", limit: 1 }).items;
  assert.equal(plain.drafts, undefined, "a turn that went out first time shows none");
  assert.ok(sectionsForKinds(["judge"]).includes("thinking"));
});
