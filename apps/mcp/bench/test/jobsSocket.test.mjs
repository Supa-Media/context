/**
 * THE JOBS AREA THROUGH THE MODEL SOCKET (2026-11-14). Every config change reaches every area's prompts now that what
 * Tex is told about itself is generated from the config, jobs' included, so an examiner session answers the jobs
 * area's Claude calls (the job's parts and the quality judge) like the others', and CI replays the run from them.
 *
 * Sabotage record (applied, run, observed failing, reverted, 2026-11-14): `jobTasks.mjs` dropping `assertAnswered`
 * -> "a jobs run with no examiner answers fails" fails (the job fell back and the run said ok).
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { FAKE_SETUP, jobTasksCommand } from "../jobTasks.mjs";
import { SOCKET_AREAS } from "../replayGate.mjs";

test("jobs is an area the examiner can answer", () => {
  assert.ok(SOCKET_AREAS.has("jobs"));
});

test("a jobs run with no examiner answers fails, and calls no real model", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jobs-socket-"));
  const answers = join(dir, "answers.json");
  await writeFile(answers, "{}");
  await mkdir(join(dir, "setups", "texting-assistant"), { recursive: true });
  await writeFile(join(dir, "setups", "texting-assistant", "production.md"), FAKE_SETUP.raw);
  const saved = { replay: process.env.BENCH_MODEL_REPLAY, token: process.env.AI_GATEWAY_TOKEN };
  process.env.BENCH_MODEL_REPLAY = answers;
  delete process.env.AI_GATEWAY_TOKEN;
  try {
    await assert.rejects(jobTasksCommand({ dir, only: "research-caterers-page", "max-parts": 1 }, { write: () => {} }), /no examiner answer/);
  } finally {
    if (saved.replay === undefined) delete process.env.BENCH_MODEL_REPLAY;
    else process.env.BENCH_MODEL_REPLAY = saved.replay;
    if (saved.token !== undefined) process.env.AI_GATEWAY_TOKEN = saved.token;
  }
});
