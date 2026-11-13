/**
 * The judge's brief (Dev2, 2026-11-12; `src/agent/judgeBrief.js`): when a group turn ends, what it knew (its work,
 * what Tex waits on, the chat's about note and instructions) is kept in the chat's ledger, and the judge reads it.
 * In the Puttery case the judge called a follow-up about a booking Tex was filling "people talking" because it could
 * not see that work. The chats here are invented.
 *
 * Sabotage record (2026-11-12): `nowFacts` not reading `brief` entries fails "the judge reads the newest briefs";
 * `briefFacts` ignoring BRIEF_FRESH_MS fails "old work is not shown as something Tex is handling".
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { BRIEF_FRESH_MS, briefEntry, briefFacts } from "../src/agent/judgeBrief.js";
import { nowFacts } from "../src/agent/textsDecide.js";

const T0 = Date.UTC(2026, 10, 12, 18, 0, 0);
const GROUP = { key: "c3".repeat(32), from: "ada", people: ["ada"], aboutUs: "Ada's birthday crew.\nBooking golf for 20 on the 21st (Ada said so)." };

test("a group turn's brief keeps its work, its places, what it waits on and the chat's rules", () => {
  const entry = briefEntry({
    group: GROUP,
    question: "book the mini golf place for 20\npeople",
    steps: [
      { tool: "browse", ok: true, sources: ["https://www.minigolf.example/book?x=1"] },
      { tool: "fill_card", ok: true },
      { tool: "ask_advisor", ok: true },
      { tool: "read_note", ok: true, sources: ["tex/groups/a/plan.md"] },
    ],
    asked: [{ id: "a1", tool: "fill_card" }],
    instructions: "Only answer when tagged.",
    turn: "t1",
    at: T0,
  });
  assert.equal(entry.kind, "brief");
  assert.equal(entry.asker, "ada");
  assert.equal(entry.ask, "book the mini golf place for 20 people");
  assert.deepEqual(entry.tools, ["browse", "fill_card", "read_note"]);
  assert.deepEqual(entry.places, ["minigolf.example", "tex/groups/a/plan.md"]);
  assert.deepEqual(entry.waiting, ["@ada's yes for fill_card"]);
  assert.equal(entry.rules, "Only answer when tagged.");
  assert.match(entry.about, /^Ada's birthday crew\. Booking golf/);
  assert.equal(briefEntry({ group: null, question: "x" }), null);
});

test("the judge's facts name recent work, what Tex waits on, the instructions, then the about note", () => {
  const facts = briefFacts(
    [
      briefEntry({ group: GROUP, question: "is it the one downtown?", steps: [], instructions: "Only answer when tagged.", at: T0 - 60_000 }),
      briefEntry({ group: GROUP, question: "book the mini golf place for 20", steps: [{ tool: "browse", ok: true, sources: ["https://minigolf.example/"] }], at: T0 - 120_000 }),
    ],
    { now: T0 },
  );
  assert.deepEqual(facts, [
    `Tex worked on @ada's ask "book the mini golf place for 20" at 17:58 UTC: browse on minigolf.example.`,
    "This chat's instructions to Tex: Only answer when tagged.",
    "This chat's about note: Ada's birthday crew. Booking golf for 20 on the 21st (Ada said so).",
  ]);
});

test("old work is not shown as something Tex is handling", () => {
  const old = briefEntry({ group: GROUP, question: "book it", steps: [{ tool: "browse", ok: true }], asked: [{ tool: "fill_card" }], at: T0 - BRIEF_FRESH_MS - 1 });
  const facts = briefFacts([old], { now: T0 });
  assert.ok(!facts.some((fact) => fact.startsWith("Tex worked") || fact.startsWith("Tex is waiting")));
  assert.ok(facts.some((fact) => fact.startsWith("This chat's about note")));
});

test("the judge reads the newest briefs beside the chat, the about note last", async () => {
  const brief = briefEntry({ group: GROUP, question: "book the mini golf place", steps: [{ tool: "browse", ok: true }], at: T0 - 1_000 });
  const store = { read: async (chat, options) => (options.kinds?.includes("brief") ? { entries: [brief] } : { entries: [] }) };
  const facts = await nowFacts(store, GROUP.key, { now: T0 });
  assert.match(facts[0], /^Tex worked on @ada's ask "book the mini golf place"/);
  assert.match(facts.at(-1), /^This chat's about note:/);
});
