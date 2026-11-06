/**
 * A computer job's model, its wait after the answer and the runner's prompt come from
 * `@context-lc` `ai/production/computer-jobs.md`, so they change without a runner release (the owner, 2026-11-05:
 * "i'd like to be able to change those properties on the fly without a new update").
 *
 * Sabotage: send `settings` to every runner in `serveMachines.js` and "an older runner is never sent them" fails
 * (an older runner refuses a field it does not know, so every job on it would fail).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { computerJobSettingsOf } from "../src/agent/production.js";
import { FACTS, machineWorld } from "./machineWorld.mjs";

const NOTE = `---
claude_model: claude-opus-5-5
codex_model: gpt-5.5-codex
after_answer_seconds: 20
---

You are a Tex job on {machine}, job {job}, part {part}.
`;

test("the note's front matter and body are the run's settings", () => {
  assert.deepEqual(computerJobSettingsOf(NOTE), {
    claudeModel: "claude-opus-5-5",
    codexModel: "gpt-5.5-codex",
    afterAnswerMs: 20_000,
    systemPrompt: "You are a Tex job on {machine}, job {job}, part {part}.",
  });
});

test("a value that is not valid is left out, and the runner keeps its own", () => {
  assert.deepEqual(computerJobSettingsOf("---\nclaude_model: rm -rf /\nafter_answer_seconds: 9000\n---\n"), {});
  assert.deepEqual(computerJobSettingsOf("---\nafter_answer_seconds: ten\n---\n"), {});
  assert.deepEqual(computerJobSettingsOf(null), {});
  assert.equal(computerJobSettingsOf(`---\n---\n${"x".repeat(8001)}`).systemPrompt, undefined);
});

async function runner(facts) {
  const w = machineWorld();
  const machine = await w.add("mch_1");
  const server = await w.connect(machine, { hello: { facts } });
  return { w, server };
}

const SETTINGS = { claudeModel: "claude-opus-5-5", afterAnswerMs: 20_000, systemPrompt: "Job {job}." };

test("a runner that takes settings is sent them with its part", async () => {
  const { w, server } = await runner({ ...FACTS, runSettings: true });
  const answer = await w.call("ws.machine.assign", w.assignment("mch_1", { settings: SETTINGS }));
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.deepEqual(server.last().settings, SETTINGS);
});

test("an older runner is never sent them, and its part still runs", async () => {
  const { w, server } = await runner(FACTS);
  const answer = await w.call("ws.machine.assign", w.assignment("mch_1", { settings: SETTINGS }));
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.equal(server.last().type, "assign");
  assert.equal("settings" in server.last(), false);
});

test("no settings, no field", async () => {
  const { w, server } = await runner({ ...FACTS, runSettings: true });
  await w.call("ws.machine.assign", w.assignment("mch_1", { settings: {} }));
  assert.equal("settings" in server.last(), false);
});
