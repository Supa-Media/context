/**
 * A 1:1 turn is shown its older days faded by age (`ledgerHistory.js` `faded`; Dev2, 2026-11-06: "weight recent
 * heavier, keep old in context"): the days before the last whole, then clipped, Tex's own answers most, every link
 * kept; and the oldest day whole or not at all, so the cached history moves once a day.
 *
 * Sabotage record (local edit, reverted): showing `shown` unfaded in `loggedTurn.js`'s transcript fails "a 1:1 turn
 * is shown its older days faded".
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { FADE, earlierFromLedger, faded } from "../src/agent/ledgerHistory.js";

const DAY = 86_400_000;
const BEFORE = Date.UTC(2026, 10, 6, 9);
let n = 0;
const entry = (daysAgo, who, text) => {
  n += 1;
  const at = BEFORE - daysAgo * DAY - n * 1000;
  return { kind: "text", event: "text", eid: `${at}-${String(n).padStart(6, "0")}`, at, from: { kind: who === "tex" ? "tex" : "person" }, text };
};

test("the nearer days are whole; older ones are clipped, Tex's answers most", () => {
  const long = "x".repeat(2_000);
  assert.equal(faded({ at: BEFORE - DAY, from: { kind: "tex" }, text: long }, BEFORE).text, long, "yesterday is whole");
  const three = faded({ at: BEFORE - 3 * DAY, from: { kind: "tex" }, text: long }, BEFORE).text;
  assert.ok(three.startsWith("x".repeat(FADE[0].tex)) && three.endsWith("… [cut]"), three.slice(-20));
  assert.equal(faded({ at: BEFORE - 3 * DAY, from: { kind: "person" }, text: long }, BEFORE).text, long, "their own words stay whole that week");
  assert.equal(faded({ at: BEFORE - 10 * DAY, from: { kind: "person" }, text: long }, BEFORE).text.length, FADE[1].them + "… [cut]".length);
  assert.equal(faded({ at: BEFORE - 40 * DAY, from: { kind: "tex" }, text: long }, BEFORE).text.length, FADE[2].tex + "… [cut]".length);
  assert.equal(faded({ at: BEFORE - 40 * DAY, from: { kind: "tex" }, text: "Done." }, BEFORE).text, "Done.");
});

test("a clipped text keeps every link it held", () => {
  const text = `${"Here is the page I made for the trip. ".repeat(20)}https://context.lc/note/@maya/trip.md and the draft https://mail.google.com/x`;
  const shown = faded({ at: BEFORE - 12 * DAY, from: { kind: "tex" }, text }, BEFORE).text;
  assert.match(shown, /\[cut; links: https:\/\/context\.lc\/note\/@maya\/trip\.md https:\/\/mail\.google\.com\/x\]$/);
});

test("faded, the oldest day is shown whole or not at all, and unfaded nothing changes", () => {
  const newestFirst = [entry(1, "them", "a".repeat(300)), entry(1, "tex", "b".repeat(300)), entry(2, "them", "c".repeat(300)), entry(2, "tex", "d".repeat(300))];
  // Room for three texts: the fourth would split day two.
  const room = 3 * 340 + 10;
  const fadedDays = earlierFromLedger(newestFirst, "c", { before: BEFORE, chars: room, fade: true }).events;
  assert.deepEqual(fadedDays.map((event) => event.text[0]), ["b", "a"], "day two dropped whole");
  const plain = earlierFromLedger(newestFirst, "c", { before: BEFORE, chars: room }).events;
  assert.deepEqual(plain.map((event) => event.text[0]), ["c", "b", "a"], "the History page and others still fill to the character");
  const all = earlierFromLedger(newestFirst, "c", { before: BEFORE, fade: true }).events;
  assert.equal(all.length, 4, "with room, every day is shown");
});

test("a 1:1 turn is shown its older days faded, today whole", async () => {
  const { loggedTurn } = await import("../src/agent/loggedTurn.js");
  const { eventEntry } = await import("../src/agent/ledger.js");
  const { texLedger } = await import("../src/texStore/ledger.js");
  const { durableSql } = await import("./texStoreFixture.mjs");
  const now = Date.UTC(2026, 10, 6, 15);
  const old = now - 12 * DAY;
  const ask = `${now}-000900`;
  const ledger = texLedger(durableSql());
  ledger.append("texts", [
    eventEntry({ id: `${old}-000801`, at: old, chat: "texts", from: { kind: "person", name: "maya" }, kind: "text", text: "plan the trip" }),
    eventEntry({ id: `${old + 1000}-000802`, at: old + 1000, chat: "texts", from: { kind: "tex" }, kind: "text", text: `OLD-ANSWER ${"y".repeat(1_000)} TAIL-OF-OLD`, delivered: true }),
    eventEntry({ id: `${now - 5000}-000803`, at: now - 5000, chat: "texts", from: { kind: "tex" }, kind: "text", text: `TODAY ${"z".repeat(1_000)} TAIL-OF-TODAY`, delivered: true }),
    eventEntry({ id: ask, at: now, chat: "texts", from: { kind: "person", name: "maya" }, kind: "text", text: "and now?" }),
  ]);
  const read = { entries: ledger.read("texts", { before: Number.MAX_SAFE_INTEGER }).entries, chat: "texts" };
  const turn = await loggedTurn({}, { chat: "texts", covers: [ask] }, { ledger: Promise.resolve(read) });
  const shown = turn.history[0].text;
  assert.match(shown, /OLD-ANSWER y+… \[cut\]/);
  assert.doesNotMatch(shown, /TAIL-OF-OLD/);
  assert.match(shown, /TAIL-OF-TODAY/, "today's texts are whole");
});
