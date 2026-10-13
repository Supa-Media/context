/**
 * THE CHAOS SCORE COUNTED FROM THE CONVEX TREE'S KEYS.
 *
 * `chaos/live.js` scores the keys the tree hands a reader, with only long
 * notes, meetings and contact reviews taken from the tree's facts. Over the
 * same notes it must give the rubric's numbers for both audiences, never name
 * a folder or a long note the team cannot open, and follow a folder that
 * moved. The facts here are made the way the control plane makes them: from
 * each note's `propsOf`, `isExempt` and `hasReview`.
 *
 * Sabotage-checked: scoring the team numbers over every key fails "the team
 * numbers"; dropping `present` names a long note that has gone; dropping the
 * team-exists check names a private folder to the team.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { propsOf } from "../src/tree/props.js";
import { LONG_NOTE_LINES, hasReview, isExempt, scoreTree } from "../src/chaos/rubric.js";
import { folderNumbers, liveSummary, liveTotals, scoreKeys } from "../src/chaos/live.js";
import { CONTACTS_FOLDER } from "../../../packages/communications/src/protocol.js";

const notPrivate = (path) => !path.startsWith("2-areas/private/");
const long = (n) => Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");

function workspace() {
  const texts = { "index.md": "# Home" };
  for (const word of "plan budget people risks notes ideas launch review hiring roadmap legal design".split(" ")) {
    texts[`1-projects/big/${word}.md`] = `# ${word}`;
  }
  texts["1-projects/big/novel.md"] = long(1500);
  texts["1-projects/small/a.md"] = "# a";
  texts["2-areas/private/secret.md"] = long(2400);
  texts["2-areas/private/other.md"] = "# other";
  texts["2-areas/health.md"] = "# health";
  texts["0-inbox/meetings/2026-10-01-standup.md"] = long(3000);
  texts[`${CONTACTS_FOLDER}/a/ana.md`] = "---\nreview: is this the same Ana?\n---\n# Ana";
  texts[`${CONTACTS_FOLDER}/b/bo.md`] = "# Bo";
  texts["4-archive/old/huge.md"] = long(5000);
  return texts;
}

/** The facts the control plane keeps: long notes, and contact pages waiting on review. */
function extrasOf(texts) {
  const extras = new Map();
  for (const [path, text] of Object.entries(texts)) {
    const props = propsOf(text);
    const lines = props?.lines ?? null;
    const review = hasReview(props?.properties?.review);
    if ((lines ?? 0) <= LONG_NOTE_LINES && !(path.startsWith(`${CONTACTS_FOLDER}/`) && review)) continue;
    extras.set(path, { lines, exempt: isExempt(path, props?.properties?.type, props?.properties?.generated), review });
  }
  return extras;
}

const near = (a, b) => Math.abs(a - b) < 1e-9;

test("the keys give the rubric's numbers, for both audiences", () => {
  const texts = workspace();
  const keys = Object.keys(texts).sort();
  const extras = extrasOf(texts);
  const folders = scoreKeys(keys, extras, notPrivate);
  const rows = keys.map((path) => ({ path, ...(extras.get(path) ?? {}) }));
  const totals = liveTotals(folders);
  assert.ok(near(totals.all, scoreTree(rows).score), `${totals.all}`);
  assert.ok(near(totals.team, scoreTree(rows.filter((row) => notPrivate(row.path))).score), `${totals.team}`);
  for (const team of [false, true]) {
    const summary = liveSummary(folders, extras, { team, present: new Set(keys), visible: team ? notPrivate : () => true });
    assert.ok(near(summary.score, team ? totals.team : totals.all));
  }
});

test("the team numbers count, and name, only what the team may open", () => {
  const texts = workspace();
  const keys = Object.keys(texts).sort();
  const extras = extrasOf(texts);
  const folders = scoreKeys(keys, extras, notPrivate);
  const team = liveSummary(folders, extras, { team: true, present: new Set(keys), visible: notPrivate, limit: 20 });
  assert.ok(team.folders.every((f) => !f.folder.startsWith("2-areas/private")));
  assert.ok(team.longNotes.every((n) => !n.path.startsWith("2-areas/private/")));
  assert.equal(folderNumbers(folders, "2-areas/private", true), null);
  assert.equal(folderNumbers(folders, "2-areas/private", false)?.items, 2);
  // A meeting and an archived note are never long notes.
  const all = liveSummary(folders, extras, { team: false, present: new Set(keys), visible: () => true });
  assert.deepEqual(all.longNotes.map((n) => n.path), ["2-areas/private/secret.md", "1-projects/big/novel.md"]);
});

test("a folder the tree draws at a new name is scored there, and a gone note is not named", () => {
  const texts = workspace();
  const keys = Object.keys(texts).sort();
  const extras = extrasOf(texts);
  const moved = keys.map((key) => key.replace(/^1-projects\/big\//, "2-areas/big/")).filter((key) => key !== "2-areas/private/secret.md");
  const shifted = new Map([...extras].map(([path, extra]) => [path.replace(/^1-projects\/big\//, "2-areas/big/"), extra]));
  const folders = scoreKeys(moved, shifted, notPrivate);
  assert.equal(folderNumbers(folders, "1-projects/big", false), null);
  assert.equal(folderNumbers(folders, "2-areas/big", false)?.items, 13);
  const summary = liveSummary(folders, shifted, { team: false, present: new Set(moved), visible: () => true });
  assert.deepEqual(summary.longNotes.map((n) => n.path), ["2-areas/big/novel.md"]);
});

test("meetings and generated notes are exempt from the long-note rule, and a review is any real question", () => {
  assert.equal(isExempt("1-projects/x/kickoff.md", "meeting", undefined), true);
  assert.equal(isExempt("0-inbox/meetings/2026-10-01-standup.md", undefined, undefined), true);
  for (const generated of [true, 1, "true"]) assert.equal(isExempt("1-projects/x/log.md", undefined, generated), true);
  assert.equal(isExempt("1-projects/x/essay.md", "note", false), false);
  for (const value of ["possible duplicate", ["a"], true, 1]) assert.equal(hasReview(value), true, JSON.stringify(value));
  for (const value of [null, undefined, false, 0, "", "  ", "[]"]) assert.equal(hasReview(value), false, JSON.stringify(value));
});
