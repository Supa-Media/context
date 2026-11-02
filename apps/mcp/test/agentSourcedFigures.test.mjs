/**
 * A FIGURE IS QUOTED ONLY FROM WHAT THE TURN READ (self-review, the Tex Devs
 * group, 2026-10-29 and 2026-10-30).
 *
 * Asked whether switching to OpenAI would be cheaper, Tex opened OpenAI's
 * pricing page and gave Claude Haiku and Sonnet prices beside OpenAI's; it
 * also said "Flovia publishes no prices" about a page offering free launch
 * access. The page text here is a fake stand-in with the same shape.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted (2026-10-30).
 *
 *  1. `unsourcedFigures` without the name check. → "Claude prices read off
 *     OpenAI's page are sent back, by name" fails.
 *  2. `unsourcedFigures` without the bare-figure check. → "a score nothing
 *     read holds is sent back" fails.
 *  3. `deniesWhatAPageSays` always false. → "'publishes no prices' about a
 *     page that offers free access is sent back" fails.
 *  4. `figureCheck.check` without `!usedWeb`. → "a turn that never used the
 *     web is not checked" fails.
 *  5. `claimCheck` never calling `figures.read` in `wrapWeb`. → "claimCheck
 *     sends an unsourced price back once, after a page was read" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { claimCheck } from "../src/agent/claimCheck.js";
import { SAYS_SOMETHING_NOTICE, deniesWhatAPageSays, figureCheck, unsourcedFigures } from "../src/agent/sourcedFigures.js";

const PRICING_PAGE =
  "API pricing. GPT-6 Luna: Input $0.10 / 1M tokens, Output $0.50 / 1M tokens. " +
  "GPT-6.1 Sol: Input $2.00 / 1M tokens, Output $10.00 / 1M tokens. The Batch API saves 50% on inputs and outputs.";
const LAUNCH_PAGE = "Flovia: one API for every model. Access is free for an initial period after launch. After that, pricing below standard API rates.";

const CLAUDE_OFF_OPENAI =
  "Not free, but the price is about the same. Claude Haiku 5.5 and GPT-6 Luna both cost $0.10 in and $0.50 out per million tokens, and Sonnet 5.5 matches GPT-6.1 Sol at $2 and $10.\n\n" +
  "Batch is half price on both, so switching wouldn't save anything. https://pricing.example/api?x=1%2F";

const page = (text) => ({ content: [{ type: "text", text }] });

test("Claude prices read off OpenAI's page are sent back, by name", () => {
  const missing = unsourcedFigures(CLAUDE_OFF_OPENAI, [PRICING_PAGE]);
  assert.deepEqual(missing.map((item) => item.name).sort(), ["Haiku", "Sonnet"]);
});

test("OpenAI's own prices, quoted from its page, go as they are", () => {
  const answer = "OpenAI's page matches what I quoted: GPT-6 Luna is $0.10 in and $0.50 out per million tokens, and GPT-6.1 Sol is $2 and $10. Batch saves 50%.";
  assert.deepEqual(unsourcedFigures(answer, [PRICING_PAGE]), []);
});

test("a score nothing read holds is sent back", () => {
  const answer = "On the composite index, Opus scored 39 and Sonnet scored 30.";
  assert.deepEqual(
    unsourcedFigures(answer, ["Composite index results are updated weekly."]).map((item) => item.figure),
    ["scored 39", "scored 30"],
  );
});

test("a figure from their own words or an earlier text stands, and a worked-out total stands on it", () => {
  assert.deepEqual(unsourcedFigures("Thirty people at $10 each comes to $300.", ["dinner for 30 at $10 a head"]), []);
  assert.deepEqual(unsourcedFigures("Claude stays about $5 a month at the cap.", ["Earlier: Claude is about $5 a month at the cap."]), []);
});

test("a common word opening a sentence is not taken for a name", () => {
  assert.deepEqual(unsourcedFigures("Switching would cost $4 a month.", ["Plans from $4 a month."]), []);
});

test("'publishes no prices' about a page that offers free access is sent back", () => {
  assert.equal(deniesWhatAPageSays("Flovia publishes no prices, so I can't put a number on it.", [LAUNCH_PAGE]), true);
  assert.equal(deniesWhatAPageSays("They don't list pricing anywhere.", [LAUNCH_PAGE]), true);
  // A page that really says nothing of price leaves the line alone.
  assert.equal(deniesWhatAPageSays("Flovia publishes no prices.", ["Flovia: one API for every model. Join the waitlist."]), false);
});

test("a turn that never used the web is not checked, and a checked turn is noticed once", () => {
  const offline = figureCheck({ question: "is it cheaper?" });
  offline.read(page("notes say nothing of price"));
  assert.equal(offline.check(CLAUDE_OFF_OPENAI), null);

  const online = figureCheck({ question: "is it cheaper?" });
  online.read(page(PRICING_PAGE), { web: true });
  const notice = online.check(CLAUDE_OFF_OPENAI);
  assert.match(notice, /Haiku/);
  assert.match(notice, /one-line answer/);
  assert.equal(online.check(CLAUDE_OFF_OPENAI), null);
});

test("pictures they sent are read by the model, so a turn carrying them is not checked", () => {
  const check = figureCheck({ pictures: true });
  check.read(page(PRICING_PAGE), { web: true });
  assert.equal(check.check(CLAUDE_OFF_OPENAI), null);
});

test("a failed read backs nothing", () => {
  const check = figureCheck();
  check.read({ isError: true, content: [{ type: "text", text: "Opus scored 39" }] }, { web: true });
  assert.match(check.check("Opus scored 39 on the index."), /scored 39/);
});

test("claimCheck sends an unsourced price back once, after a page was read", async () => {
  const claims = claimCheck({ question: "if we switched to openai would it be free?" });
  const web = claims.wrapWeb({ tools: [], call: async () => page(PRICING_PAGE) });
  await web.call("open_page", { url: "https://pricing.example/api" });
  const notice = await claims.check(CLAUDE_OFF_OPENAI);
  assert.match(notice, /Haiku \(/);
  assert.notEqual(await claims.check(CLAUDE_OFF_OPENAI), notice);
});

test("claimCheck sends 'publishes no prices' back when the opened page speaks of price", async () => {
  const claims = claimCheck({ question: "how much cheaper would flovia be?" });
  const web = claims.wrapWeb({ tools: [], call: async () => page(LAUNCH_PAGE) });
  await web.call("open_page", { url: "https://launch.example/" });
  assert.equal(await claims.check("Flovia publishes no prices, so I can't put a number on it."), SAYS_SOMETHING_NOTICE);
});
