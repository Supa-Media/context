/**
 * CONVERSATIONS BACKFILL (`src/agent/threadsBackfill.js`, `threadsBackfillDoor.js`; Dev2, 2026-11-07: "did we
 * backfill threads and conversations?", then "Backfill full history").
 *
 * Sabotage record (2026-11-07), each applied, this file run, named test failing, reverted:
 *  1. replaying texts newer than the first live thread entry → "only texts older than the chat's live threads…" fails.
 *  2. ignoring the `done` mark → "a chat's whole history is replayed oldest first…" fails (second run classifies again).
 *  3. `readThreads` reading one page only → "the threads ledger is read past one page" fails.
 *  4. the door not checking the ticket's owners → "the door wants the gateway secret and a ticket for that chat" fails.
 *  5. the retry not marking a turn it missed again → "after the replay, the turns left unsorted are asked once more…" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { readThreads, threadsChat } from "../src/agent/conversationThreads.js";
import { answeredTurns, backfillThreads, DONE_ID } from "../src/agent/threadsBackfill.js";
import { handleThreadsBackfill } from "../src/agent/threadsBackfillDoor.js";

const SECRET = "s".repeat(32);

function fakeLedger(chats = {}, pageSize = 5000) {
  const kept = Object.fromEntries(Object.entries(chats).map(([chat, list]) => [chat, list.map((entry, i) => ({ ...entry, seq: i + 1 }))]));
  return {
    kept,
    async read(chat, { after = 0, kinds = null, limit = 5000 } = {}) {
      const all = (kept[chat] ?? []).filter((entry) => entry.seq > after && (kinds === null || kinds.includes(entry.kind)));
      const size = Math.min(limit, pageSize);
      const entries = all.slice(0, size);
      return { entries, ...(all.length > size ? { next: entries.at(-1).seq } : {}) };
    },
    async append(chat, list) {
      const rows = (kept[chat] ??= []);
      let added = 0;
      for (const entry of list) {
        if (rows.some((row) => row.id === entry.id)) continue;
        rows.push({ ...entry, seq: rows.length + 1 });
        added += 1;
      }
      return { added };
    },
  };
}

const text = (eid, at, words, extra = {}) => ({ v: 1, id: `ev${eid}`, eid, at, kind: "text", event: "text", from: { kind: "person", name: "dana" }, text: words, ...extra });
const tex = (eid, at, words, covers) => ({ v: 1, id: `ev${eid}`, eid, at, kind: "text", event: "text", from: { kind: "tex" }, text: words, ...(covers ? { covers } : {}) });

/** A classifier that answers from a script, and remembers what it was shown. */
function scripted(answers) {
  const seen = [];
  const classify = async (input) => {
    seen.push(input);
    const next = answers.shift();
    return next === undefined ? null : next;
  };
  return { classify, seen };
}

const HISTORY = [
  text("a1", 1000, "find me a hotel in Lisbon"),
  tex("b1", 1100, "Memmo Alfama, $172", ["a1"]),
  text("a2", 2000, "and the dentist on Thursday?"),
  text("a3", 2010, "at 3"),
  tex("b2", 2100, "Booked, Thursday at 3"), // an older answer naming no texts: the ones since the last answer
  text("a4", 3000, "book the hotel"),
  tex("b3", 3100, "Booked Memmo", ["a4"]),
];

test("answered turns: the texts an answer covers, or the ones since the answer before", () => {
  const turns = answeredTurns(HISTORY.map((entry) => ({ ...entry, id: entry.eid })));
  assert.deepEqual(turns.map((turn) => [turn.covered, turn.at]), [[["a1"], 1000], [["a2", "a3"], 2010], [["a4"], 3000]]);
});

