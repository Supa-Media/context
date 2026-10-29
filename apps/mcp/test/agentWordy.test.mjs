/**
 * A TEXTED ANSWER IS A TEXT, NOT AN ESSAY (Dev2, 2026-10-29; `wordy.js`).
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *   The "result" check dropped from `replyChecks` → "words that describe the
 *     page beside it are sent back for one line" fails.
 *   The "wordy" check dropped from `replyChecks` → "an essay with no page is
 *     sent back to be cut" fails.
 *   `claimCheck` not passing `detailed` to `replyChecks` → "length set to
 *     detailed lets the long form go" fails.
 *   `BRIEF_LINE` dropped from `systemPrompt` → "every texted turn is told to
 *     keep it short…" fails.
 *   `claimCheck` not marking a .page.md write as a page → "a page written
 *     with no cover drawn still counts as the result" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { jobPrompt } from "../src/agent/background.js";
import { BRIEF_LINE } from "../src/agent/chatVoice.js";
import { claimCheck } from "../src/agent/claimCheck.js";
import { systemPrompt } from "../src/agent/prompt.js";
import { replyChecks } from "../src/agent/replyChecks.js";
import { RESULT_NOTICE, WORDY_NOTICE, proseWords, restatesTheResult, tooWordy } from "../src/agent/wordy.js";

// The shape of the reply that started this: the page described, then a take with its reasons.
const DESCRIBES_THE_PAGE =
  "Done, the page is up. It has an architecture diagram for each of the four (ours, the Agents SDK, Mastra and the fourth one), a diagram of each " +
  "agent loop, and a side-by-side on how each one fits Context.\n\n" +
  "My take: keep our loop and borrow parts of the Agents SDK. It's built the same way as ours, one Durable Object per agent, and notes stay the " +
  "memory. Mastra only partly fits, and the fourth is out because it needs another host.\n\n" +
  "https://context.lc/n/abc123\n[picture 1]";
const ONE_LINE = "I think you keep what you've got and borrow some of the SDK's stuff, here are my notes.\nhttps://context.lc/n/abc123\n[picture 1]";
const DREW = [{ name: "draw_visual", ok: true }];

test("words that describe the page beside it are sent back for one line", () => {
  const check = replyChecks({ question: "put this research into a page with diagrams and your take" });
  assert.equal(check(DESCRIBES_THE_PAGE, DREW), RESULT_NOTICE);
  assert.equal(check(DESCRIBES_THE_PAGE, DREW), null, "once a turn");
  assert.equal(restatesTheResult(ONE_LINE, { steps: DREW }), false, "the one line goes");
  assert.equal(restatesTheResult(DESCRIBES_THE_PAGE, { steps: [{ name: "draw_visual", ok: false }] }), false, "nothing was drawn");
});

test("an essay with no page is sent back to be cut", () => {
  const essay = Array.from({ length: 6 }, () => "This is a long sentence that keeps going on about a thing they did not ask about at all.").join(" ");
  const check = replyChecks({ question: "should I keep the gym membership" });
  assert.equal(check(essay, []), WORDY_NOTICE);
  assert.equal(tooWordy("Keep it, you went nine times last month.", { question: "should I keep it" }), false);
});

test("list lines and links are not counted, sentences are", () => {
  const list = Array.from({ length: 30 }, (_, n) => `Pack box ${n}`).join("\n");
  assert.equal(proseWords(list), 0);
  assert.equal(proseWords("https://example.com/a/very/long/link\n[picture 2]"), 0);
  assert.equal(proseWords("Done."), 1, "a short sentence still counts");
  assert.equal(tooWordy(list, { question: "what's left before the move" }), false);
});

test("the long form goes when they asked for it", () => {
  const essay = Array.from({ length: 8 }, () => "Here is one more sentence with enough words in it to count as prose.").join(" ");
  assert.equal(tooWordy(essay, { question: "explain how the router works in detail" }), false);
  assert.equal(tooWordy(essay, { question: "draft a reply to Sam" }), false);
  assert.equal(tooWordy(`Subject: Friday\n\n${essay}`, { question: "what should I tell him" }), false, "words to copy");
  assert.equal(restatesTheResult(DESCRIBES_THE_PAGE, { question: "walk me through it", steps: DREW }), false);
});

test("length set to detailed lets the long form go", () => {
  const essay = Array.from({ length: 8 }, () => "Here is one more sentence with enough words in it to count as prose.").join(" ");
  assert.equal(claimCheck({ question: "how's the launch", detailed: true }).check(essay), null);
  assert.equal(claimCheck({ question: "how's the launch" }).check(essay), WORDY_NOTICE);
});

test("a page written with no cover drawn still counts as the result", async () => {
  const watch = claimCheck({ question: "research the four frameworks" });
  const call = watch.wrap(async () => ({ content: [{ type: "text", text: "saved" }] }));
  await call("write_note", { path: "projects/frameworks.page.md", content: "# Frameworks" });
  assert.equal(watch.check(DESCRIBES_THE_PAGE.replace("\n[picture 1]", "")), RESULT_NOTICE);
});

test("a background job ends with one line and the link, never the page retold", () => {
  const prompt = jobPrompt({ title: "Frameworks", brief: "compare four", doneWhen: "", attempt: 1, followUps: [], draft: "", unfinished: false });
  assert.match(prompt, /End with ONE casual line/);
  assert.match(prompt, /Never describe what's on the page/);
  assert.doesNotMatch(prompt, /in a few lines/);
});

test("every texted turn is told to keep it short, a production setup's words included", () => {
  assert.ok(systemPrompt(null, { texting: true }).includes(BRIEF_LINE));
  assert.ok(systemPrompt(null, { texting: true, notes: { prompt: "You are Tex." } }).includes(BRIEF_LINE));
});
