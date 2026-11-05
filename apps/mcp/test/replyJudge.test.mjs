/**
 * THE REPLY JUDGES (`src/agent/replyJudge.js` + `replyGates.js`, Dev2 2026-11-04,
 * made parallel gates 2026-11-05): each gate is its own Clef Flash yes/no call
 * on the same packet, all at once; every failed gate goes back to the model in
 * one notice naming it; only failed gates read the rewrite; at most two
 * send-backs a turn. The names and places are invented.
 *
 * Sabotage record (2026-11-05), each applied, suite run, named test failing, reverted:
 *  1. `MAX_SEND_BACKS` check removed from `check` → "at most two send-backs…".
 *  2. `open = failed` removed (every gate re-reads the rewrite) → "only the failed gates read the rewrite".
 *  3. failing on `>` instead of `>=` its threshold → "a gate fails at its threshold…".
 *  4. `gatesFor` ignoring `job` → "a job's report skips the texting-only gates".
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { BUILTIN_PROVIDER } from "../src/agent/builtin.js";
import { parseSetup } from "../src/agent/production.js";
import { actionsOf, judgeState, MAX_SEND_BACKS, readReplyJudge, replyJudge, runGates } from "../src/agent/replyJudge.js";
import { GATES, gatesFor, sendBackNotice } from "../src/agent/replyGates.js";
import { runTurn } from "../src/agent/turn.js";
import { wireTraceEntry } from "../src/agent/turnLog.js";

const MAIN = "@cf/acme/main-model";
const BROWSE = {
  name: "browse",
  description: "Open a page.",
  inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
};

/**
 * A Workers AI binding: the main model answers from a script; each Clef call is one gate, answered from
 * the current judging's yes values (`verdicts`, one object per judging; an unnamed gate says 0.05). A
 * judging moves on once every gate it ran has answered.
 */
