import assert from "node:assert/strict";
import { BUILTIN_PROVIDER } from "../../../../../packages/tex/gateway/agent/builtin.js";
import { REVIEW_MODEL, REVIEW_SYSTEM, replyJudge } from "../../../../../packages/tex/gateway/agent/replyJudge.js";
import { SAID_NOTHING } from "../../../../../packages/tex/gateway/agent/sayNothing.js";
import { runTurn } from "../../../../../packages/tex/gateway/agent/turn.js";

// Invented names and figures throughout. The reviewer is a scripted model that answers each review in turn.
const MODEL = "@cf/acme/main-model";
const SEARCH = { name: "search_notes", description: "Search notes", inputSchema: { type: "object", properties: { query: { type: "string" } } }, annotations: { readOnlyHint: true } };
const FOLLOW_UP = "Harbor Post closes in 2 days, and they still haven't answered you. Want me to draft a reply?";
const PRICE = "Lumen is $28 now, up from $22. I couldn't check Monday's calendar.";

function reviewer(verdicts) {
  const asked = [];
  return {
    asked,
    async request(call) {
      asked.push(call);
      const next = verdicts.shift();
      if (next === undefined) throw new Error("replay: the reviewer script ran out");
      return { text: JSON.stringify(next) };
    },
  };
}

function scripted(replies) {
  return {
    async run() {
      const next = replies.shift();
      if (!next) throw new Error("replay: the scripted model ran out");
      return next;
    },
  };
}

const chat = (text, toolCalls = []) => ({
  choices: [{ message: { content: text, tool_calls: toolCalls.map(([name, args], i) => ({ id: `call_${i}`, type: "function", function: { name, arguments: JSON.stringify(args) } })) } }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
});
const browsing = (n) => Array.from({ length: n }, () => chat("", [["search_notes", { query: "harbor post" }]]));
const ACTED = [
  { role: "assistant", text: "", toolCalls: [{ name: "search_notes", args: { query: "harbor post" } }] },
  { role: "tool", name: "search_notes", text: "Harbor Post: closes in 2 days. No reply from them.", isError: false },
];

export default {
  id: "scheduled-follow-up-texted",
  incident:
    "2026-11-18: a routine's follow-up (Harbor Post closes in 2 days, never answered) and a weekly tidy closing out stale asks were dropped by the reply reviewer as repeats of an earlier text; and a check-in's last-step draft (a price change, 22 to 28) went silent because the reviewer sent back a hands_back fault on its last step.",
  cause:
    "The reviewer's rule for a scheduled run read any text that repeats an earlier text as not for them, so new news that names an old thing was silenced. And a scheduled run's last step treated every send-back as a reason for silence, not only the ones that say the text should not go at all.",
  path: "1:1 routine",
  async run() {
    // The rule the reviewer reads: follow-ups, last calls and close-outs are new news; only a text that adds nothing is dropped.
    assert.doesNotMatch(REVIEW_SYSTEM, /repeats what an earlier text already told them/);
    assert.match(REVIEW_SYSTEM, /follow-up or reminder that someone \(the person or Tex\) set up/);

    // A follow-up the reviewer passes goes in one round, and the review is told the routine ran unprompted.
    const follow = reviewer([{ kind: "scheduled", verdict: "ok", problems: [], feedback: "" }]);
    const judge = replyJudge({ setting: { model: REVIEW_MODEL }, question: "This is a scheduled routine, not a text from a person.", history: [], request: follow.request, log: () => {}, scheduled: "routine" });
    assert.equal(await judge.check(FOLLOW_UP, { messages: ACTED }), null, "the follow-up goes");
    assert.match(JSON.stringify(follow.asked[0].system), /follow-up or reminder that someone/, "the reviewer is given the new-news rule");

    // The last step of a scheduled run: the reviewer sends back a hands_back fault. The price change still goes.
    const hands = reviewer([{ kind: "scheduled", verdict: "send_back", problems: ["hands_back"], feedback: "Quote: \"I couldn't check Monday's calendar\". Tex can look that up itself." }]);
    const priceJudge = replyJudge({ setting: { model: REVIEW_MODEL }, question: "This is a scheduled routine, not a text from a person.", history: [], request: hands.request, log: () => {}, scheduled: "routine" });
    const priceAi = scripted([...browsing(3), chat(PRICE)]);
    const sentPrice = await runTurn({
      question: "This is a scheduled routine, not a text from a person.",
      credential: { provider: BUILTIN_PROVIDER, apiKey: null },
      tools: [SEARCH],
      callTool: async () => ({ content: [{ type: "text", text: "Lumen: $28 now." }] }),
      env: { AI: priceAi, AGENT_BUILTIN_MODEL: MODEL },
      providerOptions: { ai: priceAi },
      maxRounds: 4,
      sayNothing: true,
      scheduled: true,
      answerCheck: priceJudge.check,
      silences: priceJudge.silences,
    });
    assert.equal(sentPrice.answer, PRICE, "a last-step draft sent back for hands_back still goes");

    // A send-back that says the text is not for them is still silence on the last step.
    const own = reviewer([{ kind: "scheduled", verdict: "send_back", problems: ["not_for_them"], feedback: "Quote: \"this routine's output\". This explains Tex's own run. Call send with action say_nothing." }]);
    const ownJudge = replyJudge({ setting: { model: REVIEW_MODEL }, question: "This is a scheduled routine, not a text from a person.", history: [], request: own.request, log: () => {}, scheduled: "routine" });
    const ownAi = scripted([...browsing(3), chat("This routine's output would go to them, so I'm not texting it.")]);
    const quiet = await runTurn({
      question: "This is a scheduled routine, not a text from a person.",
      credential: { provider: BUILTIN_PROVIDER, apiKey: null },
      tools: [SEARCH],
      callTool: async () => ({ content: [{ type: "text", text: "Lumen: $28 now." }] }),
      env: { AI: ownAi, AGENT_BUILTIN_MODEL: MODEL },
      providerOptions: { ai: ownAi },
      maxRounds: 4,
      sayNothing: true,
      scheduled: true,
      answerCheck: ownJudge.check,
      silences: ownJudge.silences,
    });
    assert.equal(quiet.answer, SAID_NOTHING, "explaining its own run is never texted");
  },
};
