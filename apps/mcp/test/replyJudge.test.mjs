/**
 * THE REPLY JUDGE (`src/agent/replyJudge.js`, Dev2 2026-11-04): Clef reads a
 * texted reply against every action the turn took and picks a verdict;
 * anything but accepted sends the turn back once with the verdict's reason,
 * before anything is sent. The names and places are invented.
 *
 * Sabotage record (2026-11-04), each applied, suite run, named test failing, reverted:
 *  1. `turn.js` calling `answerCheck(answer.text)` without `{ messages }` →
 *     "an accepted reply goes in one round, and the judge read the turn's calls and what came back".
 *  2. `replyJudge` acting on a verdict below `judge_at` →
 *     "a verdict below the setup's confidence, a failed judge or a slow one lets the reply go".
 *  3. `production.js` not reading `reply_judge` → "a setup names its judge".
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { BUILTIN_PROVIDER } from "../src/agent/builtin.js";
import { parseSetup } from "../src/agent/production.js";
import { actionsOf, judgeState, readReplyJudge, replyJudge, VERDICT_NOTICES, VERDICTS } from "../src/agent/replyJudge.js";
import { runTurn } from "../src/agent/turn.js";
import { wireTraceEntry } from "../src/agent/turnLog.js";

const MAIN = "@cf/acme/main-model";
const BROWSE = {
  name: "browse",
  description: "Open a page.",
  inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
};

/** A Workers AI binding: the main model answers from a script; Clef answers from `verdicts`, and keeps what it read. */
function scripted(replies, verdicts) {
  const calls = [];
  const judged = [];
  return {
    calls,
    judged,
    async run(model, input) {
      if (model.startsWith("@cf/cloudflare/clef")) {
        judged.push({ model, selector: input.model, state: input.state, questions: input.questions });
        const next = verdicts.shift();
        if (next instanceof Error) throw next;
        return next === undefined ? null : { answers: { verdict: next } };
      }
      calls.push(input.messages);
      const reply = replies.shift();
      if (!reply) throw new Error("script ran out");
      const tool_calls = (reply.calls ?? []).map((call, i) => ({
        id: `call_${calls.length}_${i}`,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.args) },
      }));
      return { choices: [{ message: { content: reply.text ?? "", tool_calls } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
    },
  };
}

const history = [
  { role: "user", text: "where's the garden club logo?" },
  { role: "assistant", text: "Not in your notes or email. Where do you keep it?" },
];
const question = "it's on filebox.example under resources then brand assets";

function turn(ai, judge) {
  return runTurn({
    question,
    history,
    credential: { provider: BUILTIN_PROVIDER, apiKey: null },
    tools: [BROWSE],
    env: { AI: ai, AGENT_BUILTIN_MODEL: MAIN },
    providerOptions: { ai },
    texting: true,
    builtinModelOverride: MAIN,
    answerCheck: judge.check,
    callTool: async () => ({ content: [{ type: "text", text: "brand-assets: garden-club-logo.png https://filebox.example/garden-club/resources/brand-assets/garden-club-logo.png" }] }),
  });
}

test("the judge sees every action the turn took and sends a dropped ask back once", async () => {
  const ai = scripted(
    [
      { text: "Thanks, that helps." },
      { calls: [{ name: "browse", args: { url: "https://filebox.example/garden-club/resources/brand-assets" } }] },
      { text: "Here it is: https://filebox.example/garden-club/resources/brand-assets/garden-club-logo.png" },
    ],
    [{ choice: "only_acknowledged", confidence: 0.9 }],
  );
  const logs = [];
  const judge = replyJudge({ ai, setting: { model: "clef-flash", at: 0.5 }, question, history, log: (line) => logs.push(line) });
  const result = await turn(ai, judge);
  assert.equal(result.answer, "Here it is: https://filebox.example/garden-club/resources/brand-assets/garden-club-logo.png");
  assert.equal(ai.judged.length, 1, "judged once a turn: the second reply goes as it is");
  assert.equal(ai.judged[0].model, "@cf/cloudflare/clef-flash");
  assert.equal(ai.judged[0].selector, "clef-flash");
  assert.ok(ai.judged[0].state.includes("The reply about to be sent: Thanks, that helps."));
  assert.ok(ai.judged[0].state.includes("nothing: no searches"), "a reply with no actions says so");
  assert.ok(JSON.stringify(ai.calls[1]).includes(VERDICT_NOTICES.only_acknowledged), "the model is told the reason before it writes again");
  assert.deepEqual(ai.judged[0].questions.verdict.criteria, VERDICTS);
  assert.equal(judge.verdicts[0].verdict, "only_acknowledged");
  assert.equal(judge.verdicts[0].acted, true);
  const judged = result.timing.trace.filter((entry) => entry.kind === "judge");
  assert.equal(judged.length, 1, "the verdict is in the turn's trace, for the turn log and the benchmark");
  assert.equal(judged[0].verdict, "only_acknowledged");
  assert.deepEqual(wireTraceEntry(judged[0]), { kind: "judge", ok: true, ms: judged[0].ms, verdict: "only_acknowledged", acted: true });
  const logged = JSON.parse(logs[0]);
  assert.equal(logged.event, "tex_reply_judge");
  assert.ok(!logs[0].includes("Thanks"), "the log carries no words of the reply");
});

test("an accepted reply goes in one round, and the judge read the turn's calls and what came back", async () => {
  const ai = scripted(
    [
      { calls: [{ name: "browse", args: { url: "https://filebox.example/garden-club/resources/brand-assets" } }] },
      { text: "Here it is: https://filebox.example/garden-club/resources/brand-assets/garden-club-logo.png" },
    ],
    [{ choice: "accepted", confidence: 0.95 }],
  );
  const judge = replyJudge({ ai, setting: { model: "clef" }, question, history });
  const result = await turn(ai, judge);
  assert.match(result.answer, /^Here it is/);
  assert.equal(ai.calls.length, 2);
  const state = ai.judged[0].state;
  assert.ok(state.includes('- called browse {"url":"https://filebox.example/garden-club/resources/brand-assets"}'));
  assert.ok(state.includes("returned: brand-assets: garden-club-logo.png"));
  assert.ok(state.includes("Person: where's the garden club logo?"), "earlier texts are there");
  assert.ok(state.indexOf("Their text now") < state.indexOf("What the assistant did"), "the ask and the reply come first, so a cut never loses them");
});

test("a verdict below the setup's confidence, a failed judge or a slow one lets the reply go", async () => {
  for (const verdict of [{ choice: "not_started", confidence: 0.3 }, new Error("down"), undefined, { choice: "made_up", confidence: 1 }]) {
    const ai = scripted([{ text: "Thanks, that helps." }], [verdict]);
    const judge = replyJudge({ ai, setting: { model: "clef", at: 0.6 }, question, history, log: () => {} });
    const result = await turn(ai, judge);
    assert.equal(result.answer, "Thanks, that helps.", String(verdict?.choice ?? verdict));
    assert.equal(ai.calls.length, 1);
  }
  let now = 0;
  const slow = { run: () => new Promise(() => {}) };
  const judge = replyJudge({ ai: slow, setting: { model: "clef" }, question, clock: () => (now += 10), log: () => {} });
  assert.equal(await judge.check("Thanks."), null, "a judge that never answers is cut off and the reply goes");
});

test("the turn's other check runs first, and no Workers AI binding means no judge", async () => {
  const inner = { check: async () => "inner notice" };
  const ai = scripted([], [{ choice: "not_started", confidence: 1 }]);
  const judge = replyJudge({ ai, setting: { model: "clef" }, question, inner, log: () => {} });
  assert.equal(await judge.check("x", { messages: [] }), "inner notice");
  assert.equal(ai.judged.length, 0);
  assert.equal(await replyJudge({ ai: null, setting: { model: "clef" }, question }).check("x"), null);
});

test("actions list each call with its arguments and each result, failures marked", () => {
  const lines = actionsOf([
    { role: "assistant", text: "", toolCalls: [{ name: "search_notes", args: { query: "logo" } }] },
    { role: "tool", name: "search_notes", text: "No notes matched.", isError: false },
    { role: "assistant", text: "", toolCalls: [{ name: "open_page", args: { url: "https://x.example" } }] },
    { role: "tool", name: "open_page", text: "That page could not be opened.", isError: true },
  ]);
  assert.deepEqual(lines, [
    '- called search_notes {"query":"logo"}',
    "  returned: No notes matched.",
    '- called open_page {"url":"https://x.example"}',
    "  failed: That page could not be opened.",
  ]);
  assert.ok(judgeState({ question: "q", answer: "a", messages: [] }).length < 16_001);
  assert.ok(judgeState({ question: "q", answer: "a".repeat(50_000), messages: [] }).length <= 16_000);
});

test("a setup names its judge", async () => {
  assert.equal(readReplyJudge(undefined, undefined), null);
  assert.deepEqual(readReplyJudge("clef", undefined), { model: "clef", at: 0.5 });
  assert.deepEqual(readReplyJudge("clef-flash", "0.7"), { model: "clef-flash", at: 0.7 });
  assert.equal(readReplyJudge("haiku", undefined), undefined, "only a decision model");
  assert.equal(readReplyJudge("clef", "2"), undefined);
  assert.equal(readReplyJudge(undefined, "0.5"), undefined, "a confidence with no judge");
  const setup = (extra) => `---\njob: texting-assistant\nmodels:\n  main: anthropic/claude-haiku-5-5\n${extra}---\n\nAnswer from their notes.\n`;
  assert.deepEqual((await parseSetup(setup("reply_judge: clef-flash\njudge_at: 0.6\n")))?.replyJudge, { model: "clef-flash", at: 0.6 });
  assert.equal((await parseSetup(setup("")))?.replyJudge, null);
  assert.equal(await parseSetup(setup("reply_judge: opus\n")), null);
});
