/**
 * A TEST CONVERSATION RUNS IN ITS OWN WORLD (`bench/setsWorld.mjs`), AND MAY BE HELD OUT OF ITS OWN EXAMPLES.
 * Sabotage: drop the `seedWorld` call in `setsFd.mjs` runConvo, or the `HOLD_OUT_ENV` line in `runFd`, and these fail.
 */
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { parsePeople, readBenchFolder } from "../bench/load.mjs";
import { loadSets } from "../bench/sets.mjs";
import { castOf, runFd } from "../bench/setsFd.mjs";
import { holdOutOn } from "../bench/setsRun.mjs";
import { readWorld, seedWorld, withRows, worldDirOf, worldProblems } from "../bench/setsWorld.mjs";

const require = createRequire(import.meta.url);
const { HOLD_OUT_ENV, heldOutOf, trainingText } = require("../../../packages/tex/src/texTraining.cjs");
const GENERATED = require("../../../packages/tex/src/texTraining.generated.json");

const TREE = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const BENCH = join(TREE, "apps/mcp/bench/ai");
const convs = await loadSets();
const byId = (id) => convs.find((c) => c.id === id);

async function copyOfBench() {
  const scratch = await mkdtemp(join(tmpdir(), "tex-world-test-"));
  await cp(BENCH, join(scratch, "ai"), { recursive: true });
  return { scratch, dir: join(scratch, "ai") };
}

