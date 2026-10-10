/**
 * THE CHAOS SCORE IN THE TREE DATABASE, KEPT TRUE AS NOTES CHANGE.
 *
 * Real SQL (`node:sqlite`, the engine D1 runs). What is asked:
 *
 *  1. Does a full pass give the numbers the rubric gives over the same keys?
 *  2. After any sequence of creates, moves, folder moves and deletes, does
 *     rescoring only what each change touched land on exactly what a full
 *     pass would? (The property that makes "kept current, cheaply" true.)
 *  3. Does a change report the score before and after, and the folders?
 *  4. Is a note a tool wrote re-read for its length on the way?
 *  5. Do the team numbers leave out what the team cannot open, names included?
 *  6. Are meetings exempt from the long-note rule?
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { bucket, sqliteClient } from "./treeFixtures.mjs";
import { sweepTreePass } from "../src/tree/sweep.js";
import { touchTree } from "../src/tree/touch.js";
import { PROP_STATEMENTS, propWriteStatement } from "../src/tree/props.js";
import { scoreTree } from "../src/chaos/rubric.js";
import { chaosFullPass, chaosSummary, chaosTotals, rescoreChange } from "../src/chaos/table.js";

const everyone = () => true;
const notPrivate = (path) => !path.startsWith("2-areas/private/");

/** A bucket whose notes have text, so their lengths can be read. */
function textBucket(texts) {
  const store = bucket(Object.keys(texts));
  const body = new Map(Object.entries(texts));
  store.get = async (key) => (body.has(key) ? { text: async () => body.get(key), etag: store.objects.get(key)?.etag } : null);
  store.write = (key, text) => {
    body.set(key, text);
    store.put(key);
  };
  store.drop = (key) => {
    body.delete(key);
    store.remove(key);
  };
  store.body = body;
  return store;
}

async function filled(texts, visibleToTeam = everyone) {
  const store = textBucket(texts);
  const client = sqliteClient();
  await sweepTreePass(store, client, { now: () => 1 });
  await client.runAll(PROP_STATEMENTS.map((sql) => ({ sql, params: [] })));
  const statements = [];
  for (const [path, text] of store.body) statements.push(propWriteStatement(path, store.objects.get(path).etag, text));
  await client.runAll(statements);
  await chaosFullPass(client, { visibleToTeam, now: Date.UTC(2026, 9, 10) });
  return { store, client };
}

/** What a full recompute over the bucket says, for both audiences. */
function expected(store, visibleToTeam = everyone) {
  const rows = [...store.body.keys()].map((path) => ({ path, lines: store.body.get(path).split("\n").length }));
  return { all: scoreTree(rows).score, team: scoreTree(rows.filter((row) => visibleToTeam(row.path))).score };
}

const words = "plan budget people risks notes ideas launch review hiring roadmap legal design press travel".split(" ");
function workspace() {
  const texts = { "index.md": "# Home" };
  for (const word of words) texts[`1-projects/big/${word}.md`] = `# ${word}`;
  for (const word of words.slice(0, 4)) texts[`1-projects/small/${word}.md`] = `# ${word}`;
  texts["1-projects/only/about.md"] = "# Only an about note";
  texts["2-areas/private/secret-plan.md"] = "# secret";
  texts["2-areas/private/secret-budget.md"] = "# secret";
  texts["2-areas/health.md"] = "# health";
  texts["4-archive/old/a.md"] = "# old";
  return texts;
}

test("a full pass gives the rubric's numbers over the same notes", async () => {
  const { store, client } = await filled(workspace(), notPrivate);
  const totals = await chaosTotals(client);
  const want = expected(store, notPrivate);
  assert.ok(Math.abs(totals.all - want.all) < 1e-9, `${totals.all} vs ${want.all}`);
  assert.ok(Math.abs(totals.team - want.team) < 1e-9, `${totals.team} vs ${want.team}`);
  assert.ok(totals.all > 0);
});

