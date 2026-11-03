/**
 * A search across every workspace fuses the lists by evidence
 * (`tools/search.js` `fuseEverywhere`): the word rank in the hit's own
 * workspace, a loose any-word hit counted ten places lower, and one meaning
 * ranking across every workspace, since one model scored them all.
 *
 * Sabotage record (temporary local edits, reverted):
 *   meaning ranked per workspace instead of across them → "a note the query is about outranks another workspace's first word hit" fails
 *   the loose penalty dropped                           → "a loose any-word hit never outranks a real match" fails
 *   loose word evidence counted beside a real match     → "a note holding every word outranks another workspace's loose hit that meaning also found" fails
 *   the path prior dropped from the fused score         → "an archived or log note ranks below a live note…" and "a workspace prefix is read through…" fail
 *   the meaning-only budget removed                     → "meaning-only extras are three across every workspace…" fails
 *   the 0.5 floor removed from the strict-hit case      → "…under the 0.5 floor is left out even when the budget has room" fails
 *   the no-strict budget replaced by `extraNotes`       → "with no strict word hit anywhere, six…" fails
 *   the median meaning rank for an unfingerprinted hit removed → "a fresh strict word hit with no meaning score…" fails
 */

import test from "node:test";
import assert from "node:assert/strict";
import { fuseEverywhere } from "../src/tools/search.js";

const hit = (key, { wordRank = null, loose = false, meaningScore = null } = {}) => ({ key, title: key, snippets: [], wordRank, loose, meaningScore });

test("a note the query is about outranks another workspace's first word hit", () => {
  // The person's own workspace has a weak first word hit; the wedding
  // workspace's caterer note matches by word and by meaning.
  const own = [hit("todo.md", { wordRank: 0 })];
  const wedding = [hit("@wedding/vendors/caterer.md", { wordRank: 0, meaningScore: 0.62 }), hit("@wedding/budget.md", { wordRank: 1 })];
  const band = [hit("@band/index.md", { wordRank: 0, meaningScore: 0.41 })];
  const fused = fuseEverywhere([own, wedding, band]).map((entry) => entry.key);
  // The caterer note is still first. A strict word hit with no meaning score
  // now takes the median meaning rank (the fresh-note rule, see the test below),
  // so todo.md places between the caterer and the band note, not below the
  // band note. Changed on 2026-11-03 by that rule; the cost is noted there.
  assert.deepEqual(fused, ["@wedding/vendors/caterer.md", "todo.md", "@band/index.md", "@wedding/budget.md"]);
});

test("a loose any-word hit never outranks a real match, and ties keep this workspace first", () => {
  const own = [hit("notes/team-lunch.md", { wordRank: 0, loose: true })];
  const work = [hit("@work/people/team.md", { wordRank: 0 })];
  assert.deepEqual(fuseEverywhere([own, work]).map((entry) => entry.key), ["@work/people/team.md", "notes/team-lunch.md"]);
  const tied = fuseEverywhere([[hit("a.md", { wordRank: 0 })], [hit("@x/b.md", { wordRank: 0 })]]).map((entry) => entry.key);
  assert.deepEqual(tied, ["a.md", "@x/b.md"]);
});

test("a meaning-only note ranks by its closeness against every workspace's, and the list is bounded", () => {
  const lists = [
    [hit("m1.md", { meaningScore: 0.5 })],
    [hit("@x/m2.md", { meaningScore: 0.7 })],
    [hit("@y/m3.md", { meaningScore: 0.6 })],
  ];
  assert.deepEqual(fuseEverywhere(lists).map((entry) => entry.key), ["@x/m2.md", "@y/m3.md", "m1.md"]);
  const many = Array.from({ length: 30 }, (_, i) => [hit(`@w${i}/n.md`, { wordRank: 0 })]);
  assert.equal(fuseEverywhere(many).length, 12);
  assert.equal(fuseEverywhere(many, 3).length, 3);
});

test("a note holding every word outranks another workspace's loose hit that meaning also found", () => {
  // Production, 2026-11-03, "speed benchmark test note": the person's own note
  // holding all four words placed tenth, below other workspaces' index pages
  // that held one word and that meaning ranked low.
  const own = [hit("archive/chat-history/log.md", { wordRank: 0 }), hit("inbox/bench/single-4.md", { wordRank: 1 })];
  const other = [
    hit("@x/projects/benchmarks.md", { wordRank: 0, meaningScore: 0.6 }),
    hit("@x/a.md", { meaningScore: 0.55 }),
    hit("@x/b.md", { meaningScore: 0.5 }),
  ];
  const care = [hit("@care/index.md", { wordRank: 0, loose: true, meaningScore: 0.41 })];
  const fused = fuseEverywhere([own, other, care]).map((entry) => entry.key);
  assert.ok(fused.indexOf("inbox/bench/single-4.md") < fused.indexOf("@care/index.md"), fused.join(", "));
  // With no note holding every word anywhere, loose hits still rank by their words.
  const allLoose = fuseEverywhere([[hit("a.md", { wordRank: 0, loose: true })], [hit("@x/b.md", { wordRank: 1, loose: true })]]).map((entry) => entry.key);
  assert.deepEqual(allLoose, ["a.md", "@x/b.md"]);
});

/**
 * Meaning-only extras are one budget for the whole search, not one per
 * workspace: five workspaces used to show up to fifteen "Same topic" rows
 * beside the word hits. Production, 2026-11-03: the wanted note sat below
 * filler of exactly this kind.
 */