test("a chat's whole history is replayed oldest first, marked, and then left alone", async () => {
  const ledger = fakeLedger({ texts: HISTORY });
  const { classify, seen } = scripted([
    { thread: "new", title: "Lisbon hotel", description: "wants a hotel", finished: [] },
    { thread: "new", title: "Dentist", description: "Thursday at 3", finished: [] },
    { thread: "t1", title: "Lisbon hotel", description: "booking Memmo", finished: ["t2"] },
  ]);
  const first = await backfillThreads({ ledger, chat: "texts", classify });
  assert.deepEqual(first, { state: "finished", turns: 3, written: 4, failed: 0, left: 0 });
  assert.match(seen[1].question, /dentist on Thursday\?\nat 3/);
  assert.equal(seen[2].threads.length, 2, "the third turn is shown the threads the first two made");
  const { threads } = await readThreads(ledger, "texts");
  assert.deepEqual(threads.map((thread) => [thread.id, thread.status, thread.texts]), [["t1", "open", ["a1", "a4"]], ["t2", "finished", ["a2", "a3"]]]);
  const rows = ledger.kept[threadsChat("texts")];
  assert.ok(rows.every((row) => row.backfill === true));
  assert.equal(rows.find((row) => row.thread === "t2" && row.status === "open").at, 2010, "dated by its newest text");
  assert.ok(rows.some((row) => row.id === DONE_ID));
  const again = scripted([]);
  assert.equal((await backfillThreads({ ledger, chat: "texts", classify: again.classify })).state, "done");
  assert.equal(again.seen.length, 0);
});

test("only texts older than the chat's live threads are replayed, and new ids count past the live ones", async () => {
  const ledger = fakeLedger({
    texts: HISTORY,
    [threadsChat("texts")]: [{ v: 1, id: "th3000t1", at: 3000, kind: "thread", thread: "t1", status: "open", title: "Hotel booking", texts: ["a4"] }],
  });
  const { classify, seen } = scripted([
    { thread: "new", title: "Lisbon hotel", description: "wants a hotel", finished: [] },
    { thread: "new", title: "Dentist", description: "Thursday", finished: [] },
  ]);
  const ran = await backfillThreads({ ledger, chat: "texts", classify });
  assert.equal(ran.turns, 2, "a4 is the live thread's: not replayed");
  assert.equal(seen[0].threads.length, 0, "the classifier is never shown a live thread");
  const { threads } = await readThreads(ledger, "texts");
  assert.deepEqual(threads.map((thread) => thread.id).sort(), ["t1", "t2", "t3"]);
  assert.deepEqual(threads.find((thread) => thread.id === "t1").texts, ["a4"], "the live thread keeps its own texts");
});

test("a part stops at its budget and the next one goes on where it stopped", async () => {
  const ledger = fakeLedger({ texts: HISTORY });
  const one = scripted([{ thread: "new", title: "Lisbon hotel", description: "d", finished: [] }]);
  assert.deepEqual(await backfillThreads({ ledger, chat: "texts", classify: one.classify, budget: 1 }), { state: "partly", turns: 1, written: 1, failed: 0, left: 2 });
  const two = scripted([
    { thread: "new", title: "Dentist", description: "d", finished: [] },
    { thread: "t1", title: "Lisbon hotel", description: "d", finished: [] },
  ]);
  const rest = await backfillThreads({ ledger, chat: "texts", classify: two.classify });
  assert.equal(rest.state, "finished");
  assert.equal(rest.turns, 2);
  assert.deepEqual(two.seen.map((input) => input.question), ["and the dentist on Thursday?\nat 3", "book the hotel"]);
});

test("a dry run counts and writes nothing; a turn the classifier fails twice is passed over", async () => {
  const ledger = fakeLedger({ texts: HISTORY });
  const dry = await backfillThreads({ ledger, chat: "texts", classify: async () => assert.fail("no call on a dry run"), dryRun: true });
  assert.deepEqual(dry, { state: "would", turns: 0, written: 0, failed: 0, left: 3 });
  assert.equal(ledger.kept[threadsChat("texts")], undefined);
  const { classify, seen } = scripted([null, null, { thread: "new", title: "Dentist", description: "d", finished: [] }, { thread: "t1", title: "Dentist", description: "d", finished: [] }]);
  const ran = await backfillThreads({ ledger, chat: "texts", classify });
  assert.equal(seen.length, 4, "the failed turn is asked twice");
  assert.equal(ran.failed, 1);
  assert.equal(ran.state, "finished");
});