test("a group conversation's world makes the shared workspace it runs in, with its own people, and the bench folder still loads", async () => {
  const { scratch, dir } = await copyOfBench();
  try {
    const c = byId("build-crew");
    const world = await seedWorld(dir, worldDirOf(TREE, c.id), c, castOf(c));
    assert.deepEqual(world, { group: "driftline", sites: ["showpivots.example"], laid: true, starts: null });
    const people = parsePeople(await readFile(join(dir, "workspaces/people.md"), "utf8"));
    assert.deepEqual(people.filter((row) => row.workspace === "driftline").map((row) => [row.person, row.role]), [["John", "owner"], ["Maya", "editor"], ["Priya", "editor"]]);
    const bench = await readBenchFolder(dir);
    assert.match(bench.workspaces.driftline.files["resources/gear.md"], /Q2U/);
    assert.ok(bench.workspaces["fashion-brand"], "the bench's own workspaces are untouched");
    assert.equal((await readBenchFolder(BENCH)).workspaces.driftline, undefined, "nothing of a world is in the bench folder itself");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("a one-to-one conversation's world is laid over its person's own: they keep their notes and gain its records, mail and sites", async () => {
  const { scratch, dir } = await copyOfBench();
  try {
    const shop = byId("running-the-shop");
    assert.deepEqual(await seedWorld(dir, worldDirOf(TREE, shop.id), shop, castOf(shop)), { group: null, sites: ["rovertown.example"], laid: true, starts: null });
    const bench = await readBenchFolder(dir);
    assert.ok(bench.workspaces.john.files["people/mateo.md"], "John's own notes stay");
    assert.equal(bench.workspaces.john.files["inbox/meetings/2026-10-02-john-mateo.md"], undefined, "another conversation's world is not here");
    // The same person's other conversation, in a folder of its own.
    const other = await copyOfBench();
    try {
      const hire = byId("trial-hire");
      await seedWorld(other.dir, worldDirOf(TREE, hire.id), hire, castOf(hire));
      const theirs = await readBenchFolder(other.dir);
      assert.match(theirs.workspaces.john.files["inbox/meetings/2026-10-02-john-mateo.md"], /hold off/);
      assert.ok(theirs.workspaces.john.mail.some((email) => /Bram Visser/.test(email.from)), "the world's email is in his Gmail, never a note");
    } finally {
      await rm(other.scratch, { recursive: true, force: true });
    }
    assert.match(bench.workspaces.lantern.files["projects/private-beta.md"], /forum/i);
    assert.ok(bench.sites.some((site) => site.host === "rovertown.example"));
    assert.deepEqual(parsePeople(await readFile(join(dir, "workspaces/people.md"), "utf8")).filter((row) => row.workspace === "lantern").map((row) => [row.person, row.role]), [["John", "owner"]]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("a conversation with no world changes nothing, and a world may not write into anybody else's workspace", async () => {
  const { scratch, dir } = await copyOfBench();
  try {
    const before = await readFile(join(dir, "workspaces/people.md"), "utf8");
    assert.deepEqual(await seedWorld(dir, join(scratch, "no-such-world"), byId("side-talk"), ["Maya", "Priya", "John"]), { group: null, sites: [], laid: false, starts: null });
    assert.equal(await readFile(join(dir, "workspaces/people.md"), "utf8"), before);
    const people = parsePeople(before);
    const one = { id: "x", kind: "one", members: ["Maya"] };
    assert.deepEqual(worldProblems(one, ["Maya"], { workspaces: ["maya", "fernway"] }, people), []);
    assert.match(worldProblems(one, ["Maya"], { workspaces: ["john"] }, people)[0], /not one of x's people's own/);
    assert.match(worldProblems(one, ["Maya"], { workspaces: ["woodshop"] }, people)[0], /the bench already has/);
    assert.match(worldProblems({ id: "g", kind: "group", members: ["Maya", "John"] }, ["Maya", "John"], { workspaces: ["a", "b"] }, people)[0], /a group chat runs in one/);
    assert.equal(withRows("| A | b | owner |\n\ntext\n", ["| C | d | editor |"]), "| A | b | owner |\n| C | d | editor |\n\ntext\n");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("every world in the repo belongs to a conversation, loads, and can be laid in", async () => {
  const { readdir } = await import("node:fs/promises");
  const names = (await readdir(join(TREE, "apps/mcp/bench/sets/worlds"), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  assert.ok(names.length >= 5);
  const people = parsePeople(await readFile(join(BENCH, "workspaces/people.md"), "utf8"));
  for (const name of names) {
    const c = byId(name);
    assert.ok(c, `worlds/${name} names a Training or Dev conversation`);
    assert.deepEqual(worldProblems(c, castOf(c), await readWorld(worldDirOf(TREE, name)), people), [], name);
  }
});

const unit = (c, at) => ({ convo: c, at, label: c.msgs[at].labels.fd, row: { chat: c.id, msg: c.msgs[at].id, at, node: "fd" } });
const firstStarred = (c) => c.msgs.findIndex((m) => m.labels?.fd?.star && !m.via);

test("each conversation's tests run in its own folder with its world, on its own weekday, and only the hold-out switch sets the variable", async () => {
  const crew = byId("build-crew");
  const shop = byId("running-the-shop");
  const seen = [];
  const runTests = async (_tree, tests, { dir, env }) => {
    const people = await readFile(join(dir, "workspaces/people.md"), "utf8");
    const raw = await readFile(join(dir, "tests", `${tests[0]}.md`), "utf8");
    seen.push({ dir, heldOut: env[HOLD_OUT_ENV] ?? null, driftline: /\| driftline \|/.test(people), lantern: /\| lantern \|/.test(people), raw });
    return { rows: tests.map((t) => ({ id: `${t}/q1`, right: true })), usd: 0, bars: {}, missing: [] };
  };
  const units = [unit(crew, firstStarred(crew)), unit(shop, firstStarred(shop))];
  await runFd(units, { tree: TREE, runTests, env: {} });
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0].dir, seen[1].dir, "a folder each");
  const ofCrew = seen.find((s) => s.driftline);
  const ofShop = seen.find((s) => s.lantern);
  assert.ok(ofCrew && ofShop && !ofCrew.lantern && !ofShop.driftline, "neither sees the other's world");
  assert.match(ofCrew.raw, /^group: driftline$/m);
  assert.match(ofCrew.raw, /^today: 2026-10-12$/m, "its Monday, never the bench's Thursday");
  assert.match(ofShop.raw, /^world_sites: rovertown\.example$/m);
  assert.match(ofShop.raw, /^mail_until: 2026-11-02$/m);
  assert.deepEqual(seen.map((s) => s.heldOut), [null, null], "in context unless the switch is on");
  // A chat that names no date starts on the day its world says: loose-ends' Thursday is October 29, so its mail has arrived.
  const ends = byId("loose-ends");
  seen.length = 0;
  await runFd([unit(ends, 0)], { tree: TREE, runTests, env: {} });
  assert.match(seen[0].raw, /^today: 2026-10-29$/m);
  seen.length = 0;
  await runFd(units, { tree: TREE, runTests, env: {}, holdOut: true });
  assert.deepEqual(seen.map((s) => s.heldOut).sort(), ["build-crew", "running-the-shop"]);
  seen.length = 0;
  await runFd([unit({ ...crew, set: "dev" }, firstStarred(crew))], { tree: TREE, runTests, env: {}, holdOut: true });
  assert.deepEqual(seen.map((s) => s.heldOut), [null], "a Dev conversation is never an example, so nothing is held out");
});

test("a held-out conversation is gone from every step's examples, and nothing else is", () => {
  assert.equal(heldOutOf(GENERATED, {}), GENERATED, "production sets no such variable");
  assert.equal(heldOutOf(GENERATED, { [HOLD_OUT_ENV]: " " }), GENERATED);
  const held = heldOutOf(GENERATED, { [HOLD_OUT_ENV]: "redo-the-draft" });
  const chatsIn = (g) => [...new Set([...Object.values(g.nodes ?? {}), ...Object.values(g.chats ?? {})].flat().map((item) => item.chat))].sort();
  assert.ok(chatsIn(GENERATED).includes("redo-the-draft"));
  assert.deepEqual(chatsIn(held), chatsIn(GENERATED).filter((chat) => chat !== "redo-the-draft"));
  const all = trainingText({ ctx: ["train:fd:all:60000"] }, GENERATED);
  const less = trainingText({ ctx: ["train:fd:all:60000"] }, held);
  assert.match(all, /Spokeline/);
  assert.doesNotMatch(less, /Spokeline/, "its words are in no example the Front door reads");
  assert.deepEqual([holdOutOn("on"), holdOutOn("ON"), holdOutOn(""), holdOutOn(undefined), holdOutOn("off")], [true, true, false, false, false]);
});
