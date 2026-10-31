/**
 * TEX ASKS ITS ADVISOR (the Tex Devs meeting, 2026-10-30,
 * `@supa projects/tex/new-architecture.md`).
 *
 * The new shape: a fast everyday model answers every text, and calls a
 * stronger model as an advisor when it is stuck, instead of a router sending
 * most whole turns to the stronger model up front. A setup turns it on with
 * `models.advisor` (`production.js`); without it nothing here is offered and
 * a turn runs exactly as before. Nothing switches over until the advisor
 * setup meets today's bar on the benchmark (`bench/ai/tests/advisor.md`).
 *
 * The advisor is a `send` action (`sixTools.js`), answered here and never by
 * the MCP. It reads what the everyday model reads (their earlier texts and
 * the question) plus the brief the everyday model writes (what it found,
 * what it tried, where it is stuck), and answers in words to the everyday
 * model, which still does the work and writes the text. It holds no tools,
 * so it can't act or reach anything the turn could not. It may decline an ask
 * the everyday model can handle, in one line, and the everyday model answers
 * itself.
 *
 * Its spend is metered under its own model (`route.js` `meter`), never
 * folded into the turn's. A turn may ask at most `MAX_ASKS` times (Dev2,
 * 2026-10-31: 10, and the everyday model is never told there is a limit).
 */

import { requestBuiltin } from "./builtin.js";

export const ADVISOR_TOOL = "ask_advisor";
export const MAX_ASKS = 10;
const MAX_BRIEF_CHARS = 6_000;
const MAX_QUESTION_CHARS = 2_000;

export const ADVISOR_DEFINITION = {
  name: ADVISOR_TOOL,
  description:
    "Ask your advisor, a stronger model, when an ask needs judgment: weighing their goals or a trade-off, a plan with several steps, " +
    "something that goes wrong if answered carelessly, or after a step failed and you are stuck. Not for a lookup, a simple write or a greeting. " +
    "Write the brief: what you found, what you tried, and where you are stuck. It answers you, never them; you still do the work and write the text. " +
    "If it declines, answer yourself.",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string", description: "What you need the advisor to decide or work out." },
      brief: { type: "string", description: "What you found and tried so far, with the facts it needs." },
    },
    required: ["question"],
  },
};

export const ADVISOR_PROMPT =
  "You are the advisor to Tex, a texting assistant. Tex's everyday model is asking you for help with the conversation below; " +
  "you answer Tex, never the person, and you can't call tools: Tex does the work and writes the text.\n\n" +
  "If the ask is one Tex can handle from what it has (a lookup, a simple write, a greeting, a plain yes or no), reply with one line " +
  'that starts with "Decline:" and says what to do.\n\n' +
  "Otherwise think it through and reply with what Tex should do and say: the decision and why, the steps in order, the facts to check, " +
  "and the mistake to avoid. Be specific and short. Never invent a fact that isn't in the conversation or the brief; say what Tex must look up instead.";

const clip = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");

/**
 * The advisor as a local tool for one turn, or none when the setup names no
 * advisor or this deployment can't run it.
 *
 * @param {object} options
 * @param {string|null} options.model the setup's `models.advisor`
 * @param {string|undefined} [options.effort] how hard it thinks (`efforts[model]`)
 * @param {Array<{role: string, text: string}>} options.history the earlier texts the turn shows
 * @param {string} options.question the person's text
 * @param {Function} options.request `(params) => answer`, `requestBuiltin` bound to the turn's provider
 * @param {Function} [options.meter] `(usage, failed, model, whole)`, `route.js`'s
 * @returns {Array<{tool: object, call: Function}>}
 */
export function advisorTools({ model, effort, history, question, request, meter = async () => {} }) {
  if (typeof model !== "string" || typeof request !== "function") return [];
  let asks = 0;
  const call = async (args) => {
    if (asks >= MAX_ASKS) return text("Your advisor isn't available for the rest of this turn. Answer with what you have.", true);
    const ask = clip(args?.question, MAX_QUESTION_CHARS);
    if (!ask) return text("Say what you need the advisor to decide.", true);
    asks += 1;
    const brief = clip(args?.brief, MAX_BRIEF_CHARS);
    const messages = [
      ...history.map(({ role, text: said }) => ({ role, text: said })),
      { role: "user", text: question },
      { role: "user", text: `Tex asks you: ${ask}${brief ? `\n\nWhat Tex found and tried:\n${brief}` : ""}` },
    ];
    let answer;
    try {
      answer = await request({ model, system: ADVISOR_PROMPT, messages: joined(messages), tools: [], ...(effort ? { effort } : {}) });
    } catch {
      await meter(null, true, model, false);
      return text("Your advisor couldn't be reached. Answer with what you have.", true);
    }
    await meter(answer?.usage ?? null, false, model, false);
    const words = typeof answer?.text === "string" ? answer.text.trim() : "";
    return words ? text(words, false) : text("Your advisor had nothing to add. Answer with what you have.", false);
  };
  return [{ tool: ADVISOR_DEFINITION, call }];
}

/** A provider takes turns that alternate: consecutive texts from one side become one. */
function joined(messages) {
  const out = [];
  for (const message of messages) {
    const last = out.at(-1);
    if (last && last.role === message.role) last.text = `${last.text}\n\n${message.text}`;
    else out.push({ ...message });
  }
  if (out[0]?.role !== "user") out.unshift({ role: "user", text: "(earlier texts follow)" });
  return out;
}

const text = (words, isError) => ({ content: [{ type: "text", text: words }], ...(isError ? { isError: true } : {}) });

/** `requestBuiltin` bound to a turn's provider options, for `advisorTools`. */
export function advisorRequest(providerOptions) {
  return (params) => requestBuiltin(params, providerOptions.ai, providerOptions);
}
