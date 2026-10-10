/**
 * THE CHAOS RUBRIC: HOW ORGANIZED A FOLDER IS, AS ONE NUMBER.
 *
 * The owner's rules (project thread "chaos score", 2026-10-10), each pinned:
 *
 *  1. 4 or 5 items is calm, 10 is the average mark, past 10 it climbs, and
 *     35 or more is full chaos.
 *  2. Thin is chaos too: a folder holding only its about note is the worst,
 *     one item should move out, two should probably be combined, three is
 *     nearly fine.
 *  3. A run (Kings 1 to 30, notes named by date, chapters 01 to 10) counts
 *     as one item, but only up to 30: every further 30 is another item.
 *  4. A note past 1,000 lines adds chaos; meetings and generated notes are
 *     exempt.
 *  5. The workspace score weighs each folder by how much it holds: 20% of
 *     the notes in a calm folder and 80% in a chaotic one is 80% chaotic.
 *  6. Archive is never scored; the main folders are never thin.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  folderChaos,
  lengthChaos,
  countLines,
  countItems,
  scoreFolder,
  scoreTree,
  chaosWord,
} from "../src/chaos/rubric.js";

test("the curve: calm at 4-5, average at 10, chaos from 35", () => {
  assert.equal(folderChaos(4), 0);
  assert.equal(folderChaos(5), 0);
  assert.equal(folderChaos(6), 5);
  assert.equal(folderChaos(10), 25);
  assert.equal(folderChaos(11), 29);
  assert.equal(folderChaos(20), 65);
  assert.equal(folderChaos(35), 100);
  assert.equal(folderChaos(400), 100);
  for (let n = 5; n < 60; n += 1) assert.ok(folderChaos(n + 1) >= folderChaos(n), `rises at ${n}`);
});

test("thin folders cost more the thinner they are, unless thin is allowed", () => {
  assert.equal(folderChaos(0), 60);
  assert.equal(folderChaos(1), 40);
  assert.equal(folderChaos(2), 20);
  assert.equal(folderChaos(3), 5);
  assert.equal(folderChaos(0, { thinAllowed: true }), 0);
  assert.equal(folderChaos(2, { thinAllowed: true }), 0);
  // Thin never outweighs crowded past the average mark's double.
  assert.ok(folderChaos(0) < folderChaos(20));
});

test("long notes: nothing to 1,000 lines, then 10 per 100, full at 2,000", () => {
  assert.equal(lengthChaos(1000), 0);
  assert.equal(lengthChaos(1100), 10);
  assert.equal(lengthChaos(1500), 50);
  assert.equal(lengthChaos(2000), 100);
  assert.equal(lengthChaos(9000), 100);
  assert.equal(lengthChaos(null), 0);
});

test("a line longer than 120 characters counts as several, so long paragraphs can't dodge the rule", () => {
  assert.equal(countLines(""), 1);
  assert.equal(countLines("a\nb\nc"), 3);
  assert.equal(countLines("x".repeat(240)), 2);
  assert.equal(countLines("x".repeat(241) + "\nshort"), 4);
});

const notes = (...names) => names.map((name) => ({ name }));

test("front notes, attachments and dot files are not items", () => {
  const { items } = countItems(
    notes("about.md", "README.md", "overview.md", "index.md", "plan.md", "photo.png", ".keep", "todo.md"),
    [],
  );
  assert.equal(items, 2);
});

test("a run of 30 counts as one item, 31 to 60 as two, and so on", () => {
  const kings = Array.from({ length: 30 }, (_, i) => `kings-${i + 1}.md`);
  assert.equal(countItems(notes("kings.md", ...kings), []).items, 2);
  const days = Array.from({ length: 61 }, (_, i) => `2026-0${1 + Math.floor(i / 28)}-${String(1 + (i % 28)).padStart(2, "0")} standup.md`);
  assert.equal(countItems(notes(...days), []).items, 3);
});

test("chapters 01 to 10 are a run; a numbered list that reuses numbers is not", () => {
  const chapters = Array.from({ length: 10 }, (_, i) => `${String(i + 1).padStart(2, "0")}-chapter-${"abcdefghij"[i]}.md`);
  assert.equal(countItems(notes(...chapters), []).items, 1);
  const tasks = ["01-a.md", "02-b.md", "03-c.md", "03-d.md", "04-e.md"];
  assert.equal(countItems(notes(...tasks), []).items, 5);
});

test("two notes sharing a stem are not a run: a run needs three", () => {
  assert.equal(countItems(notes("draft-1.md", "draft-2.md"), []).items, 2);
  assert.equal(countItems(notes("draft-1.md", "draft-2.md", "draft-3.md"), []).items, 1);
});

test("subfolders are items", () => {
  assert.equal(countItems(notes("a.md"), ["x", "y"]).items, 3);
});

test("a folder's chaos weighs its notes; a long note in a calm folder still shows", () => {
  const calm = scoreFolder({ path: "p", notes: notes("a.md", "b.md", "c.md", "d.md"), folders: [] });
  assert.deepEqual([calm.items, calm.weight, calm.sum, calm.chaos], [4, 4, 0, 0]);
  const withLong = scoreFolder({
    path: "p",
    notes: [...notes("a.md", "b.md", "c.md"), { name: "spec.md", lines: 1500 }],
    folders: [],
  });
  assert.equal(withLong.sum, 50);
  assert.equal(withLong.chaos, 12.5);
});

test("meetings and generated notes may be long", () => {
  const folder = scoreFolder({
    path: "p",
    notes: [...notes("a.md", "b.md", "c.md"), { name: "call.md", lines: 5000, exempt: true }],
    folders: [],
  });
  assert.equal(folder.sum, 0);
});

test("a folder holding only its about note is the worst kind of thin", () => {
  const folder = scoreFolder({ path: "1-projects/x", notes: notes("about.md"), folders: [] });
  assert.deepEqual([folder.items, folder.weight, folder.chaos], [0, 1, 60]);
});

test("the main folders and the root are never thin", () => {
  assert.equal(scoreFolder({ path: "0-inbox", notes: [], folders: [] }).chaos, 0);
  assert.equal(scoreFolder({ path: "3-resources", notes: notes("one.md"), folders: [] }).chaos, 0);
  assert.equal(scoreFolder({ path: "", notes: notes("index.md"), folders: ["0-inbox", "1-projects"] }).chaos, 0);
});

test("the root's built-in folders are its frame, not its items", () => {
  const root = scoreFolder({
    path: "",
    notes: notes("index.md", "privacy.md", "activity.md", "todo.md"),
    folders: ["0-inbox", "1-projects", "2-areas", "3-resources", "4-archive", "4-clients", "website"],
  });
  assert.equal(root.items, 2); // todo.md and website
});

test("the workspace score weighs folders by what they hold (the owner's 20/80 example)", () => {
  const calm = ["plan", "budget", "people", "risks"].map((name) => `1-projects/calm/${name}.md`); // 4 notes, chaos 0
  const chaotic = Array.from({ length: 40 }, (_, i) => `1-projects/mess/topic-${String.fromCharCode(97 + (i % 26))}${i}.md`); // 40, chaos 100
  const tree = scoreTree([...calm, ...chaotic].map((path) => ({ path })));
  const byFolder = new Map(tree.folders.map((f) => [f.path, f]));
  assert.equal(byFolder.get("1-projects/calm").chaos, 0);
  assert.equal(byFolder.get("1-projects/mess").chaos, 100);
  // 1-projects itself holds two subfolders (thin is allowed for main folders) and weighs 2.
  assert.equal(Math.round(tree.score), Math.round((40 * 100) / (4 + 40 + 2)));
});

test("archive is never scored, at the root or under it", () => {
  const tree = scoreTree(
    [
      { path: "4-archive/old/a.md" },
      ...Array.from({ length: 50 }, (_, i) => ({ path: `9-archive/x${i}.md` })),
      { path: "1-projects/p/a.md" },
      { path: "1-projects/p/b.md" },
      { path: "1-projects/p/c.md" },
      { path: "1-projects/p/d.md" },
    ],
  );
  assert.ok(tree.folders.every((f) => !/archive/.test(f.path)));
  assert.equal(tree.score, 0);
});

test("an empty workspace, or one with only its frame, is calm", () => {
  assert.equal(scoreTree([]).score, 0);
  assert.equal(scoreTree([{ path: "index.md" }, { path: "privacy.md" }]).score, 0);
});

test("plumbing never counts", () => {
  const tree = scoreTree([{ path: ".context/x.json" }, { path: "1-projects/p/.keep" }, { path: "activity.md" }]);
  assert.equal(tree.score, 0);
});

test("words people read", () => {
  assert.equal(chaosWord(0), "calm");
  assert.equal(chaosWord(10), "calm");
  assert.equal(chaosWord(24), "fine");
  assert.equal(chaosWord(45), "crowded");
  assert.equal(chaosWord(80), "chaotic");
});