test("rescoring only what each change touched always lands where a full pass would", async () => {
  const { store, client } = await filled(workspace(), notPrivate);
  let seed = 7;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const pick = (list) => list[Math.floor(random() * list.length)];
  const folders = ["1-projects/big", "1-projects/small", "1-projects/new", "2-areas", "2-areas/private", "0-inbox", "3-resources/deep/er"];
  for (let step = 0; step < 60; step += 1) {
    const kind = pick(["create", "create", "move", "delete", "moveFolder", "long"]);
    const notes = [...store.body.keys()].filter((path) => !path.startsWith("4-archive") && path !== "index.md");
    let change;
    if (kind === "create" || notes.length === 0) {
      const path = `${pick(folders)}/${pick(words)}-${step}.md`;
      store.write(path, "# new");
      change = { files: [path] };
    } else if (kind === "long") {
      const path = pick(notes);
      store.write(path, "line\n".repeat(1500));
      change = { files: [path] };
    } else if (kind === "delete") {
      const path = pick(notes);
      store.drop(path);
      change = { paths: [path] };
    } else if (kind === "move") {
      const from = pick(notes);
      const to = `${pick(folders)}/${from.split("/").pop()}`;
      if (to === from || store.body.has(to)) continue;
      store.write(to, store.body.get(from));
      store.drop(from);
      change = { paths: [from, to], moves: [[from, to]] };
    } else {
      const from = pick(["1-projects/small", "1-projects/new", "3-resources/deep", "2-areas/private"]);
      const to = `${pick(["1-projects", "3-resources", "2-areas"])}/moved-${step}`;
      const moving = [...store.body.keys()].filter((path) => path.startsWith(`${from}/`));
      if (moving.length === 0) continue;
      for (const path of moving) {
        store.write(`${to}/${path.slice(from.length + 1)}`, store.body.get(path));
        store.drop(path);
      }
      change = { paths: [from, to], moves: [[from, to]] };
    }
    await touchTree(store, client, { paths: change.paths ?? [], files: change.files ?? [] });
    const report = await rescoreChange(client, { ...change, visibleToTeam: notPrivate, store });
    assert.ok(report !== null, `step ${step}`);
    const totals = await chaosTotals(client);
    const want = expected(store, notPrivate);
    assert.ok(Math.abs(totals.all - want.all) < 1e-9, `step ${step} ${kind}: all ${totals.all} vs ${want.all}`);
    assert.ok(Math.abs(totals.team - want.team) < 1e-9, `step ${step} ${kind}: team ${totals.team} vs ${want.team}`);
  }
});

test("a change reports the score before and after, and the folders it touched", async () => {
  const { store, client } = await filled(workspace());
  store.write("1-projects/big/extra.md", "# one more");
  await touchTree(store, client, { files: ["1-projects/big/extra.md"] });
  const report = await rescoreChange(client, { files: ["1-projects/big/extra.md"], visibleToTeam: everyone, store });
  assert.ok(report.after.all > report.before.all, "a 15th note in a crowded folder makes things worse");
  const big = report.folders.find((entry) => entry.folder === "1-projects/big");
  assert.equal(big.before.items, 14);
  assert.equal(big.after.items, 15);
});

test("a note a tool wrote is re-read for its length before it is scored", async () => {
  const { store, client } = await filled(workspace());
  const before = await chaosTotals(client);
  store.write("1-projects/small/plan.md", "line\n".repeat(2500));
  await touchTree(store, client, { files: ["1-projects/small/plan.md"] });
  await rescoreChange(client, { files: ["1-projects/small/plan.md"], visibleToTeam: everyone, store });
  const after = await chaosTotals(client);
  assert.ok(after.all > before.all);
  const summary = await chaosSummary(client, { audience: "all" });
  assert.deepEqual(summary.longNotes.map((note) => note.path), ["1-projects/small/plan.md"]);
});

test("meetings are exempt from the long-note rule", async () => {
  const texts = workspace();
  texts["1-projects/small/kickoff.md"] = `---\ntype: meeting\n---\n${"said\n".repeat(3000)}`;
  const { client } = await filled(texts);
  const summary = await chaosSummary(client, { audience: "all" });
  assert.deepEqual(summary.longNotes, []);
});

test("the team numbers leave out what the team cannot open, names included", async () => {
  const { client } = await filled(workspace(), notPrivate);
  const team = await chaosSummary(client, { audience: "team", limit: 20 });
  assert.ok(team.folders.every((entry) => !entry.folder.startsWith("2-areas/private")));
  const all = await chaosSummary(client, { audience: "all", limit: 20 });
  assert.notEqual(team.score, all.score);
});

test("biggest wins come first, and an about-only folder is among them", async () => {
  const { client } = await filled(workspace());
  const summary = await chaosSummary(client, { audience: "all", limit: 3 });
  assert.equal(summary.folders[0].folder, "1-projects/big");
  assert.ok(summary.folders.some((entry) => entry.folder === "1-projects/only"));
});

test("archive changes never touch the score", async () => {
  const { store, client } = await filled(workspace());
  const before = await chaosTotals(client);
  store.write("4-archive/old/b.md", "# b");
  await touchTree(store, client, { files: ["4-archive/old/b.md"] });
  await rescoreChange(client, { files: ["4-archive/old/b.md"], visibleToTeam: everyone, store });
  assert.deepEqual(await chaosTotals(client), before);
});

test("before a full pass there is no score, rather than a wrong one", async () => {
  const store = textBucket({ "1-projects/a/x.md": "# x" });
  const client = sqliteClient();
  await sweepTreePass(store, client, { now: () => 1 });
  assert.equal(await rescoreChange(client, { files: ["1-projects/a/x.md"], visibleToTeam: everyone, store }), null);
  assert.equal(await chaosSummary(client, { audience: "all" }), null);
});
