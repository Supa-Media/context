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
 *
 * Sabotage record (2026-11-26): main's rule before the fix (only the frame's last message kept, the ask's
 * message cut as older history, this turn's tool answers before a clip) fails "a tool round that crosses
 * into a new step…", "a later round of the same turn…" and "when the system prompt and tools are the
 * overflow…"; the clip allowed inside the turn fails "a newest message over the budget on its own…"; this
 * turn's tool answers put before the clip fails "a tool round that crosses…" and "when the system prompt…";
 * `aiGateway.js` not passing `turnFrom` fails "a texted turn's call tells the trim where its ask is…"; a
 * clip always before this turn's tool result fails "a lookup longer than the system prompt goes…".
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

/**
 * A Lab test chat, 2026-11-26 (test chat 844dda0745443c68): round 1 of a calendar-and-notes ask came to
 * 142,055 estimated tokens, step 3; its two tool answers took round 2 to 144,860, step 4. The frame then
 * ran to the tool answers, and with only the newest message kept, the ask's message (its preamble and
 * the person's words) was cut as older history: 144,860 down to 61,534, and the front door answered "I
 * don't see your message this time, only placeholders".
 */
function askThenToolRound(roundOneTokens) {
  const ask = "never mind that. what's on my calendar tomorrow, and what did I last write about Togather?";
  const preamble = "p".repeat(37_900);
  const head = body([]);
  head.system = [{ type: "text", text: "s".repeat(120_000) }];
  // The week's texts with their pictures (`weekHistory.js`): a picture is no text to stub, so older
  // history alone cannot give four steps.
  const picture = { type: "image", source: { type: "base64", media_type: "image/png", data: "a".repeat(64) } };
  const history = (chars) => [
    { role: "user", content: [{ type: "text", text: `Your texts so far.\n${"h".repeat(chars)}` }, ...Array.from({ length: 30 }, () => picture), { type: "text", text: "(end of the history)" }] },
    { role: "assistant", content: [{ type: "text", text: "earlier answer" }] },
  ];
  const askMessage = { role: "user", content: [{ type: "text", text: preamble }, { type: "text", text: ask }] };
  // History sized so round 1 lands at `roundOneTokens`.
  const without = estimateBodyTokens({ ...head, messages: [...history(0), askMessage] });
  const chars = Math.round((roundOneTokens - without) * 2.68);
  const roundOne = { ...head, messages: [...history(chars), askMessage] };
  const roundTwo = {
    ...head,
    messages: [
      ...roundOne.messages,
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_cal", name: "read_calendar", input: {} }, { type: "tool_use", id: "toolu_find", name: "search_notes", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_cal", content: `Friday: ${"c".repeat(3_800)}` }, { type: "tool_result", tool_use_id: "toolu_find", content: `Togather: ${"t".repeat(3_400)}` }] },
    ],
  };
  return { ask, preamble, roundOne, roundTwo };
}

test("a tool round that crosses into a new step keeps the person's ask and its preamble", () => {
  const { ask, preamble, roundOne, roundTwo } = askThenToolRound(HAIKU_INPUT_BUDGET + 3 * TRIM_STEP - 1_000);
  // The ask is just past the history, as `aiGateway.js` passes it from the turn's cached history.
  const turnFrom = roundOne.messages.length - 1;
  const first = fitHaikuBody(roundOne, { turnFrom });
  const second = fitHaikuBody(roundTwo, { turnFrom });
  const step = (tokens) => Math.ceil((tokens - HAIKU_INPUT_BUDGET) / TRIM_STEP);
  assert.equal(step(first.before), 3);
  assert.equal(step(second.before), 4, "the fixture's tool round crosses into the next step");
  const askAt = roundTwo.messages.length - 3;
  for (const [name, fit] of [["round 1", first], ["round 2", second]]) {
    const words = fit.body.messages[name === "round 1" ? fit.body.messages.length - 1 : askAt].content;
    assert.equal(words.at(-1).text, ask, `${name}: the person's words are sent`);
    assert.equal(words[0].text, preamble, `${name}: the turn's preamble is sent`);
    assert.ok(fit.after <= HAIKU_INPUT_BUDGET, `${name}: still ${fit.after}`);
  }
  // This round's tool answers are sent whole, and older history went instead.
  for (const block of second.body.messages.at(-1).content) assert.notEqual(block.content, LEFT_OUT);
  assert.equal(second.body.messages[0].content[0].text, EARLIER);
});

test("a later round of the same turn keeps the turn's earlier tool answers while older history is left", () => {
  const { ask, roundTwo } = askThenToolRound(HAIKU_INPUT_BUDGET + 2 * TRIM_STEP);
  const roundThree = {
    ...roundTwo,
    messages: [
      ...roundTwo.messages,
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_more", name: "fetch", input: { id: "togather" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_more", content: `The note: ${"n".repeat(30_000)}` }] },
    ],
  };
  const askAt = roundThree.messages.length - 5;
  const fit = fitHaikuBody(roundThree, { turnFrom: askAt });
  assert.ok(fit.after <= HAIKU_INPUT_BUDGET, `still ${fit.after}`);
  assert.equal(fit.body.messages[askAt].content.at(-1).text, ask);
  for (const message of fit.body.messages.slice(askAt + 1)) {
    for (const block of message.content) if (block.type === "tool_result") assert.notEqual(block.content, LEFT_OUT, `${block.tool_use_id} was left out`);
  }
  assert.equal(fit.body.messages[0].content[0].text, EARLIER);
});

