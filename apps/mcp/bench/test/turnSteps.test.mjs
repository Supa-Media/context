/**
 * A Front door row's steps summary (`bench/turnSteps.mjs`): what the turn did, from its trace, in tool names and verdict
 * codes only, at most 400 characters, with the outcome always kept. Sabotage record: dropping the `answer check` segment
 * → the first test fails; trimming from the end instead of the tool list → the cap test's `outcome:` check fails.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { STEPS_CHARS, turnSteps } from "../turnSteps.mjs";

test("a quiet turn reads its tools, the reviewer's sent-back verdict and its round, and the say_nothing outcome", () => {
  const trace = [
    { kind: "model", ok: true, model: "claude-haiku-5-5" },
    { kind: "tool", tool: "search_mail", ok: true },
    { kind: "tool", tool: "read_mail", ok: true },
    { kind: "tool", tool: "tex_instructions_set", ok: false },
    { kind: "judge", verdict: "hands_back", acted: true, confidence: 0.9 },
    { kind: "model", ok: true, model: "claude-haiku-5-5" },
    { kind: "tool", tool: "send", action: "say_nothing", ok: true },
    { kind: "model", ok: true, model: "claude-haiku-5-5" },
  ];
  assert.equal(turnSteps(trace, { answer: "" }), "tools search_mail ok, read_mail ok, tex_instructions_set failed, send say_nothing ok | answer check: sent back (hands_back), went on round 2 | outcome: quiet (send say_nothing)");
});

test("a replied turn with no tools says so, and a held call and a let-go check are plain", () => {
  assert.equal(turnSteps([{ kind: "model", ok: true }], { answer: "hi" }), "tools none | outcome: replied");
  const held = [{ kind: "tool", tool: "send", held: true, ok: true }, { kind: "judge", verdict: "only_acknowledged", acted: false }, { kind: "model", ok: true }];
  assert.equal(turnSteps(held, { answer: "On it." }), "tools send held | answer check: let go (only_acknowledged) | outcome: replied");
});

test("only codes and names reach the summary: a verdict that is words, or a tool name that is not a name, is not kept", () => {
  const trace = [{ kind: "tool", tool: "Bearer abc123 secret", ok: true }, { kind: "judge", verdict: "Your mum's address is 1 High St", acted: false }];
  const text = turnSteps(trace, { answer: "" });
  assert.equal(text, "tools tool ok | answer check: let go (not a code) | outcome: quiet");
  assert.doesNotMatch(text, /Bearer|secret|High St/);
});

test("a judge with no verdict and no action is left out, and a cancelled turn says so", () => {
  assert.equal(turnSteps([{ kind: "judge", by: "code" }], { answer: "", cancelled: true }), "tools none | outcome: cancelled");
});

test("a long turn is cut to the cap with its outcome kept and the rest counted", () => {
  const trace = Array.from({ length: 60 }, (_, i) => ({ kind: "tool", tool: `read_note_${i}`, ok: true }));
  const text = turnSteps(trace, { answer: "" });
  assert.ok(text.length <= STEPS_CHARS, `${text.length} characters`);
  assert.match(text, /\| outcome: quiet$/);
  assert.match(text, /, \+\d+ more \|/);
});
