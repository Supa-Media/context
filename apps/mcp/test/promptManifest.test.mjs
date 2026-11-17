/**
 * A model call keeps WHICH prompt it was sent, as module ids and fingerprints,
 * never the prompt (Dev2, 2026-11-14: "keep the ids of the prompt modules
 * loaded in, so they can be reconstructed along with the date and version
 * control"; "run the exact version from the day it ran").
 *
 * Since 2026-11-17 (Dev2 chose keeping the words, after a group turn's false
 * "@shyoh tagged you" could not be read in Replay) the words of every module
 * but the stable rules are kept beside the manifest, once a turn.
 *
 * Sabotage checks: drop `prompt` from the model round in `turn.js`'s trace and
 * "every round's timing names its prompt" fails; build `system.context` from
 * anything but the named modules and "the modules are exactly the bytes sent"
 * fails; keep words without the `seen` check in `turnTiming.js` and "a module's
 * words are kept once a turn" fails; keep the stable rules' words and "the words
 * a rebuild can't make" fails.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MAX_KEPT_WORDS, fingerprint, keptWordsOf, manifestDiff, manifestOf } from "../src/agent/promptManifest.js";
import { turnPrompt } from "../src/agent/turnPrompt.js";
import { turnTiming } from "../src/agent/turnTiming.js";

const base = { texting: true, pictures: false, notes: null, models: null, tools: [], history: [], threadNote: "", turnNote: "Tagged by A.", webNames: new Set(), progress: null, aboutMe: null, identity: null, jobs: null, voice: null, calendar: null, observe: false, workspaces: [], localNow: { now: Date.UTC(2026, 10, 14, 15), timeZone: "America/New_York" }, plan: null, nudge: "" };

test("the modules are exactly the bytes sent, in order, and the manifest itself says nothing of the words", () => {
  const p = turnPrompt(null, "anthropic/claude-haiku-5-5", base);
  const ids = p.prompt.modules.map((m) => m.id);
  assert.equal(ids[0], "stable/texting");
  assert.ok(ids.includes("preamble/now") && ids.includes("preamble/turnNote"));
  const stable = p.prompt.modules[0];
  assert.deepEqual(stable, { id: "stable/texting", n: p.system.stable.length, h: fingerprint(p.system.stable) });
  const context = p.prompt.modules.filter((m) => m.id.startsWith("context/")).reduce((a, m) => a + m.n, 0);
  assert.equal(context, p.system.context.length);
  assert.ok(!JSON.stringify(p.prompt.modules).includes("Tagged by A."));
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
  assert.deepEqual(timing.rounds[0].prompt, { modules: prompt.modules, inputs: prompt.inputs, words: prompt.words });
});

test("the words a rebuild can't make are kept, each under its own fingerprint; the stable rules never", () => {
  const p = turnPrompt(null, "m", base).prompt;
  const note = p.modules.find((m) => m.id === "preamble/turnNote");
  assert.match(p.words[note.h], /Tagged by A\./);
  assert.equal(fingerprint(p.words[note.h]), note.h);
  const stable = p.modules.find((m) => m.id.startsWith("stable/"));
  assert.equal(p.words[stable.h], undefined);
  for (const [h, text] of Object.entries(p.words)) assert.equal(fingerprint(text), h);
  assert.deepEqual(keptWordsOf([["context/big", "x".repeat(MAX_KEPT_WORDS + 1)], ["context/small", "y"]]), { [fingerprint("y")]: "y" });
});

test("a module's words are kept once a turn, and never words the round's manifest doesn't name", () => {
  const prompt = turnPrompt(null, "m", base).prompt;
  const round = { kind: "model", model: "m", at: 0, ms: 10, prompt: { ...prompt, words: { ...prompt.words, deadbeef: "not sent" } } };
  const timing = turnTiming({ trace: [round, { ...round, at: 20 }], replyMs: 100 });
  assert.deepEqual(timing.rounds[0].prompt.words, prompt.words);
  assert.equal(timing.rounds[1].prompt.words, undefined, "the second round sent the same words");
});

test("a thread note in parts is sent as one block and named part by part, so a cache miss says which part changed", () => {
  const parts = [["learned", "\nYour own skills: a.\n"], ["background", "JOBS"], ["plan", ""], ["hub", "HUB"]];
  const whole = turnPrompt(null, null, { ...base, threadNote: parts.map(([, t]) => t).join("") });
  const split = turnPrompt(null, null, { ...base, threadNote: parts });
  assert.equal(split.system.context, whole.system.context, "the same bytes reach the model");
  const ids = split.prompt.modules.map((m) => m.id);
  assert.deepEqual(ids.filter((id) => id.startsWith("context/thread")), ["context/thread/learned", "context/thread/background", "context/thread/hub"]);
  const changed = turnPrompt(null, null, { ...base, threadNote: parts.map(([id, t]) => [id, id === "background" ? "JOBS 2" : t]) });
  assert.deepEqual(manifestDiff(split.prompt.modules, changed.prompt.modules), ["context/thread/background"]);
  assert.ok(whole.prompt.modules.some((m) => m.id === "context/thread"), "a plain note keeps its one id");
});

test("a turn never keeps the repo's fixed paragraphs, which the commit's catalogue already holds", async () => {
  const { turnPrompt } = await import("../src/agent/turnPrompt.js");
  const { TRANSCRIPTS_PROMPT } = await import("../src/agent/transcript.js");
  const o = { texting: true, pictures: false, notes: null, models: null, tools: [], history: [], threadNote: "", turnNote: "@ada asked at 3", webNames: new Set(), progress: null, aboutMe: null, identity: null, jobs: null, voice: null, calendar: null, observe: () => {}, workspaces: [], localNow: { now: Date.UTC(2026, 10, 17, 21), timeZone: "America/New_York" }, plan: null, nudge: "" };
  const { prompt } = turnPrompt(null, "anthropic/claude-haiku-5-5", o);
  const transcripts = prompt.modules.find((m) => m.id === "context/transcripts");
  assert.ok(transcripts, "a 1:1 is sent its record's paragraph");
  assert.equal(prompt.words[transcripts.h], undefined);
  assert.ok(Object.values(prompt.words).some((text) => text.includes("@ada asked at 3")), "the turn's own note is kept");
  assert.ok(!Object.values(prompt.words).includes(TRANSCRIPTS_PROMPT.trim()));
});