test("after the replay, the turns left unsorted are asked once more, then never again", async () => {
  const ledger = fakeLedger({ texts: HISTORY });
  const first = scripted([{ thread: "new", title: "Lisbon hotel", description: "d", finished: [] }, null, null, { thread: "t1", title: "Lisbon hotel", description: "d", finished: [] }]);
  assert.equal((await backfillThreads({ ledger, chat: "texts", classify: first.classify })).failed, 1);
  const again = scripted([{ thread: "new", title: "Dentist", description: "Thursday", finished: [] }]);
  const retried = await backfillThreads({ ledger, chat: "texts", classify: again.classify });
  assert.deepEqual(retried, { state: "finished", turns: 1, written: 1, failed: 0, left: 0 });
  assert.equal(again.seen[0].threads.length, 1, "shown the threads as they stood at its time: t1 only");
  const { threads } = await readThreads(ledger, "texts");
  assert.deepEqual(threads.find((thread) => thread.title === "Dentist").texts, ["a2", "a3"]);
  assert.equal(threads.find((thread) => thread.title === "Dentist").id, "t2");
  const third = scripted([]);
  assert.equal((await backfillThreads({ ledger, chat: "texts", classify: third.classify })).state, "done");
  assert.equal(third.seen.length, 0);
  // One missed again is marked and left.
  const other = fakeLedger({ texts: HISTORY });
  await backfillThreads({ ledger: other, chat: "texts", classify: scripted([{ thread: "new", title: "A", description: "d", finished: [] }, null, null, { thread: "t1", title: "A", description: "d", finished: [] }]).classify });
  assert.equal((await backfillThreads({ ledger: other, chat: "texts", classify: scripted([null]).classify })).failed, 1);
  const last = scripted([]);
  assert.equal((await backfillThreads({ ledger: other, chat: "texts", classify: last.classify })).state, "done");
  assert.equal(last.seen.length, 0);
});

test("the threads ledger is read past one page", async () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ v: 1, id: `th${i}`, at: 100 + i, kind: "thread", thread: `t${i + 1}`, status: "open", title: `T${i}`, texts: [`x${i}`] }));
  const { threads } = await readThreads(fakeLedger({ [threadsChat("texts")]: many }, 5), "texts");
  assert.equal(threads.length, 12);
});

function doorRequest({ secret = SECRET, ticket = "tk", owner = "person:ws1" } = {}) {
  return new Request("https://gateway.test/internal/threads/backfill", {
    method: "POST",
    headers: { ...(secret ? { authorization: `Bearer ${secret}` } : {}), "x-tex-ticket": ticket, "content-type": "application/json" },
    body: JSON.stringify({ owner, dryRun: true }),
  });
}

test("the door wants the gateway secret and a ticket for that chat, and answers counts only", async () => {
  const env = { GATEWAY_SECRET: SECRET, AI_GATEWAY_ACCOUNT_ID: "a".repeat(32), AI_GATEWAY_ID: "gw", AI_GATEWAY_TOKEN: "t".repeat(40) };
  const controlPlane = { openTexStoreTicket: async (ticket) => (ticket === "tk" ? { workspaceId: "ws1", owners: ["person:ws1"] } : null) };
  const deps = { controlPlane, ledger: fakeLedger({ texts: HISTORY }) };
  assert.equal((await handleThreadsBackfill(doorRequest({ secret: "wrong".repeat(8) }), env, deps)).status, 401);
  assert.equal((await handleThreadsBackfill(doorRequest({ ticket: "other" }), env, deps)).status, 403);
  assert.equal((await handleThreadsBackfill(doorRequest({ owner: "person:ws2" }), env, deps)).status, 403);
  assert.equal((await handleThreadsBackfill(doorRequest({ owner: "chat:nothex" }), env, deps)).status, 400);
  const ok = await handleThreadsBackfill(doorRequest(), env, deps);
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.deepEqual(body, { state: "would", turns: 0, written: 0, failed: 0, left: 3 });
  assert.doesNotMatch(JSON.stringify(body), /Lisbon|hotel/);
});
