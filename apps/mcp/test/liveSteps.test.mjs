/**
 * The live run card's steps (`packages/tex/gateway/agent/liveSteps.js`): what a thinking or tool event shows, how the
 * card keeps its last steps, and that the observer never throws into a turn.
 *
 * Sabotage record (temporary local edits, reverted):
 *   keepLive without the `slice` cap                 "keeps the last 40 steps" fails
 *   keepLive appending every thinking step           "a thinking step that extends the last one replaces it" fails
 *   liveObserver without try/catch                   "a write that throws is swallowed" fails
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { keepLive, liveObserver, liveStepOf, MAX_LIVE_STEPS, withLive } from "../../../packages/tex/gateway/agent/liveSteps.js";
import { streamTurn } from "../../../packages/tex/gateway/agent/progress.js";

test("a thinking event shows its text, whitespace collapsed, cut at 280 with an ellipsis", () => {
  const step = liveStepOf({ kind: "thinking", text: "  first\n\nsecond   third  " }, 5);
  assert.deepEqual(step, { k: "think", at: 5, text: "first second third" });

  const long = "word ".repeat(100).trim();
  const cutStep = liveStepOf({ kind: "thinking", text: long }, 0);
  assert.equal(cutStep.text.endsWith("…"), true);
  assert.ok(cutStep.text.length <= 280, `length ${cutStep.text.length}`);
  // The last space inside the first 279 characters is at 274, so the cut lands on the word boundary before it.
  assert.equal(cutStep.text, `${long.slice(0, 274)}…`);

  // A single word longer than the cut is cut hard, still with the ellipsis.
  const hard = liveStepOf({ kind: "thinking", text: "x".repeat(400) }, 0);
  assert.equal(hard.text, `${"x".repeat(279)}…`);
  assert.equal(hard.text.length, 280);
});

test("an empty thinking text shows nothing", () => {
  assert.equal(liveStepOf({ kind: "thinking", text: "   " }, 0), null);
  assert.equal(liveStepOf({ kind: "thinking" }, 0), null);
});

test("a tool event shows its name, its main argument, ok, ms and the first result line", () => {
  const step = liveStepOf(
    { kind: "tool", name: "search", args: { query: "  hotel\nin Lisbon " }, ok: true, ms: 41.6, result: "etag: abc\npath: notes/a.md\n\nFound two notes" },
    1200,
  );
  assert.deepEqual(step, { k: "tool", at: 1200, name: "search", what: "hotel in Lisbon", ok: true, ms: 42, res: "Found two notes" });
});

test("a tool call the model wrote as one of the six shows the model's name and arguments", () => {
  const step = liveStepOf(
    { kind: "tool", name: "sixTool", as: { name: "read_note", args: { path: "projects/plan.md" } }, args: { action: "x" }, ok: true },
    0,
  );
  assert.equal(step.name, "read_note");
  assert.equal(step.what, "projects/plan.md");
});

test("the main argument takes the first key in priority order that holds a string", () => {
  const what = (args) => liveStepOf({ kind: "tool", name: "t", args }, 0).what;
  assert.equal(what({ title: "T", text: "X", path: "p" }), "p");
  assert.equal(what({ subject: "S", to: "a@example.com" }), "a@example.com");
  assert.equal(what({ id: "1", query: "q" }), "q");
  assert.equal(what({ q: 5, prefix: "pre" }), "pre");
  assert.equal(what({ url: "https://example.com", title: "T" }), "https://example.com");
  assert.equal(what({ count: 3 }), undefined);
  assert.equal("what" in liveStepOf({ kind: "tool", name: "t", args: { count: 3 } }, 0), false);
  assert.equal(what({ query: "x".repeat(200) }).length, 120);
});

test("metadata lines are skipped in the result, and a result with only metadata shows none", () => {
  const res = (result) => liveStepOf({ kind: "tool", name: "write", result, ok: true }, 0).res;
  assert.equal(res("etag: 9f\npath: a.md\nlink: https://x\nvisibility: private\ndocument_id: 1\nSaved the note"), "Saved the note");
  assert.equal(res("etag: 9f\n  path: a.md\nthe real line"), "the real line");
  assert.equal(res("etag: only"), undefined);
  assert.equal(res(""), undefined);
  assert.equal(res("x".repeat(300)).length, 140);
});

test("a failed tool shows its reason in place of its result", () => {
  const step = liveStepOf({ kind: "tool", name: "fetch", ok: false, ms: 3, reason: "no such action", result: "some error text" }, 0);
  assert.equal(step.ok, false);
  assert.equal(step.res, "no such action");
});

test("a held tool is marked held, and an ok tool is not", () => {
  assert.equal(liveStepOf({ kind: "tool", name: "send", held: true, ok: true }, 0).held, true);
  assert.equal("held" in liveStepOf({ kind: "tool", name: "send", held: false }, 0), false);
});

test("ms is omitted unless it is a finite number above zero", () => {
  assert.equal("ms" in liveStepOf({ kind: "tool", name: "t", ms: 0 }, 0), false);
  assert.equal("ms" in liveStepOf({ kind: "tool", name: "t", ms: Number.NaN }, 0), false);
  assert.equal("ms" in liveStepOf({ kind: "tool", name: "t" }, 0), false);
});

test("a tool name is cut to 40 characters", () => {
  assert.equal(liveStepOf({ kind: "tool", name: "n".repeat(60) }, 0).name.length, 40);
});

test("an unknown kind, or a bad event, returns null, and a bad time reads as zero", () => {
  assert.equal(liveStepOf({ kind: "model", model: "x" }, 0), null);
  assert.equal(liveStepOf({ kind: "judge" }, 0), null);
  assert.equal(liveStepOf(null, 0), null);
  assert.equal(liveStepOf({ kind: "tool" }, 0), null);
  assert.equal(liveStepOf({ kind: "thinking", text: "hi" }, Number.NaN).at, 0);
  assert.equal(liveStepOf({ kind: "thinking", text: "hi" }).at, 0);
});

test("keepLive keeps the last MAX_LIVE_STEPS steps", () => {
  assert.equal(MAX_LIVE_STEPS, 40);
  let steps = [];
  for (let i = 0; i < 45; i += 1) steps = keepLive(steps, { k: "tool", at: i, name: `t${i}`, ok: true });
  assert.equal(steps.length, 40);
  assert.equal(steps[0].name, "t5");
  assert.equal(steps.at(-1).name, "t44");
});

test("keepLive returns the same list for a null step and a new list otherwise", () => {
  const steps = [{ k: "tool", at: 0, name: "a", ok: true }];
  assert.equal(keepLive(steps, null), steps);
  const next = keepLive(steps, { k: "tool", at: 1, name: "b", ok: true });
  assert.notEqual(next, steps);
  assert.equal(steps.length, 1);
  assert.equal(next.length, 2);
});

test("a thinking step that extends the last thinking step replaces it, and one that does not is appended", () => {
  let steps = keepLive([], { k: "think", at: 0, text: "I should check" });
  steps = keepLive(steps, { k: "think", at: 1, text: "I should check the calendar first" });
  assert.equal(steps.length, 1);
  assert.equal(steps[0].text, "I should check the calendar first");

  steps = keepLive(steps, { k: "think", at: 2, text: "A different thought" });
  assert.equal(steps.length, 2);
});

test("a cut thinking step still merges with the longer text that extends it", () => {
  const first = liveStepOf({ kind: "thinking", text: "alpha ".repeat(80) }, 0);
  const longer = liveStepOf({ kind: "thinking", text: `${"alpha ".repeat(80)}and more` }, 1);
  assert.equal(first.text.endsWith("…"), true);
  const steps = keepLive(keepLive([], first), longer);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].text, longer.text);
});

test("a thinking step after a tool step is appended, not merged", () => {
  let steps = keepLive([], { k: "tool", at: 0, name: "a", ok: true });
  steps = keepLive(steps, { k: "think", at: 1, text: "next" });
  assert.equal(steps.length, 2);
});

test("liveObserver writes each shaped step with the time since it was made, and skips the rest", () => {
  let clock = 1000;
  const written = [];
  const observe = liveObserver((step) => written.push(step), () => clock);
  clock = 1250;
  observe({ kind: "thinking", text: "planning" });
  observe({ kind: "model", model: "x" });
  clock = 1900;
  observe({ kind: "tool", name: "search", args: { query: "q" }, ok: true });
  assert.deepEqual(written, [
    { k: "think", at: 250, text: "planning" },
    { k: "tool", at: 900, name: "search", what: "q", ok: true },
  ]);
});

test("liveObserver swallows a throwing write and keeps observing", () => {
  let calls = 0;
  const observe = liveObserver(() => {
    calls += 1;
    if (calls === 1) throw new Error("the card is gone");
  }, () => 0);
  assert.doesNotThrow(() => observe({ kind: "thinking", text: "one" }));
  assert.doesNotThrow(() => observe({ kind: "thinking", text: "two" }));
  assert.equal(calls, 2);
});

test("liveObserver never throws when the clock or the event is broken", () => {
  const observe = liveObserver(() => {}, () => {
    throw new Error("no clock");
  });
  assert.doesNotThrow(() => observe({ kind: "thinking", text: "one" }));
  assert.doesNotThrow(() => observe(undefined));
});

test("withLive shows the card only for an ask that asked, beside the turn's own observer, and never adds one", () => {
  const own = [];
  const card = [];
  const observe = (event) => own.push(event.kind);
  assert.equal(withLive((step) => card.push(step), false, observe), observe, "not asked: the turn's observer as it was");
  assert.equal(withLive(null, true, observe), observe, "nothing to write to");
  assert.equal(withLive((step) => card.push(step), true, null), null, "no observer is never given one: the prompt would change");
  const both = withLive((step) => card.push(step), true, observe);
  both({ kind: "tool", name: "read_note", args: { path: "areas/notes.md" }, ok: true, result: "first line" });
  assert.deepEqual(own, ["tool"]);
  assert.equal(card[0].name, "read_note");
});

test("streamTurn writes a live line for each step it is handed", async () => {
  const response = streamTurn(async (_progress, _step, _answered, live) => {
    await live({ k: "think", at: 5, text: "looking" });
    return Response.json({ answer: "ok" });
  });
  const lines = (await response.text()).trim().split("\n").map((line) => JSON.parse(line)).filter((line) => !("tick" in line));
  assert.deepEqual(lines, [{ live: { k: "think", at: 5, text: "looking" } }, { status: 200, body: { answer: "ok" } }]);
});