test("when the system prompt and tools are the overflow, a tool round clips them and keeps the ask and its answers", () => {
  // The Lab test chat's own shape: one earlier turn, a 215,706-character stable module, the tool list,
  // the ask with a 37,890-character preamble, then two lookups.
  const ask = "never mind that. what's on my calendar tomorrow, and what did I last write about Togather?";
  const sent = {
    model: "claude-haiku-5-5",
    system: [{ type: "text", text: "s".repeat(215_706) }, { type: "text", text: "c".repeat(30_313) }],
    tools: [{ name: "fetch", description: "d".repeat(96_614), input_schema: { type: "object" } }],
    messages: [
      { role: "user", content: [{ type: "text", text: "Thu 9:06 AM: yeah that was me" }] },
      { role: "assistant", content: [{ type: "text", text: "got it" }] },
      { role: "user", content: [{ type: "text", text: "p".repeat(37_890) }, { type: "text", text: ask }] },
    ],
  };
  const roundOne = fitHaikuBody(sent, { turnFrom: 2 });
  const roundTwo = fitHaikuBody({
    ...sent,
    messages: [
      ...sent.messages,
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_cal", name: "read_calendar", input: {} }, { type: "tool_use", id: "toolu_find", name: "search_notes", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_cal", content: "c".repeat(3_834) }, { type: "tool_result", tool_use_id: "toolu_find", content: "t".repeat(3_800) }] },
    ],
  }, { turnFrom: 2 });
  for (const [name, fit] of [["round 1", roundOne], ["round 2", roundTwo]]) {
    assert.ok(fit.after <= HAIKU_INPUT_BUDGET, `${name}: still ${fit.after}`);
    assert.equal(fit.body.messages[2].content[0].text.length, 37_890, `${name}: the preamble is sent whole`);
    assert.equal(fit.body.messages[2].content[1].text, ask, `${name}: the person's words are sent`);
    assert.ok(fit.body.system[0].text.length < 215_706, `${name}: the system prompt is what gave`);
  }
  for (const block of roundTwo.body.messages.at(-1).content) assert.notEqual(block.content, LEFT_OUT, `${block.tool_use_id} was left out`);
  // The system prompt is clipped the same in both rounds, so round 2 still reads round 1's cached system.
  assert.equal(roundTwo.body.system[0].text, roundOne.body.system[0].text);
});

test("a texted turn's call tells the trim where its ask is, so a tool round keeps it", async () => {
  const { aiGatewayConfig, requestViaGateway, resetCreditState } = await import("../../../packages/tex/gateway/agent/aiGateway.js");
  resetCreditState();
  const ask = "never mind that. what's on my calendar tomorrow, and what did I last write about Togather?";
  const history = [
    { role: "user", text: "Thu 9:06 AM: yeah that was me" },
    { role: "assistant", text: "got it" },
  ];
  const call = {
    model: "anthropic/claude-haiku-5-5",
    system: { stable: "s".repeat(215_706), context: "c".repeat(30_313) },
    tools: [{ name: "read_calendar", description: "d".repeat(96_614), inputSchema: { type: "object" } }],
    messages: [
      ...history,
      { role: "user", text: ask, preamble: "p".repeat(37_890) },
      { role: "assistant", text: "", toolCalls: [{ id: "toolu_cal", name: "read_calendar", args: {} }, { id: "toolu_find", name: "read_calendar", args: {} }] },
      { role: "tool", id: "toolu_cal", name: "read_calendar", text: "c".repeat(3_834) },
      { role: "tool", id: "toolu_find", name: "read_calendar", text: "t".repeat(3_800) },
    ],
    cachedThrough: history.length,
  };
  const sent = [];
  const fetchImpl = async (_url, init) => {
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ id: "m", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const env = { AI_GATEWAY_ACCOUNT_ID: "0123456789abcdef0123456789abcdef", AI_GATEWAY_ID: "gw", AI_GATEWAY_TOKEN: `gw-token-${"a".repeat(20)}` };
  await requestViaGateway(call, aiGatewayConfig(env), { fetchImpl });
  const words = JSON.stringify(sent[0].messages);
  assert.ok(words.includes(ask), "the person's words are sent");
  assert.ok(words.includes("p".repeat(37_890)), "the turn's preamble is sent whole");
  assert.ok(!words.includes(LEFT_OUT), "this round's answers are sent");
});

test("a lookup longer than the system prompt goes before the system prompt is clipped", () => {
  const sent = {
    model: "claude-haiku-5-5",
    system: [{ type: "text", text: "s".repeat(215_706) }],
    tools,
    messages: [
      { role: "user", content: [{ type: "text", text: "what does the lease say" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_now", name: "fetch", input: { id: "lease" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_now", content: "p".repeat(400_000) }] },
    ],
  };
  const fit = fitHaikuBody(sent, { turnFrom: 0 });
  assert.ok(fit.after <= HAIKU_INPUT_BUDGET, `still ${fit.after}`);
  assert.equal(fit.body.messages[2].content[0].content, LEFT_OUT);
  assert.equal(fit.body.messages[0].content[0].text, "what does the lease say");
  assert.ok(fit.body.system[0].text.length >= 215_706 / 2 - EARLIER.length - 1, `the system prompt cut to ${fit.body.system[0].text.length}`);
});
