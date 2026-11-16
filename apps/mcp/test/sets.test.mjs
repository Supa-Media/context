/**
 * Tex's test conversations on disk (`apps/mcp/bench/sets.mjs`; contract `packages/shared/src/texSets.cjs`).
 *
 * Sabotage record (temporary local edit, reverted, 2026-11-15): problemsOf() drops its "set test" rule
 *   -> "a conversation in set test is reported, never loaded into a set" fails.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SETS_DIR, conversationFile, loadSets, loadContract, problemsOf, ratioCheck } from "../bench/sets.mjs";
import { readFileSync } from "node:fs";

const { config, why } = loadContract();
const SETS = ["training", "dev", "test"];

/** A conversation with `stars` unit tests (one starred label per message). */
const conv = (id, set, stars = 1, over = {}) => ({
  id, set, title: id, kind: "one", members: ["Ana"],
  msgs: Array.from({ length: stars }, (_, i) => ({
    id: `m${i + 1}`, who: "Ana", text: "are we still on for Saturday?",
    labels: { fd: { must: ["say Saturday"], star: true } },
  })),
  ...over,
});

test("loadSets reads the repo's training and dev folders, sorted by set then id", async () => {
  const convs = await loadSets();
  const onDisk = [];
  for (const folder of ["training", "dev"]) {
    for (const f of await readdir(join(SETS_DIR, folder))) if (f.endsWith(".json")) onDisk.push(`${folder}/${f}`);
  }
  assert.equal(convs.length, onDisk.length);
  assert.ok(convs.length > 0);
  const rank = (s) => SETS.indexOf(s);
  for (let i = 1; i < convs.length; i++) {
    const a = convs[i - 1], b = convs[i];
    assert.ok(rank(a.set) <= rank(b.set), "sets are in order");
    if (a.set === b.set) assert.ok(a.id < b.id, "ids are in order within a set");
  }
  assert.ok(convs.every((c) => c.set === "training" || c.set === "dev"));
});

test("loadSets reads a stray test/ folder so it is reported, not skipped", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tex-sets-"));
  try {
    await mkdir(join(dir, "training"));
    await mkdir(join(dir, "test"));
    await writeFile(join(dir, "training", "ferry.json"), JSON.stringify(conv("ferry", "training")));
    await writeFile(join(dir, "test", "held.json"), JSON.stringify(conv("held", "test")));
    const convs = await loadSets(dir);
    assert.deepEqual(convs.map((c) => c.id), ["ferry", "held"]);
    const problems = problemsOf(convs, { config, why });
    assert.ok(problems.some((p) => p.startsWith("test/held.json: test/ folder")), problems.join("\n"));
    assert.ok(problems.some((p) => p.startsWith("test/held.json: set test")), problems.join("\n"));
    assert.equal(problems.some((p) => p.startsWith("training/ferry.json")), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("problemsOf passes the repo as it is", async () => {
  assert.deepEqual(problemsOf(await loadSets(), { config, why }), []);
});

test("problemsOf flags a conversation filed in the wrong folder", () => {
  const c = conv("ferry", "training");
  const problems = problemsOf([c], { config, why, folderOf: () => "dev" });
  assert.deepEqual(problems, ["dev/ferry.json: folder dev must match set training"]);
});

test("problemsOf flags a duplicate id across the folders", () => {
  const problems = problemsOf([conv("ferry", "training"), conv("ferry", "dev")], { config, why });
  assert.ok(problems.some((p) => p.includes("id ferry is used by another conversation")), problems.join("\n"));
});

test("problemsOf flags a file name that is not <id>.json", () => {
  const problems = problemsOf([conv("ferry", "training")], { config, why, fileOf: () => "ferry-trip.json" });
  assert.deepEqual(problems, ["training/ferry-trip.json: file name must be ferry.json"]);
});

test("problemsOf flags a conversation in set test", () => {
  const problems = problemsOf([conv("held", "test")], { config, why, folderOf: () => "training" });
  assert.ok(problems.includes("training/held.json: set test: Test conversations never live in the repo"), problems.join("\n"));
});

test("ratioCheck holds for 6 training and 2 dev stars, and fails for 2 and 6", () => {
  const holds = ratioCheck([conv("a", "training", 6), conv("b", "dev", 2)]);
  assert.equal(holds.holds, true);
  assert.match(holds.line, /\(75\/25, holds 3:1\)/);
  assert.match(holds.line, /Test counted by the eval service/);
  assert.equal(ratioCheck([conv("a", "training", 2), conv("b", "dev", 6)]).holds, false);
});

test("ratioCheck with a Test count uses all three sets", () => {
  const convs = [conv("a", "training", 6), conv("b", "dev", 2)];
  const holds = ratioCheck(convs, 2);
  assert.equal(holds.holds, true);
  assert.match(holds.line, /60\/20\/20, holds 60\/20\/20/);
  const fails = ratioCheck(convs, 0);
  assert.equal(fails.holds, false);
  assert.match(fails.line, /does not hold/);
});

test("a conversation file is one line per field and per message, and every repo file is written that way", async () => {
  const c = { id: "x", title: "X", set: "dev", kind: "one", members: ["Jo"], msgs: [{ id: "m1", who: "Jo", text: `hi ${String.fromCharCode(0x2068)}there${String.fromCharCode(0x2069)}` }, { id: "m2", who: "Tex", tex: true, text: "hey" }] };
  const text = conversationFile(c);
  assert.deepEqual(JSON.parse(text), c);
  assert.equal(text.split("\n").length, 1 + 5 + 1 + 2 + 2 + 1, "the brace, five fields, the msgs bracket, one line per message, the two closes, the final newline");
  assert.doesNotMatch(text, /[\u2066-\u2069]/, "invisible characters are escapes");
  for (const conv of await loadSets()) {
    const file = readFileSync(join(SETS_DIR, conv.set, `${conv.id}.json`), "utf8");
    assert.equal(file, conversationFile(JSON.parse(file)), `${conv.id} is written as conversationFile writes it`);
  }
});
