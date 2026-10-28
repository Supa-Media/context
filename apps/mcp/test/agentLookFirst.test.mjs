/**
 * Look before asking, and "fix yourself" means look at what just failed
 * (`src/agent/lookFirst.js`; self-review themes asks-for-findable-info and
 * self-repair-on-request, 2026-10-28).
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted (2026-10-28).
 *
 *  1. `claimCheck` never calling `selfRepairNotice`. → "'Tell me what's
 *     broken' after 'fix yourself' goes back once" fails.
 *  2. `LOOK_FIRST_LINE` dropped from the ground rules. → "every texted turn,
 *     production setup or not, is told to look first" fails.
 *  3. The judge's H9 losing the chat and logs. → "the judge counts the chat's
 *     own turns and logs as places Tex can look" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { claimCheck } from "../src/agent/claimCheck.js";
import { judgeAsks, WHAT_TEX_CAN_DO } from "../src/agent/handbackJudge.js";
import { LOOK_FIRST_LINE, SELF_REPAIR_NOTICE, asksToFixItself, asksWhatsWrong, selfRepairNotice } from "../src/agent/lookFirst.js";
import { systemPrompt } from "../src/agent/prompt.js";

const ok = async () => ({ content: [{ type: "text", text: "ok" }] });

test("the chats' words ask Tex to fix itself; other fixes don't", () => {
  assert.ok(asksToFixItself("Tex please fix yourself"));
  assert.ok(asksToFixItself("Tex fix yourself"));
  assert.ok(asksToFixItself("can you fix urself"));
  assert.ok(asksToFixItself("repair your self pls"));
  assert.ok(asksToFixItself("Tex fix yourself’s page saves"));
  assert.ok(!asksToFixItself("fix the leaky sink"));
  assert.ok(!asksToFixItself("fix you a plate"));
  assert.ok(!asksToFixItself("make yourself at home"));
  assert.ok(!asksToFixItself(undefined));
});

test("an answer that asks them what failed", () => {
  assert.ok(asksWhatsWrong("Tell me what's broken, and I'll fix it."));
  assert.ok(asksWhatsWrong("What went wrong?"));
  assert.ok(asksWhatsWrong("Which part isn’t working for you?"));
  assert.ok(asksWhatsWrong("What's the issue?"));
  assert.ok(!asksWhatsWrong("The page saves failed because the note was too big. I split it and saved it, and filed a bug."));
});

test("'Tell me what's broken' after 'fix yourself' goes back once", () => {
  const claims = claimCheck({ question: "Tex please fix yourself" });
  assert.equal(claims.check("Tell me what's broken, and I'll fix it."), SELF_REPAIR_NOTICE);
  assert.notEqual(claims.check("Tell me what's broken, and I'll fix it."), SELF_REPAIR_NOTICE, "once a turn");
});

test("'fix yourself' answered with nothing tried goes back; a retry that names the failure doesn't", async () => {
  assert.equal(selfRepairNotice("fix yourself", "On it!", []), SELF_REPAIR_NOTICE);
  assert.equal(selfRepairNotice("fix yourself", "The page save failed twice. I tried it again and it saved.", [{ name: "write_note", ok: true }]), null);

  const claims = claimCheck({ question: "fix yourself" });
  await claims.wrap(ok)("write_note", { path: "plan.page.md", content: "# Plan" });
  assert.notEqual(claims.check("The page save failed on a picture that was too big. I saved it again without it and it went through."), SELF_REPAIR_NOTICE);
});

test("a turn that didn't ask Tex to fix itself is never sent back for it", () => {
  assert.equal(selfRepairNotice("what's on Friday?", "What's the issue?", []), null);
  const claims = claimCheck({ question: "what's on Friday?" });
  assert.notEqual(claims.check("Nothing on Friday."), SELF_REPAIR_NOTICE);
});

test("every texted turn, production setup or not, is told to look first", () => {
  for (const notes of [null, { prompt: "You are Tex." }]) {
    const prompt = systemPrompt(null, { texting: true, notes });
    assert.ok(prompt.includes(LOOK_FIRST_LINE));
  }
  assert.ok(systemPrompt(null, {}).includes(LOOK_FIRST_LINE));
  assert.match(LOOK_FIRST_LINE, /chat's earlier texts/);
  assert.match(LOOK_FIRST_LINE, /routine's log/);
  assert.match(LOOK_FIRST_LINE, /where you found it/);
  assert.match(LOOK_FIRST_LINE, /report_problem/);
});

test("the judge counts the chat's own turns and logs as places Tex can look", async () => {
  assert.match(WHAT_TEX_CAN_DO, /chat's earlier texts/);
  const asked = [];
  await judgeAsks({ question: "Tex please fix yourself", answer: "Tell me what's broken.", config: {}, request: async (body) => (asked.push(body), { text: '{"asks": []}' }) });
  assert.match(asked[0].system, /H9 asks for something findable in[^;]*this chat's earlier texts or its own logs/);
  assert.match(asked[0].system, /what's broken\?/);
});