function scripted(replies, verdicts) {
  const calls = [];
  const judged = [];
  return {
    calls,
    judged,
    async run(model, input) {
      if (model.startsWith("@cf/cloudflare/clef")) {
        const [name] = Object.keys(input.questions);
        judged.push({ model, selector: input.model, state: input.state, questions: input.questions, gate: name });
        const next = verdicts[0];
        if (next instanceof Error) throw next;
        if (next === undefined) return null;
        next.__seen = (next.__seen ?? 0) + 1;
        if (next.__seen >= (next.__ran ?? Object.keys(GATES).length)) verdicts.shift();
        return { answers: { [name]: { type: "noul", noul: next[name] ?? 0.05 } } };
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

test("every gate runs at once on the same packet, and each failed gate goes back by name", async () => {
  const ai = scripted(
    [
      { text: "Thanks, that helps." },
      { calls: [{ name: "browse", args: { url: "https://filebox.example/garden-club/resources/brand-assets" } }] },
      { text: "Here it is: https://filebox.example/garden-club/resources/brand-assets/garden-club-logo.png" },
    ],
    [{ finished: 0.9, heard_them: 0.6 }, { __ran: 2 }],
  );
  const logs = [];
  const judge = replyJudge({ ai, setting: { model: "clef-flash", at: null }, question, history, log: (line) => logs.push(line) });
  const result = await turn(ai, judge);
  assert.equal(result.answer, "Here it is: https://filebox.example/garden-club/resources/brand-assets/garden-club-logo.png");
  const first = ai.judged.slice(0, 8);
  assert.deepEqual(first.map((call) => call.gate).sort(), Object.keys(GATES).sort(), "one call per gate, each asking one question");
  assert.ok(first.every((call) => call.model === "@cf/cloudflare/clef-flash" && call.selector === "clef-flash"));
  assert.ok(first.every((call) => call.state === first[0].state), "every gate reads the same packet");
  assert.ok(first[0].state.includes("The reply about to be sent: Thanks, that helps."));
  assert.ok(first[0].state.includes("nothing: no searches"), "a reply with no actions says so");
  const told = JSON.stringify(ai.calls[1]);
  assert.ok(told.includes("finished:") && told.includes("heard them:"), "the model is told which gates failed");
  assert.ok(told.includes(JSON.stringify(GATES.finished.notice).slice(1, -1)), "and what each one needs");
  assert.ok(!told.includes("short and clean:"), "a gate that passed is not named");
  assert.equal(judge.verdicts[0].verdict, "finished,heard_them");
  assert.equal(judge.verdicts[0].acted, true);
  const judged = result.timing.trace.filter((entry) => entry.kind === "judge");
  assert.equal(judged.length, 2, "both judgings are in the turn's trace");
  assert.deepEqual(wireTraceEntry(judged[0]), { kind: "judge", ok: true, ms: judged[0].ms, verdict: "finished,heard_them", acted: true, confidence: 0.9 });
  const logged = JSON.parse(logs[0]);
  assert.equal(logged.event, "tex_reply_gates");
  assert.deepEqual(logged.failed, ["finished", "heard_them"]);
  assert.ok(!logs[0].includes("Thanks"), "the log carries no words of the reply");
});

test("an accepted reply goes in one round, and the gates read the turn's calls and what came back", async () => {
  const ai = scripted(
    [
      { calls: [{ name: "browse", args: { url: "https://filebox.example/garden-club/resources/brand-assets" } }] },
      { text: "Here it is: https://filebox.example/garden-club/resources/brand-assets/garden-club-logo.png" },
    ],
    [{}],
  );
  const judge = replyJudge({ ai, setting: { model: "clef", at: null }, question, history, log: () => {} });
  const result = await turn(ai, judge);
  assert.match(result.answer, /^Here it is/);
  assert.equal(ai.calls.length, 2);
  const state = ai.judged[0].state;
  assert.ok(state.includes('- called browse {"url":"https://filebox.example/garden-club/resources/brand-assets"}'));
  assert.ok(state.includes("returned: brand-assets: garden-club-logo.png"));
  assert.ok(state.includes("Person: where's the garden club logo?"), "earlier texts are there");
  assert.ok(state.indexOf("Their text now") < state.indexOf("What the assistant did"), "the ask and the reply come first, so a cut never loses them");
});

test("only the failed gates read the rewrite", async () => {
  const ai = scripted([{ text: "Thanks." }, { text: "Still thanks." }, { text: "Here it is." }], [{ finished: 0.9, does_it: 0.8 }, { __ran: 2 }]);
  const judge = replyJudge({ ai, setting: { model: "clef-flash", at: null }, question, history, log: () => {} });
  await turn(ai, judge);
  assert.deepEqual(ai.judged.slice(8).map((call) => call.gate).sort(), ["does_it", "finished"]);
  assert.equal(judge.verdicts[1].verdict, "accepted");
});

test("at most two send-backs: the third reply goes as it is", async () => {
  const ai = scripted(
    [{ text: "one" }, { text: "two" }, { text: "three" }],
    [{ finished: 0.9 }, { finished: 0.9, __ran: 1 }, { finished: 0.9, __ran: 1 }],
  );
  const judge = replyJudge({ ai, setting: { model: "clef-flash", at: null }, question, history, log: () => {} });
  const result = await turn(ai, judge);
  assert.equal(MAX_SEND_BACKS, 2);
  assert.equal(result.answer, "three");
  assert.equal(judge.verdicts.length, 2, "judged twice, then the reply goes unjudged");
  assert.equal(ai.calls.length, 3);
});

test("a gate fails at its threshold; below it, or failed, or slow, the reply goes", async () => {
  for (const verdict of [{ finished: 0.59, does_it: 0.3 }, new Error("down"), undefined, { made_up: 1 }]) {
    const ai = scripted([{ text: "Thanks, that helps." }], [verdict]);
    const judge = replyJudge({ ai, setting: { model: "clef", at: 0.6 }, question, history, log: () => {} });
    const result = await turn(ai, judge);
    assert.equal(result.answer, "Thanks, that helps.", String(verdict));
    assert.equal(ai.calls.length, 1);
  }
  const at = scripted([], [{ finished: 0.6 }]);
  assert.ok(await replyJudge({ ai: at, setting: { model: "clef", at: 0.6 }, question, history, log: () => {} }).check("x", { messages: [] }), "exactly at the threshold fails");
  let now = 0;
  const slow = { run: () => new Promise(() => {}) };
  const judge = replyJudge({ ai: slow, setting: { model: "clef" }, question, clock: () => (now += 10), log: () => {} });
  assert.equal(await judge.check("Thanks."), null, "a gate that never answers is cut off and the reply goes");
});

test("a gate's own threshold applies when the setup names none", async () => {
  const saved = GATES.finished.at;
  GATES.finished.at = 0.8;
  try {
    const ai = scripted([], [{ finished: 0.7 }]);
    assert.equal(await replyJudge({ ai, setting: { model: "clef", at: null }, question, history, log: () => {} }).check("x", { messages: [] }), null);
  } finally {
    GATES.finished.at = saved;
  }
});

test("a job's report skips the texting-only gates", async () => {
  assert.ok(!gatesFor({ job: true }).includes("short_and_clean"));
  assert.deepEqual(gatesFor(), Object.keys(GATES));
  const ai = scripted([], [{ __ran: Object.keys(GATES).length - 1 }]);
  await replyJudge({ ai, setting: { model: "clef", at: null }, question, history, job: true, log: () => {} }).check("x", { messages: [] });
  assert.ok(!ai.judged.some((call) => call.gate === "short_and_clean"));
});

test("the turn's other check runs first, and no Workers AI binding means no judge", async () => {
  const inner = { check: async () => "inner notice" };
  const ai = scripted([], [{ finished: 1 }]);
  const judge = replyJudge({ ai, setting: { model: "clef" }, question, inner, log: () => {} });
  assert.equal(await judge.check("x", { messages: [] }), "inner notice");
  assert.equal(ai.judged.length, 0);
  assert.equal(await replyJudge({ ai: null, setting: { model: "clef" }, question }).check("x"), null);
});

test("runGates keeps only real numbers, and the notice lists gates in their order", async () => {
  const decide = async (state, questions) => {
    const [name] = Object.keys(questions);
    return name === "sourced" ? null : { [name]: { noul: name === "finished" ? 0.7 : Number.NaN } };
  };
  assert.deepEqual(await runGates(decide, "s", ["finished", "sourced", "does_it"]), { finished: 0.7 });
  const notice = sendBackNotice(["sourced", "did_what_it_says"]);
  assert.ok(notice.indexOf("did what it says:") < notice.indexOf("sourced:"));
  assert.equal(sendBackNotice([]), null);
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
  assert.deepEqual(readReplyJudge("clef", undefined), { model: "clef", at: null }, "each gate keeps its own threshold");
  assert.deepEqual(readReplyJudge("clef-flash", "0.7"), { model: "clef-flash", at: 0.7 });
  assert.equal(readReplyJudge("haiku", undefined), undefined, "only a decision model");
  assert.equal(readReplyJudge("clef", "2"), undefined);
  assert.equal(readReplyJudge(undefined, "0.5"), undefined, "a confidence with no judge");
  const setup = (extra) => `---\njob: texting-assistant\nmodels:\n  main: anthropic/claude-haiku-5-5\n${extra}---\n\nAnswer from their notes.\n`;
  assert.deepEqual((await parseSetup(setup("reply_judge: clef-flash\njudge_at: 0.6\n")))?.replyJudge, { model: "clef-flash", at: 0.6 });
  assert.equal((await parseSetup(setup("")))?.replyJudge, null);
  assert.equal(await parseSetup(setup("reply_judge: opus\n")), null);
});
