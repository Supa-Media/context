/**
 * The days before today keep the same cut from one text to the next (`ledgerHistory.js` `ROOM_STEP`; Dev2, 2026-11-14:
 * "lets just look into the cache misses"). Measured that day in a 1:1 chat: the transcript went 496, 522, 522, 496, 522
 * lines on texts minutes apart, because the room left for earlier days moved with every text's size (and with which
 * texts the stretch carried as messages), so the oldest day dropped out or came back and the 30,000 to 60,000 tokens
 * after it were written to the cache again.
 *
 * Sabotage (2026-11-14, a temporary local edit, reverted): `earlierRoom` returning `READ_CHARS - todayChars` → "two
 * texts minutes apart" fails for some of the oldest day's sizes.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { loggedTurn } from "../src/agent/loggedTurn.js";
import { earlierRoom, ROOM_STEP } from "../src/agent/ledgerHistory.js";
import { READ_CHARS } from "../src/agent/log.js";

const KEY = "a".repeat(64);
const ME = "b".repeat(64);
const DAY = 86_400_000;

function chat(now, pad) {
  let seq = 0;
  const entries = [];
  const add = (at, from, text, extra = {}) => {
    const entry = { v: 1, seq: ++seq, kind: "text", eid: `${at}-${String(seq).padStart(6, "0")}`, event: "text", at, from, text, ...extra };
    entries.push(entry);
    return entry;
  };
  // Eight earlier days of about 14,000 characters each, the oldest padded so its edge falls anywhere: more than the room holds.
  const today = now - (now % DAY);
  for (let d = 8; d >= 1; d -= 1) {
    for (let i = 0; i < 10; i += 1) {
      const at = today - d * DAY + i * 3_600_000;
      const asked = add(at, { kind: "person", who: ME }, `ask ${d}.${i} ${"y".repeat(d === 8 && i === 0 ? pad : 400)}`);
      add(at + 60_000, { kind: "tex" }, `answer ${d}.${i} ${"x".repeat(900)}`, { covers: [asked.eid], delivered: true });
    }
  }
  // Today so far: a few thousand characters.
  for (let i = 0; i < 6; i += 1) {
    const asked = add(today + i * 600_000, { kind: "person", who: ME }, `today ${i} ${"z".repeat(700)}`);
    add(today + i * 600_000 + 30_000, { kind: "tex" }, `done ${i}`, { covers: [asked.eid], delivered: true });
  }
  return { entries, add };
}

async function transcript(state, text) {
  const read = { entries: [...state.entries].sort((a, b) => b.at - a.at), chat: KEY, ledger: { read: async () => ({ entries: [] }) } };
  const logged = await loggedTurn({}, { covers: [text.eid], chat: KEY, question: text.text }, { ledger: Promise.resolve(read) });
  return logged.history[0]?.text ?? "";
}

test("two texts minutes apart start with the same transcript, wherever the oldest day's edge falls", async () => {
  const now = Date.UTC(2026, 10, 14, 15, 0);
  for (let pad = 0; pad <= 14_000; pad += 700) {
    const state = chat(now, pad);
    const first = state.add(now, { kind: "person", who: ME }, `first ${"q".repeat(300)}`);
    const before = await transcript(state, first);
    state.add(now + 20_000, { kind: "tex" }, `reply ${"r".repeat(600)}`, { covers: [first.eid], delivered: true });
    const second = state.add(now + 5 * 60_000, { kind: "person", who: ME }, "second");
    const after = await transcript(state, second);
    assert.ok(after.startsWith(before), `pad ${pad}: everything the first text was shown is the start of what the second is shown`);
  }
});

test("the earlier days' room moves only in whole steps", () => {
  assert.equal(earlierRoom(0), READ_CHARS);
  assert.equal(earlierRoom(1), READ_CHARS - ROOM_STEP);
  assert.equal(earlierRoom(ROOM_STEP), READ_CHARS - ROOM_STEP);
  assert.equal(earlierRoom(ROOM_STEP + 1), READ_CHARS - 2 * ROOM_STEP);
  assert.equal(earlierRoom(10 * READ_CHARS), 0);
});
