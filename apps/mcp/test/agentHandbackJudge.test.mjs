/**
 * The hand-back judge (`src/agent/handbackJudge.js`; the owner adopted the
 * hand-back rule on 2026-10-22, docs/decisions/texting-assistant/handing-back.md).
 * A phrase can show "forward me the receipt"; only something that knows what
 * Tex can do sees "which receipt does she need?" as handing work back. The
 * judge labels each ask with the decision's codes, and an H-code sends the
 * answer back once, worded for that code.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted (2026-10-22).
 *
 *  1. `judgeOnce` never calling the judge. → "an ask for what Tex could find
 *     goes back, worded for that code, and the judge runs once" fails.
 *  2. `runTurn` not awaiting `answerCheck`. → "runTurn waits for the judge
 *     and gives the model one more round" fails.
 *  3. `handbackJudgeFor` sending a tool's result to the judge. → "the judge
 *     reads the person's text, the answer and tool names, never a result" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { BUILTIN_PROVIDER } from "../src/agent/builtin.js";
import { claimCheck } from "../src/agent/claimCheck.js";
import { CODE_NOTICES, handbackJudgeFor, mayAsk, noticeFor, readAsks } from "../src/agent/handbackJudge.js";
import { runTurn } from "../src/agent/turn.js";

const CONFIG = { accountId: "acct", gateway: "gw", token: "t" };

/** A model road that answers `text` and records what it was asked. */
function road(text) {
  const asked = [];
  const request = async (body) => {
    asked.push(body);
    if (text instanceof Error) throw text;
    return { text };
  };
  return { asked, request };
}

test("the judge's answer is read strictly: only codes it knows, in JSON", () => {
  assert.deepEqual(readAsks('{"asks": [{"code": "H9", "quote": "Which receipt does she need?"}, {"code": "Z1"}]}'), [{ code: "H9", quote: "Which receipt does she need?" }]);
  assert.deepEqual(readAsks('{"asks": []}'), []);
  assert.equal(readAsks("I think it's fine"), null);
  assert.equal(readAsks('{"asks": "none"}'), null);
});

test("only an answer that may ask them something is judged", () => {
  for (const said of ["Which receipt does she need?", "Text me once the records are in.", "You'll need to sign in first.", "Tap this link to approve it."]) assert.ok(mayAsk(said), said);
  for (const said of ["Forwarded it to Kansi with the receipt.", "Your plan renews Nov 3 for $11.99."]) assert.equal(mayAsk(said), false, said);
});

// Hand-back bench case 8, 2026-10-26: Tex found the serving email, then sent
// her to look herself with no question mark, so the judge never saw it.
// Sabotage: the "check that in" alternative removed → this test fails.
test("an order to go and check somewhere is judged, with no question mark", () => {
  for (const said of [
    "the email doesn't say whether you've already answered, so check that in Planning Center.",
    "Check it on their site to be sure.",
    "Just check there before Sunday.",
  ]) assert.ok(mayAsk(said), said);
  for (const said of ["I'll check it on their site at 9.", "I checked that in Planning Center: you accepted.", "Check-in opens at 9am."]) assert.equal(mayAsk(said), false, said);
});

