/**
 * `tex_dev` app view (`probe.js`): "app" is the person's own 1:1 with Tex, read as the app's text history. It lists
 * right after "me", resolves to the same chat and ledger as "me", and `turns` with `chat: "app"` keeps only the turns
 * whose asked text came from the app. Every view marks a turn asked from the app with `via: "app"`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { chatsOf, openChat, turnsOf } from "../../../packages/lab/gateway/texDev/probe.js";

/** A ledger with these entries, read the way `texStore/ledger.js` reads (seq order, since/until, kinds, before). */
function fakeLedger(entries) {
  const all = entries.map((e, i) => ({ v: 1, ...e, seq: i + 1 }));
  return {
    async read(_chat, { kinds = null, since = null, until = null, before = null, steps = null } = {}) {
      let out = all.filter((e) => (kinds ? kinds.includes(e.kind) : true) && (steps === null || e.kind !== "step" || steps.includes(e.step)) && (since === null || e.at >= since) && (until === null || e.at < until));
      if (before !== null) out = out.filter((e) => e.seq < before).reverse();
      return { entries: out };
    },
  };
}

const PAGE = { status: "ok", workspaceId: "ws_mine", timeZone: "America/New_York", chats: [] };
const T0 = Date.UTC(2026, 10, 14, 15, 0, 0);

// Seq 1 to 6: an iMessage ask, its reply, an app ask, its reply, an iMessage ask, its reply.
const LEDGER = fakeLedger([
  { id: "a", at: T0, kind: "text", from: { kind: "person" }, text: "book the table" },
  { id: "r1", at: T0 + 10, kind: "reply", turn: "t1", ms: 10, model: "haiku-5-5" },
  { id: "b", at: T0 + 100, kind: "text", from: { kind: "person" }, via: "app", text: "dinner friday" },
  { id: "r2", at: T0 + 110, kind: "reply", turn: "t2", ms: 10, model: "haiku-5-5" },
  { id: "c", at: T0 + 200, kind: "text", from: { kind: "person" }, text: "and sunday" },
  { id: "r3", at: T0 + 210, kind: "reply", turn: "t3", ms: 10, model: "haiku-5-5" },
]);

test("chatsOf lists the app view right after me", () => {
  const page = { ...PAGE, chats: [{ key: "d".repeat(64), name: "Trip", people: 3 }] };
  const listed = chatsOf(page);
  assert.deepEqual(listed.slice(0, 3), [{ chat: "me", name: "Just you and Tex" }, { chat: "app", name: "Tex in the app", via: "app" }, { chat: "d".repeat(64), name: "Trip", people: 3 }]);
  assert.equal(listed.filter((c) => c.chat === "app").length, 1);
});

test("chatsOf has no app entry when the own list has no me", () => {
  // pickerOf always lists "me" first, so there is no page that drops it: the app entry is placed only after it.
  const page = { ...PAGE, shared: [{ key: "u:usam", kind: "1:1", name: "@sam", sharedBy: ["sam"], owner: { person: "ws_sam" } }] };
  assert.ok(!chatsOf(page).filter((c) => c.shared).some((c) => c.chat === "app"));
});

test("openChat app resolves to me's chat and ledger, and says it was asked as the app view", () => {
  const owners = [];
  const ledgerOf = (_env, owner) => (owners.push(owner), LEDGER);
  const me = openChat({}, PAGE, "me", ledgerOf);
  const app = openChat({}, PAGE, "app", ledgerOf);
  assert.deepEqual(app.place, me.place);
  assert.equal(app.ledger, LEDGER);
  assert.equal(app.chat.key, "app");
  assert.equal(app.via, "app");
  assert.equal(me.via, undefined);
  assert.deepEqual(owners, [{ person: "ws_mine" }, { person: "ws_mine" }]);
});

test("turns with chat app keep only the turns asked from the app, marked via app", async () => {
  const answer = await turnsOf({}, PAGE, { chat: "app" }, { ledgerOf: () => LEDGER });
  assert.equal(answer.chat, "app");
  assert.deepEqual(answer.turns.map((t) => t.turn), ["t2"]);
  assert.equal(answer.turns[0].asked, "dinner friday");
  assert.equal(answer.turns[0].via, "app");
});

test("turns with chat me keeps every turn and marks only the app-asked one", async () => {
  const answer = await turnsOf({}, PAGE, { chat: "me" }, { ledgerOf: () => LEDGER });
  assert.deepEqual(answer.turns.map((t) => t.turn), ["t3", "t2", "t1"]);
  assert.equal(answer.turns[0].via, undefined);
  assert.equal(answer.turns[1].via, "app");
  assert.equal(answer.turns[2].via, undefined);
  assert.ok(!("via" in answer.turns[0]));
});

test("the app view's page size counts kept turns and pages back from the last kept one", async () => {
  const ledgerOf = () => LEDGER;
  const first = await turnsOf({}, PAGE, { chat: "app", limit: 1 }, { ledgerOf });
  assert.deepEqual(first.turns.map((t) => t.turn), ["t2"]);
  // The next page starts before t2's reply (seq 4); the iMessage turn t1 before it is filtered out, so nothing is kept.
  assert.equal(first.before, 4);
  const next = await turnsOf({}, PAGE, { chat: "app", limit: 1, before: first.before }, { ledgerOf });
  assert.deepEqual(next.turns, []);
});

test("an unknown key still throws as before", async () => {
  const ledgerOf = () => LEDGER;
  assert.throws(() => openChat({}, PAGE, "nope", ledgerOf), /no such chat/i);
  await assert.rejects(turnsOf({}, PAGE, { chat: "nope" }, { ledgerOf }), /no such chat/i);
});
