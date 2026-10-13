/**
 * THE CHAOS SCORE COUNTED FROM THE CONVEX TREE'S KEYS SAYS WHAT THE TABLE SAYS.
 *
 * `chaos/live.js` scores the keys the tree hands a reader, with only long
 * notes, meetings and contact reviews taken from the database. Over the same
 * notes it must give the table's numbers for both audiences, never name a
 * folder or a long note the team cannot open, and follow a folder that moved.
 *
 * Sabotage-checked: scoring the team numbers over every key fails "the team
 * numbers"; dropping `present` names a long note that has gone; dropping the
 * team-exists check names a private folder to the team.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { bucket, sqliteClient } from "./treeFixtures.mjs";
import { sweepTreePass } from "../src/tree/sweep.js";
import { PROP_STATEMENTS, propWriteStatement } from "../src/tree/props.js";
import { chaosFullPass, chaosSummary } from "../src/chaos/table.js";
import { chaosExtras, folderNumbers, liveSummary, scoreKeys } from "../src/chaos/live.js";
import { liveSection } from "../src/chaos/orient.js";
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

async function filled(texts) {
  const store = bucket(Object.keys(texts));
  const client = sqliteClient();
  await sweepTreePass(store, client, { now: () => 1 });
  await client.runAll(PROP_STATEMENTS.map((sql) => ({ sql, params: [] })));
  await client.runAll(Object.entries(texts).map(([path, text]) => propWriteStatement(path, store.objects.get(path).etag, text)));
  await chaosFullPass(client, { visibleToTeam: notPrivate, now: Date.UTC(2026, 9, 10) });
  return { keys: Object.keys(texts).sort(), client };
}

const near = (a, b) => Math.abs(a - b) < 1e-9;

test("the keys give the table's numbers, folders and long notes, for both audiences", async () => {
  const { keys, client } = await filled(workspace());
  const extras = await chaosExtras(client);
  const folders = scoreKeys(keys, extras, notPrivate);
  for (const audience of ["all", "team"]) {
    const visible = audience === "all" ? () => true : notPrivate;
    const table = await chaosSummary(client, { audience, visible });
    const live = liveSummary(folders, extras, { team: audience === "team", present: new Set(keys), visible });
    assert.ok(near(live.score, table.score), `${audience}: ${live.score} vs ${table.score}`);
    assert.deepEqual(live.folders.map((f) => f.folder), table.folders.map((f) => f.folder));
    for (const [index, folder] of live.folders.entries()) {
      assert.equal(folder.items, table.folders[index].items);
      assert.ok(near(folder.chaos, table.folders[index].chaos));
    }
    assert.deepEqual(live.longNotes, table.longNotes);
  }
});

test("the team numbers count, and name, only what the team may open", async () => {
  const { keys, client } = await filled(workspace());
  const extras = await chaosExtras(client);
  const folders = scoreKeys(keys, extras, notPrivate);
  const team = liveSummary(folders, extras, { team: true, present: new Set(keys), visible: notPrivate });
  assert.ok(team.folders.every((f) => !f.folder.startsWith("2-areas/private")));
  assert.ok(team.longNotes.every((n) => !n.path.startsWith("2-areas/private/")));
  assert.equal(folderNumbers(folders, "2-areas/private", true), null);
  assert.equal(folderNumbers(folders, "2-areas/private", false)?.items, 2);
  // A meeting and an archived note are never long notes.
  const all = liveSummary(folders, extras, { team: false, present: new Set(keys), visible: () => true });
  assert.deepEqual(all.longNotes.map((n) => n.path), ["2-areas/private/secret.md", "1-projects/big/novel.md"]);
});

test("a folder the tree draws at a new name is scored there, and a gone note is not named", async () => {
  const { keys, client } = await filled(workspace());
  const extras = await chaosExtras(client);
  const moved = keys.map((key) => key.replace(/^1-projects\/big\//, "2-areas/big/")).filter((key) => key !== "2-areas/private/secret.md");
  const shifted = new Map([...extras].map(([path, extra]) => [path.replace(/^1-projects\/big\//, "2-areas/big/"), extra]));
  const folders = scoreKeys(moved, shifted, notPrivate);
  assert.equal(folderNumbers(folders, "1-projects/big", false), null);
  assert.equal(folderNumbers(folders, "2-areas/big", false)?.items, 13);
  const summary = liveSummary(folders, shifted, { team: false, present: new Set(moved), visible: () => true });
  assert.deepEqual(summary.longNotes.map((n) => n.path), ["2-areas/big/novel.md"]);
});

test("orient counts from the keys where the call is served, and only then", async () => {
  const { keys, client } = await filled(workspace());
  const rules = [];
  const overrides = new Map();
  assert.equal(await liveSection({}, client, "all", () => true, rules, overrides), null);
  assert.equal(await liveSection({ treeKeys: async () => null }, client, "all", () => true, rules, overrides), null);
  const served = await liveSection({ treeKeys: async () => keys }, client, "all", () => true, rules, overrides);
  const table = await chaosSummary(client, { audience: "all", limit: 4 });
  assert.ok(near(served.score, table.score));
  assert.equal(served.folders.length, Math.min(4, table.folders.length));
});

test("orient names a moving folder's long notes at its new name, as the app does", async () => {
  // The table files notes at bucket keys; the served keys are drawn through
  // the pending move. Sabotage: drop `extrasAtTreeNames` in `liveSection`
  // and the long note is not named at all.
  const { keys, client } = await filled(workspace());
  const moves = [{ from: "1-projects/big", to: "3-resources/big" }];
  const drawn = keys.map((key) => key.replace(/^1-projects\/big\//, "3-resources/big/"));
  const store = { treeKeys: async () => drawn };
  Object.defineProperty(store, "pendingMoves", { value: moves, enumerable: false });
  const served = await liveSection(store, client, "all", () => true, [], new Map());
  assert.match(served.longNotes.map((n) => n.path).join(","), /3-resources\/big\/novel\.md/);
  assert.doesNotMatch(served.longNotes.map((n) => n.path).join(","), /1-projects\/big\//);
});