test("every hand-back code has its own notice, and a fair-ask code has none", () => {
  for (const code of Object.keys(CODE_NOTICES)) assert.match(noticeFor(code), /^Before this goes: /, code);
  assert.equal(Object.keys(CODE_NOTICES).length, 12);
  assert.equal(noticeFor("K1"), null);
  assert.match(noticeFor("H11"), /tex\/routines\//);
});

test("an H-code sends the answer back; fair asks, no asks and a failed judge let it go", async () => {
  const lines = [];
  const log = (line) => lines.push(JSON.parse(line));
  const judge = (text) => handbackJudgeFor({ question: "why didn't Kansi get the receipt", config: CONFIG, request: road(text).request, log, metadata: { workspace: "ws_1" } });
  assert.equal(await judge('{"asks": [{"code": "H9", "quote": "Which receipt does she need?"}]}')("Which receipt does she need?"), noticeFor("H9"));
  assert.equal(await judge('{"asks": [{"code": "Y2", "quote": "Want me to send it?"}]}')("Want me to send it?"), null);
  assert.equal(await judge('{"asks": []}')("Anything else?"), null);
  assert.equal(await judge(new Error("down"))("Which receipt?"), null);
  assert.equal(await judge("no json")("Which receipt?"), null);
  assert.deepEqual(lines.map((l) => [l.event, l.judged, l.codes, l.sentBack]), [
    ["handback_judged", true, ["H9"], "H9"],
    ["handback_judged", true, ["Y2"], null],
    ["handback_judged", true, [], null],
    ["handback_judged", false, [], null],
    ["handback_judged", false, [], null],
  ]);
  assert.ok(lines.every((l) => !JSON.stringify(l).includes("receipt")), "the log holds codes, never words");
  assert.equal(handbackJudgeFor({ question: "x", config: null }), null, "no model road, no judge");
});

test("the judge reads the person's text, the answer and tool names, never a result", async () => {
  const { asked, request } = road('{"asks": []}');
  const judge = handbackJudgeFor({ question: "why didn't Kansi get the receipt", config: CONFIG, request, log: () => {} });
  const claims = claimCheck({ question: "why didn't Kansi get the receipt", judge });
  const call = claims.wrap(async () => ({ content: [{ type: "text", text: "SECRET-RESULT from Google Payments" }] }));
  await call("search_email", { query: "receipt" });
  await claims.check("Which one does she need?");
  const sent = JSON.stringify(asked[0]);
  assert.match(sent, /search_email: ok/);
  assert.match(sent, /Which one does she need\?/);
  assert.match(sent, /why didn't Kansi get the receipt/);
  assert.ok(!sent.includes("SECRET-RESULT"));
});

test("an ask for what Tex could find goes back, worded for that code, and the judge runs once", async () => {
  let calls = 0;
  const judge = async () => ((calls += 1), noticeFor("H9"));
  const claims = claimCheck({ question: "pay the water bill", judge });
  assert.equal(await claims.check("Sure! What's your account number, and how much is it?"), noticeFor("H9"));
  assert.equal(await claims.check("What's your account number?"), null, "once a turn");
  assert.equal(calls, 1);
  const quiet = claimCheck({ question: "pay the water bill", judge });
  assert.equal(quiet.check("Paid $64.20."), null, "nothing asked, nothing judged");
  assert.equal(calls, 1);
});

/** A Workers AI binding that answers from a script, one reply per call. */
function scripted(replies) {
  const calls = [];
  return {
    calls,
    async run(model, input) {
      calls.push(input.messages);
      const reply = replies.shift();
      if (!reply) throw new Error("script ran out");
      return { choices: [{ message: { content: reply, tool_calls: [] } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
    },
  };
}

test("runTurn waits for the judge and gives the model one more round", async () => {
  const MAIN = "@cf/acme/main-model";
  const ai = scripted(["Sure! What's your account number?", "October's bill is $64.20 (account ending 4471). Reply yes and I'll pay it."]);
  const claims = claimCheck({ question: "pay the water bill", judge: async () => noticeFor("H9") });
  const result = await runTurn({
    question: "pay the water bill",
    credential: { provider: BUILTIN_PROVIDER, apiKey: null },
    tools: [],
    env: { AI: ai, AGENT_BUILTIN_MODEL: MAIN },
    providerOptions: { ai },
    texting: true,
    builtinModelOverride: MAIN,
    answerCheck: claims.check,
    callTool: claims.wrap(async () => ({ content: [] })),
  });
  assert.equal(ai.calls.length, 2);
  assert.ok(JSON.stringify(ai.calls[1]).includes("you ask for something you can find"));
  assert.match(result.answer, /\$64\.20/);
});

// The owner's 1:1, 2026-10-26: five priced lunch spots found, then a notice's round texted only
// "Namudol ... I can't give you a price for it. I didn't change anything, so there's nothing to undo."
// Sabotage record: with `RECHECK_REPLACES` left off the notice in turn.js, this test fails.
test("a notice's round is told its answer replaces the last one, and H8 never asks for a 'nothing to undo'", async () => {
  const { RECHECK_REPLACES } = await import("../src/agent/recheck.js");
  const MAIN = "@cf/acme/main-model";
  const ai = scripted(["Want me to look up Namudol?", "Hibino $12, Sapps $15, Namudol $14."]);
  const claims = claimCheck({ question: "lunch near me with prices", judge: async () => noticeFor("H8") });
  await runTurn({
    question: "lunch near me with prices",
    credential: { provider: BUILTIN_PROVIDER, apiKey: null },
    tools: [],
    env: { AI: ai, AGENT_BUILTIN_MODEL: MAIN },
    providerOptions: { ai },
    texting: true,
    builtinModelOverride: MAIN,
    answerCheck: claims.check,
    callTool: claims.wrap(async () => ({ content: [] })),
  });
  const sent = JSON.stringify(ai.calls[1]);
  assert.ok(sent.includes(JSON.stringify(RECHECK_REPLACES).slice(1, -1)), "the notice says the next answer must stand on its own");
  assert.match(RECHECK_REPLACES, /keep every option, figure and link/);
  // "To undo it, archive that note." in the Tex Devs group (2026-10-26): no undo line at all.
  assert.match(noticeFor("H8"), /never add a line about undoing it/);
});
