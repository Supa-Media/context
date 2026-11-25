/**
 * A HAIKU CALL STAYS UNDER 100,000 TOKENS (`packages/tex/gateway/agent/promptBudget.js`).
 *
 * The history caps do not cover a stretch's tool results. These checks show a
 * result larger than the cliff is stubbed, older history text goes before a
 * tool result in the newest message, and a body that already fits is not rewritten.
 *
 * And the cut holds while a chat grows: a body fitted, then given one more text
 * or tool round, is fitted again with the earlier fitted body as its exact
 * prefix, so the prompt cache reads it, until the body has grown by a step.
 *
 * Sabotage record (applied, run, observed failing, reverted, 2026-11-24):
 *  - `fitHaikuBody` cutting the whole body to the budget every round (the rule
 *    before 2026-11-24: `cut(next, HAIKU_INPUT_BUDGET)`, no frame, no step) fails
 *    "a growing chat keeps its fitted prefix…" ("the cut moved inside a step" on the
 *    first growth) and "the tool result of this round is kept…";
 *  - the frame's last message cut as older history whatever follows it
 *    (`hasNewest` passed to the first cut) fails "a growing chat keeps its fitted
 *    prefix…" at the first tool round that crossed into a step.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { EARLIER, estimateBodyTokens, fitHaikuBody, HAIKU_INPUT_BUDGET, LEFT_OUT, TRIM_STEP } from "../../../packages/tex/gateway/agent/promptBudget.js";

const system = [{ type: "text", text: "You are Tex." }];
const tools = [{ name: "fetch", description: "Read a note.", input_schema: { type: "object" } }];

function body(messages) {
  return { model: "claude-haiku-5-5", system, tools, messages };
}

test("a body under the budget is returned as it is", () => {
  const sent = body([{ role: "user", content: [{ type: "text", text: "hello" }] }]);
  const fit = fitHaikuBody(sent);
  assert.equal(fit.shed, 0);
  assert.equal(fit.body, sent);
  assert.ok(fit.before < HAIKU_INPUT_BUDGET);
});

test("oldest tool results are stubbed until a Haiku call is under the cliff, and the newest text stays", () => {
  const page = "x".repeat(400_000);
  const sent = body([
    { role: "user", content: [{ type: "text", text: "what does the lease say" }] },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_1", name: "fetch", input: { id: "lease" } }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: page }],
    },
    { role: "user", content: [{ type: "text", text: "and the deposit?" }] },
  ]);
  assert.ok(estimateBodyTokens(sent) > 100_000);
  const fit = fitHaikuBody(sent);
  assert.ok(fit.shed >= 1);
  assert.ok(fit.after <= HAIKU_INPUT_BUDGET, `still ${fit.after} tokens`);
  assert.equal(fit.body.messages[2].content[0].content, LEFT_OUT);
  assert.equal(fit.body.messages[3].content[0].text, "and the deposit?");
  assert.equal(fit.body.system[0].text, "You are Tex.");
});

test("older history is stubbed when there is no tool result, and a system prompt that is the whole cliff is shortened", () => {
  const page = "x".repeat(400_000);
  const history = body([
    { role: "user", content: [{ type: "text", text: page }] },
    { role: "user", content: [{ type: "text", text: "and the deposit?" }] },
  ]);
  const fit = fitHaikuBody(history);
  assert.ok(fit.after <= HAIKU_INPUT_BUDGET, `history still ${fit.after}`);
  assert.equal(fit.body.messages[0].content[0].text, EARLIER);
  assert.equal(fit.body.messages[1].content[0].text, "and the deposit?");

  const huge = body([{ role: "user", content: [{ type: "text", text: "and the deposit?" }] }]);
  huge.system = [{ type: "text", text: "s".repeat(500_000) }];
  const cut = fitHaikuBody(huge);
  assert.ok(cut.after <= HAIKU_INPUT_BUDGET, `system still ${cut.after}`);
  assert.equal(cut.body.messages[0].content[0].text, "and the deposit?");
  assert.ok(cut.body.system[0].text.length < 500_000);
});

test("older history is stubbed before a tool result in the newest message", () => {
  const history = "h".repeat(200_000);
  const page = "p".repeat(200_000);
  const sent = body([
    { role: "user", content: [{ type: "text", text: history }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_old", content: "Monday's page, already read." }] },
    { role: "user", content: [{ type: "text", text: "what does the lease say" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_now", name: "fetch", input: { id: "lease" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_now", content: page }] },
  ]);
  assert.ok(estimateBodyTokens(sent) > 100_000);
  const fit = fitHaikuBody(sent);
  assert.ok(fit.after <= HAIKU_INPUT_BUDGET, `still ${fit.after} tokens`);
  assert.equal(fit.body.messages[0].content[0].text, EARLIER);
  assert.equal(fit.body.messages[1].content[0].content, LEFT_OUT);
  assert.equal(fit.body.messages[2].content[0].text, "what does the lease say");
  assert.equal(fit.body.messages[4].content[0].content, page);
  assert.equal(sent.messages[4].content[0].content, page);
});

test("a newest message over the budget on its own still loses its tool result", () => {
  const page = "p".repeat(400_000);
  const sent = body([
    { role: "user", content: [{ type: "text", text: "what does the lease say" }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_now", content: page }] },
  ]);
  assert.ok(estimateBodyTokens(body([sent.messages[1]])) > HAIKU_INPUT_BUDGET);
  const fit = fitHaikuBody(sent);
  assert.ok(fit.after <= HAIKU_INPUT_BUDGET, `still ${fit.after} tokens`);
  assert.equal(fit.body.messages[1].content[0].content, LEFT_OUT);
  assert.equal(fit.body.system[0].text, "You are Tex.");
});

test("a text document is counted by its words, a picture as a picture", () => {
  const words = "w".repeat(100_000);
  const withDoc = body([{ role: "user", content: [{ type: "document", source: { type: "text", media_type: "text/plain", data: words } }] }]);
  const withPicture = body([{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "a".repeat(400_000) } }] }]);
  const empty = estimateBodyTokens(body([]));
  assert.ok(estimateBodyTokens(withDoc) - empty > 30_000, "100,000 characters of a text document are tens of thousands of tokens");
  assert.equal(estimateBodyTokens(withPicture) - empty, 1_600);
});

/** A chat that grows by one text, or one tool round, at a time. */
function growingChat() {
  const messages = [];
  let n = 0;
  const say = (role, size) => {
    n += 1;
    messages.push({ role, content: [{ type: "text", text: `${role} ${n}: ${"word ".repeat(size / 5)}` }] });
  };
  const toolRound = (size) => {
    n += 1;
    messages.push({ role: "assistant", content: [{ type: "tool_use", id: `toolu_${n}`, name: "fetch", input: { id: `note-${n}` } }] });
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${n}`, content: `page ${n}: ${"line ".repeat(size / 5)}` }] });
  };
  // A week of texts and a few earlier lookups, just under the budget.
  for (let i = 0; i < 40; i += 1) {
    say(i % 2 ? "assistant" : "user", 4_000);
    if (i % 8 === 3) toolRound(12_000);
  }
  return { messages, say, toolRound };
}

const prefixOf = (fitted, count) => JSON.stringify([fitted.system, fitted.tools, fitted.messages.slice(0, count)]);

test("a growing chat keeps its fitted prefix byte for byte until it has grown by a step", () => {
  const chat = growingChat();
  const big = body(chat.messages);
  big.system = [{ type: "text", text: "s".repeat(60_000) }];
  const bodyNow = () => ({ ...big, messages: chat.messages });
  while (estimateBodyTokens(bodyNow()) <= HAIKU_INPUT_BUDGET) chat.say("user", 4_000);

  let previous = fitHaikuBody(bodyNow());
  let previousCount = chat.messages.length;
  let previousBefore = previous.before;
  let held = 0;
  let longestHeld = 0;
  let largestGrowth = 0;
  let breaks = 0;
  const growths = 60;
  for (let i = 0; i < growths; i += 1) {
    if (i % 2) chat.toolRound(6_000);
    else chat.say("user", 1_500);
    const sent = bodyNow();
    const fit = fitHaikuBody(sent);
    largestGrowth = Math.max(largestGrowth, fit.before - previousBefore);

    // The old guarantees: under the budget, the newest message whole, this round's tool result kept.
    assert.ok(fit.after <= HAIKU_INPUT_BUDGET, `growth ${i}: still ${fit.after}`);
    assert.deepEqual(fit.body.messages.at(-1), sent.messages.at(-1), `growth ${i}: the newest message is sent whole`);
    assert.equal(fit.body.messages.length, sent.messages.length);
    assert.ok(fit.body.system[0].text === big.system[0].text, `growth ${i}: the system prompt is not clipped while history is left`);

    if (prefixOf(fit.body, previousCount) === prefixOf(previous.body, previousCount)) {
      held += 1;
      longestHeld = Math.max(longestHeld, held);
    } else {
      breaks += 1;
      held = 0;
      // A cut moves only when the body crossed into a new step.
      assert.notEqual(Math.ceil((fit.before - HAIKU_INPUT_BUDGET) / TRIM_STEP), Math.ceil((previousBefore - HAIKU_INPUT_BUDGET) / TRIM_STEP), `growth ${i}: the cut moved inside a step`);
    }
    previous = fit;
    previousCount = sent.messages.length;
    previousBefore = fit.before;
  }
  const grown = previousBefore - fitHaikuBody(body([])).before;
  // A step is held for at least as many growths as fit in it, less the one that crossed into it.
  const steady = Math.floor(TRIM_STEP / largestGrowth) - 1;
  assert.ok(steady >= 3, `the fixture grows by ${largestGrowth} a time, too much to show a step`);
  assert.ok(longestHeld >= steady, `the prefix held for ${longestHeld} growths in a row, expected at least ${steady}`);
  assert.ok(breaks <= Math.ceil((growths * largestGrowth) / TRIM_STEP) + 1, `${breaks} rewrites in ${growths} growths`);
  assert.ok(grown > 0);
});

test("the tool result of this round is kept when older history can give the step", () => {
  const chat = growingChat();
  const sent = body(chat.messages);
  while (estimateBodyTokens(sent) <= HAIKU_INPUT_BUDGET + TRIM_STEP) chat.say("user", 4_000);
  chat.toolRound(30_000);
  const fit = fitHaikuBody({ ...sent, messages: chat.messages });
  const last = fit.body.messages.at(-1).content[0];
  assert.equal(last.type, "tool_result");
  assert.notEqual(last.content, LEFT_OUT);
  // Every step it is over is shed, so it lands under the budget by what it grew past the step's start.
  const steps = Math.ceil((fit.before - HAIKU_INPUT_BUDGET) / TRIM_STEP);
  assert.ok(fit.before - fit.after >= steps * TRIM_STEP, `${fit.before} cut to ${fit.after}, ${steps} steps over`);
  // Tool results outside the newest message went before any history text.
  const older = fit.body.messages.slice(0, -1).flatMap((message) => message.content).filter((block) => block.type === "tool_result");
  if (fit.body.messages.some((message) => message.content[0]?.text === EARLIER)) assert.ok(older.every((block) => block.content === LEFT_OUT));
});
