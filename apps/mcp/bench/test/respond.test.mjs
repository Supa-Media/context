/**
 * THE ONE JUDGE'S HELD-OUT CASES AND THEIR SCORING (`bench/respond.mjs`; Dev2, 2026-11-11: one Clef judge, taught by
 * examples, and "@Tex" must still work).
 *
 * Sabotage record (2026-11-11), each applied, suite run, named test failing, reverted:
 *  1. `passes` ignoring the @Tex set → "a missed @Tex case fails the bench, whatever the rates" fails.
 *  2. a case's text copied into the judge's examples → "the cases are held out" fails.
 *  3. `caseBody` showing the judge an older line as the newest → "a case reaches the judge as the Worker sends a moment" fails.
 *  4. a case reworded from an example by one word (2026-11-12) → "the cases are not near-copies of an example" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { decideRequest, JUDGE_EXAMPLES, readDecideBody } from "../../../../packages/shared/src/textDecide.cjs";
import { caseBody, hushed, loadCases, MAX_DROPPED, MIN_HUSHED, passes, rates, respondCommand } from "../respond.mjs";

test("the cases have unique ids, both labels in both kinds of chat, and lines and words on each", async () => {
  const cases = await loadCases();
  const ids = new Set(cases.map((item) => item.id));
  assert.equal(ids.size, cases.length);
  for (const chat of ["group", "one"]) for (const want of ["hush", "reply"]) assert.ok(cases.filter((item) => item.chat === chat && item.want === want).length >= 5, `${chat} ${want}`);
  for (const item of cases) assert.ok(Array.isArray(item.lines) && typeof item.text === "string");
});

test("the @Tex set covers every way Tex is called on, and each must be answered", async () => {
  const must = (await loadCases()).filter((item) => item.must === true);
  for (const item of must) assert.equal(item.want, "reply", item.id);
  const has = (pattern) => must.some((item) => pattern.test(item.text));
  assert.ok(has(/: .+@Tex/), "an @Tex mid-message");
  assert.ok(has(/: @Tex/), "an @Tex opening it");
  assert.ok(has(/@\u2068Tex\u2069/), "an iMessage mention wrapped in bidi marks");
  assert.ok(has(/: Tex [a-z]/), "a native mention, the bare name");
  assert.ok(has(/: Tex,/), "Tex, then the ask");
  assert.ok(has(/ tex\??$/i), "Tex's name closing it");
  assert.ok(has(/\(replying to You\)/), "a reply under one of Tex's texts");
  assert.ok(has(/: approve$/), "an approve to Tex's question");
  assert.ok(has(/👍 \(yes\) on Tex's message/), "a thumbs-up on Tex's question");
  assert.ok(must.some((item) => item.setting === "quiet"), "a tag in a quiet group");
  assert.ok(must.length >= 20);
});

test("the cases are held out: no case's text is one of the judge's examples", async () => {
  const shown = new Set(JUDGE_EXAMPLES.map((item) => item.text));
  for (const item of await loadCases()) assert.ok(!shown.has(item.text), item.id);
});

test("the cases are not near-copies of an example: no case shares more than half its words with one", async () => {
  const words = (text) => new Set(text.toLowerCase().replace(/^[^:]*:\s*/, "").match(/[a-z0-9']+/g) ?? []);
  const shown = JUDGE_EXAMPLES.map((item) => words(item.text));
  for (const item of await loadCases()) {
    const mine = words(item.text);
    if (mine.size < 4) continue;
    for (const theirs of shown) {
      const both = [...mine].filter((word) => theirs.has(word)).length;
      assert.ok(both / new Set([...mine, ...theirs]).size <= 0.5, item.id);
    }
  }
});

test("a case reaches the judge as the Worker sends a moment: a body the boundary takes, its text the newest line", async () => {
  for (const item of await loadCases()) {
    const body = caseBody(item);
    assert.ok(readDecideBody(body), item.id);
    const { state } = decideRequest(body);
    assert.ok(state.endsWith(`<${body.newest}> ${item.text}\n</chat>`), item.id);
  }
});

test("a dropped ask is the tight bar", () => {
  const row = (hushedRate, droppedRate, mustDropped = 0) => ({ hushedRate, droppedRate, mustDropped });
  assert.equal(passes(row(MIN_HUSHED, MAX_DROPPED)), true);
  assert.equal(passes(row(1, MAX_DROPPED + 0.01)), false);
  assert.equal(passes(row(MIN_HUSHED - 0.01, 0)), false);
  assert.deepEqual(rates([{ want: "hush", hushed: true }, { want: "reply", hushed: true }]).dropped, 1);
});

test("a missed @Tex case fails the bench, whatever the rates", () => {
  const scored = [...Array.from({ length: 40 }, () => ({ want: "reply", hushed: false, verdict: { ok: true } })), { want: "reply", must: true, hushed: true, verdict: { ok: true } }];
  assert.ok(rates(scored).droppedRate <= MAX_DROPPED);
  assert.equal(passes({ ...rates(scored), hushedRate: 1 }), false);
  // No verdict at all is a miss too: the judge down drops the tag.
  assert.equal(rates([{ want: "reply", must: true, hushed: false, verdict: null }]).mustDropped, 1);
});

test("quiet and a tapback are hushes; an answer, a wait or no verdict is not", () => {
  assert.equal(hushed({ ok: true, act: "silent" }), true);
  assert.equal(hushed({ ok: true, act: "react" }), true);
  assert.equal(hushed({ ok: true, act: "answer" }), false);
  assert.equal(hushed({ ok: true, act: "wait" }), false);
  assert.equal(hushed(null), false);
});

test("the fake run passes and writes its report", async () => {
  const written = [];
  const all = await respondCommand({ fake: true }, { write: (text) => written.push(text) });
  assert.ok(passes(all));
  assert.equal(all.mustDropped, 0);
  assert.match(written.join(""), /the one judge ✅ passes/);
});
