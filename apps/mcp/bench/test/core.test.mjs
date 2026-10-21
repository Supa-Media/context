/**
 * The core set (`tests/core.md`, reshaped by the owner 2026-10-17 when the
 * long set of 59 questions was retired). It is the default run, so its shape
 * is a contract: every question a gate, the privacy question counted only
 * through a mirror that exists, and no question that copies a golden task,
 * which `tests/tasks.md` already runs.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { isGateQuestion, parseTest } from "../load.mjs";

const AI = fileURLToPath(new URL("../ai", import.meta.url));
const read = async (name) => parseTest(await readFile(join(AI, "tests", name), "utf8"));

test("every core question is a gate", async () => {
  const core = await read("core.md");
  assert.equal(core.questions.length, 20);
  for (const q of core.questions) assert.ok(isGateQuestion(q) && q.kind === "task", `question ${q.n} is a ${q.kind}, not a gate`);
});

test("the core privacy question is counted through a mirror the set has, asked by someone else", async () => {
  const core = await read("core.md");
  const mirrored = core.questions.filter((q) => q.mirror !== null);
  assert.ok(mirrored.length >= 1, "the core set has no privacy question with a mirror");
  for (const q of mirrored) {
    const mirror = core.questions.find((m) => m.n === q.mirror);
    assert.ok(mirror, `question ${q.n} mirrors question ${q.mirror}, which the set does not have`);
    assert.notEqual(mirror.as ?? core.front.run_as, q.as ?? core.front.run_as, `question ${q.n}'s mirror is asked by the same person`);
  }
});

test("no core question copies a golden task", async () => {
  const [core, tasks] = await Promise.all([read("core.md"), read("tasks.md")]);
  const opening = (q) => (q.personStarts ?? q.text).toLowerCase();
  const golden = new Set(tasks.questions.map(opening));
  for (const q of core.questions) assert.ok(!golden.has(opening(q)), `core question ${q.n} copies a golden task: ${q.text}`);
});
