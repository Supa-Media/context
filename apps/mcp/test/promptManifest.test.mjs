/**
 * A model call keeps WHICH prompt it was sent, as module ids and fingerprints,
 * never the prompt (Dev2, 2026-11-14: "keep the ids of the prompt modules
 * loaded in, so they can be reconstructed along with the date and version
 * control"; "run the exact version from the day it ran").
 *
 * Sabotage checks: drop `prompt` from the model round in `turn.js`'s trace and
 * "every round's timing names its prompt" fails; build `system.context` from
 * anything but the named modules and "the modules are exactly the bytes sent"
 * fails.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fingerprint, manifestDiff, manifestOf } from "../src/agent/promptManifest.js";
import { turnPrompt } from "../src/agent/turnPrompt.js";
import { turnTiming } from "../src/agent/turnTiming.js";

const base = { texting: true, pictures: false, notes: null, models: null, tools: [], history: [], threadNote: "", turnNote: "Tagged by A.", webNames: new Set(), progress: null, aboutMe: null, identity: null, jobs: null, voice: null, calendar: null, observe: false, workspaces: [], localNow: { now: Date.UTC(2026, 10, 14, 15), timeZone: "America/New_York" }, plan: null, nudge: "" };

test("the modules are exactly the bytes sent, in order, and say nothing of the words", () => {
  const p = turnPrompt(null, "anthropic/claude-haiku-5-5", base);
  const ids = p.prompt.modules.map((m) => m.id);
  assert.equal(ids[0], "stable/texting");
  assert.ok(ids.includes("preamble/now") && ids.includes("preamble/turnNote"));
  const stable = p.prompt.modules[0];
  assert.deepEqual(stable, { id: "stable/texting", n: p.system.stable.length, h: fingerprint(p.system.stable) });
  const context = p.prompt.modules.filter((m) => m.id.startsWith("context/")).reduce((a, m) => a + m.n, 0);
  assert.equal(context, p.system.context.length);
  assert.ok(!JSON.stringify(p.prompt).includes("Tagged by A."));
  assert.deepEqual(p.prompt.inputs, { at: Date.UTC(2026, 10, 14, 15), timeZone: "America/New_York", model: "anthropic/claude-haiku-5-5", history: 0 });
});

test("a rebuild names the module that differs: here, the day", () => {
  const a = turnPrompt(null, null, base).prompt.modules;
  const b = turnPrompt(null, null, { ...base, localNow: { ...base.localNow, now: base.localNow.now + 86_400_000 } }).prompt.modules;
  assert.deepEqual(manifestDiff(a, b), ["preamble/now"]);
  assert.deepEqual(manifestDiff(a, a), []);
  assert.deepEqual(manifestOf([["x", ""], ["y", "hi"]]).map((m) => m.id), ["y"]);
});

test("every round's timing names its prompt, capped to ids and numbers", () => {
  const prompt = turnPrompt(null, "m", base).prompt;
  const timing = turnTiming({ steps: [{ name: "model", at: 100, ms: 900 }], trace: [{ kind: "model", model: "m", at: 0, ms: 900, prompt: { ...prompt, extra: "dropped" } }], replyMs: 1000 });
  assert.equal(timing.v, 2);
  assert.deepEqual(timing.rounds[0].prompt, { modules: prompt.modules, inputs: prompt.inputs });
});
