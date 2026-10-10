/**
 * A search across every workspace fuses the lists by evidence
 * (`tools/search.js` `fuseEverywhere`): the word rank in the hit's own
 * workspace, a loose any-word hit counted ten places lower, and one meaning
 * ranking across every workspace, since one model scored them all.
 *
 * Sabotage record (temporary local edits, reverted):
 *   meaning ranked per workspace instead of across them → "a note the query is about outranks another workspace's first word hit" fails
 *   the loose penalty dropped                           → "a loose any-word hit never outranks a real match" fails
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
  assert.deepEqual(fused.slice(0, 2), ["@wedding/vendors/caterer.md", "@band/index.md"]);
  assert.ok(fused.indexOf("todo.md") > fused.indexOf("@band/index.md"), "a word hit with no meaning behind it places after one the model also found");
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
