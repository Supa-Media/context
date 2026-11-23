import test from "node:test";
import assert from "node:assert/strict";
import { failedSearchesOf, hitsOf, searchOutcomes } from "../../../packages/lab/gateway/texDev/failedSearches.js";

const T0 = Date.UTC(2026, 10, 20, 15, 0, 0);
const answer = (...paths) => `${paths.length}+ matching notes — the ${paths.length} best shown\n\n${paths.map((p) => `${p}\n    …a snippet line.md…`).join("\n\n")}`;

const ENTRIES = [
  // t1: searched again with nothing opened, then the second search's 3rd hit was read.
  { kind: "tool", turn: "t1", at: T0, name: "search_notes", ok: true, args: { query: "YC founders video" }, result: answer("@ctx/areas/reviews/a.md", "@ctx/areas/reviews/b.md") },
  { kind: "tool", turn: "t1", at: T0 + 5_000, name: "search_notes", ok: true, args: { query: "Y Combinator application video" }, result: answer("@pw/stack.md", "@ctx/areas/reviews/a.md", "@seyi/projects/yc/application.md") },
  { kind: "tool", turn: "t1", at: T0 + 9_000, name: "read_note", ok: true, args: { path: "projects/yc/application.md" } },
  { kind: "tool", turn: "t1", at: T0 + 9_500, name: "read_note", ok: true, args: { path: "tex/voice.md" } },
  // t2: opened its first hit: counted, never listed.
  { kind: "tool", turn: "t2", at: T0 + 60_000, name: "search", ok: true, args: { query: "coffee union square" }, result: answer("@seyi/coffee.page.md") },
  { kind: "tool", turn: "t2", at: T0 + 61_000, name: "fetch", ok: true, args: { id: "@seyi/coffee.page.md" } },
  // t3: an email search is not a note search; the note search after it gave up.
  { kind: "tool", turn: "t3", at: T0 + 120_000, name: "search", ok: true, args: { query: "invoice", args: { email: true } }, result: "From their Gmail" },
  { kind: "tool", turn: "t3", at: T0 + 121_000, name: "search_notes", ok: true, args: { query: "EIN relay todo" }, result: answer("tex/dreams/2026-10-29.md") },
];

test("a search's answer lists its hits, one unindented line each", () => {
  assert.deepEqual(hitsOf(answer("@a/x.md", "b/y.page.md")), ["@a/x.md", "b/y.page.md"]);
  assert.deepEqual(hitsOf("No notes match."), []);
});

test("each note search says how it went: again, opened low, opened first, gave up", () => {
  const all = searchOutcomes(ENTRIES);
  const by = Object.fromEntries(all.map((s) => [s.query, s]));
  assert.equal(by["YC founders video"].outcome, "again");
  assert.equal(by["YC founders video"].next, "Y Combinator application video");
  assert.deepEqual(by["YC founders video"].read, [{ path: "projects/yc/application.md", rank: null }]);
  assert.equal(by["Y Combinator application video"].outcome, "opened_low");
  assert.equal(by["Y Combinator application video"].openedRank, 3);
  assert.equal(by["coffee union square"].outcome, "opened_first");
  assert.equal(by["EIN relay todo"].outcome, "gave_up");
  assert.equal(by.invoice, undefined, "an email search is not a note search");
});

test("failed_searches reads the chat's tool calls once and lists only the failures, newest first", async () => {
  const reads = [];
  const ledger = {
    async read(_chat, opts) {
      reads.push(opts);
      return { entries: ENTRIES.map((e, i) => ({ ...e, seq: i + 1 })).reverse() };
    },
  };
  const page = { status: "ok", workspaceId: "ws", timeZone: "UTC", chats: [], me: { person: "p1" } };
  const out = await failedSearchesOf({}, page, { days: 3 }, { ledgerOf: () => ledger, now: T0 + 3_600_000 });
  assert.equal(out.error, undefined, String(out.error));
  assert.equal(reads.length, 1);
  assert.deepEqual(reads[0].kinds, ["tool"]);
  assert.equal(reads[0].since, T0 + 3_600_000 - 3 * 86_400_000);
  assert.deepEqual(out.counts, { searches: 4, again: 1, opened_low: 1, opened_first: 1, gave_up: 1 });
  assert.deepEqual(out.searches.map((s) => s.query), ["EIN relay todo", "Y Combinator application video", "YC founders video"]);
  const again = await failedSearchesOf({}, page, { outcome: "again" }, { ledgerOf: () => ledger, now: T0 });
  assert.deepEqual(again.searches.map((s) => s.query), ["YC founders video"]);
  assert.match((await failedSearchesOf({}, page, { outcome: "bad" }, { ledgerOf: () => ledger })).error, /outcome is/);
});

test("a read is ranked at its own workspace's hit, not a same-named note in another workspace", () => {
  const [s] = searchOutcomes([
    { kind: "tool", turn: "w", at: T0, name: "search_notes", ok: true, args: { query: "brand about" }, result: answer("@a/resources/brand/about.md", "@b/resources/brand/about.md") },
    { kind: "tool", turn: "w", at: T0 + 1_000, name: "read_note", ok: true, args: { path: "@b/resources/brand/about.md" } },
  ]);
  assert.equal(s.outcome, "opened_low");
  assert.equal(s.openedRank, 2);
});

test("a search whose answer was withheld (another workspace's) is counted as withheld, never as a miss", () => {
  const [s] = searchOutcomes([
    { kind: "tool", turn: "h", at: T0, name: "search_notes", ok: true, args: { query: "shared plan", context: "@other" }, withheld: "other_workspace" },
    { kind: "tool", turn: "h", at: T0 + 1_000, name: "read_note", ok: true, args: { path: "@other/plan.md" } },
  ]);
  assert.equal(s.outcome, "withheld");
});

test("two searches in one round are not a retry: the first still opens its top hit after both", () => {
  const [first] = searchOutcomes([
    { kind: "tool", turn: "p", at: T0, name: "search_notes", ok: true, args: { query: "lease section 9" }, result: answer("@flat/lease.md") },
    { kind: "tool", turn: "p", at: T0, name: "search_notes", ok: true, args: { query: "rent split" }, result: answer("@flat/bills.md") },
    { kind: "tool", turn: "p", at: T0 + 2_000, name: "read_note", ok: true, args: { path: "@flat/lease.md" } },
  ]).filter((s) => s.query === "lease section 9");
  assert.equal(first.outcome, "opened_first");
});