test("meaning-only extras are three across every workspace, at the 0.5 floor, once any word hit is strict", () => {
  const lists = [
    [hit("todo.md", { wordRank: 0 })],
    [hit("@a/m1.md", { meaningScore: 0.7 }), hit("@a/m2.md", { meaningScore: 0.45 })],
    [hit("@b/m3.md", { meaningScore: 0.65 }), hit("@b/m4.md", { meaningScore: 0.6 })],
    [hit("@c/m5.md", { meaningScore: 0.55 })],
    [hit("@d/m6.md", { meaningScore: 0.52 }), hit("@d/m7.md", { meaningScore: 0.51 })],
  ];
  const kept = fuseEverywhere(lists).map((entry) => entry.key);
  // The three closest above the floor; m2 is under it and the word hit stays.
  assert.deepEqual(kept, ["todo.md", "@a/m1.md", "@b/m3.md", "@b/m4.md"]);
});

test("with a strict word hit, a meaning-only hit under the 0.5 floor is left out even when the budget has room", () => {
  const lists = [[hit("todo.md", { wordRank: 0 })], [hit("@a/loose-meaning.md", { meaningScore: 0.45 })], [hit("@b/close.md", { meaningScore: 0.52 })]];
  assert.deepEqual(fuseEverywhere(lists).map((entry) => entry.key), ["todo.md", "@b/close.md"]);
});

test("with no strict word hit anywhere, six meaning-only extras at the old floor", () => {
  const scores = [0.9, 0.8, 0.7, 0.6, 0.5, 0.45, 0.44, 0.43];
  const lists = [
    [hit("team.md", { wordRank: 0, loose: true })],
    ...scores.map((score, i) => [hit(`@w${i % 4}/n${i}.md`, { meaningScore: score })]),
  ];
  const kept = fuseEverywhere(lists).map((entry) => entry.key);
  assert.equal(kept.filter((key) => key !== "team.md").length, 6);
  // 0.45 is kept here: the 0.5 floor is for a search where the words found a note.
  assert.ok(kept.includes("@w1/n5.md"));
  assert.ok(!kept.includes("@w2/n6.md"));
});

test("the extra budget is a setting, and a meaning-only hit in the answer is marked", () => {
  const hits = [hit("@a/m1.md", { meaningScore: 0.7 }), hit("@b/m2.md", { meaningScore: 0.6 })];
  const lists = [[hit("todo.md", { wordRank: 0 })], hits];
  const kept = fuseEverywhere(lists, 12, { extraNotes: 1 });
  assert.deepEqual(kept.map((entry) => entry.key), ["todo.md", "@a/m1.md"]);
  assert.equal(hits[0].meaningOnly, true);
  // Dropped by the budget, so not in the answer and not marked.
  assert.notEqual(hits[1].meaningOnly, true);
});

/**
 * A note not yet fingerprinted. The meaning index builds behind searches, so
 * a fresh note has no meaning score for a while, and it used to count as one
 * word rank and nothing else, below older notes that merely matched weakly
 * (production benchmark, 2026-11-03: fresh test notes ranked below unrelated
 * notes). While any hit has a meaning score, a strict word hit without one
 * takes the median meaning rank among those that have one.
 */
test("a fresh strict word hit with no meaning score is not buried under a weaker older hit", () => {
  const own = [hit("fresh.md", { wordRank: 0 })];
  const other = [
    hit("@x/a.md", { meaningScore: 0.6 }),
    hit("@x/b.md", { meaningScore: 0.55 }),
    hit("@x/weak.md", { wordRank: 1, meaningScore: 0.41 }),
    hit("@x/loose.md", { wordRank: 0, loose: true }),
  ];
  const fused = fuseEverywhere([own, other]).map((entry) => entry.key);
  assert.equal(fused[0], "fresh.md", fused.join(", "));
  assert.ok(fused.indexOf("fresh.md") < fused.indexOf("@x/weak.md"));
  // A loose hit gets no meaning contribution from the rule, so it stays below.
  assert.ok(fused.indexOf("@x/loose.md") > fused.indexOf("fresh.md"));
});

/**
 * The path prior (`search/priors.js`), applied to the fused score: with the
 * same evidence, an archived note or a log places below a live one, whichever
 * workspace it is in. Production, 2026-11-03: "2027 plan objectives owners"
 * put an archived chat log first and the plan's overview eleventh.
 */
test("an archived or log note ranks below a live note with the same evidence", () => {
  // Equal word rank, no meaning: the list order used to decide, and the log was listed first.
  const own = [hit("archive/chat-history/2027-plan.md", { wordRank: 0 }), hit("inbox/email/2026-10.md", { wordRank: 0 })];
  const plans = [hit("@plans/2027/objectives.md", { wordRank: 0 })];
  assert.deepEqual(fuseEverywhere([own, plans]).map((entry) => entry.key), ["@plans/2027/objectives.md", "archive/chat-history/2027-plan.md", "inbox/email/2026-10.md"]);
});

test("meetings and ordinary notes are not demoted", () => {
  const own = [hit("inbox/meetings/2026-10-30 standup.md", { wordRank: 0 })];
  const work = [hit("@work/projects/live.md", { wordRank: 0 })];
  assert.deepEqual(fuseEverywhere([own, work]).map((entry) => entry.key), ["inbox/meetings/2026-10-30 standup.md", "@work/projects/live.md"]);
});

test("a workspace prefix is read through before the prior is decided", () => {
  const old = [hit("@old/archive/a.md", { wordRank: 0 })];
  const live = [hit("@new/projects/b.md", { wordRank: 0 })];
  assert.deepEqual(fuseEverywhere([old, live]).map((entry) => entry.key), ["@new/projects/b.md", "@old/archive/a.md"]);
});

test("a log still shows when nothing else matches", () => {
  const own = [hit("archive/chat-history/only.md", { wordRank: 0 })];
  assert.deepEqual(fuseEverywhere([own]).map((entry) => entry.key), ["archive/chat-history/only.md"]);
});
