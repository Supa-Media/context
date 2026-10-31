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
 * Modelled on Anthropic's advisor tool (Dev2, 2026-10-31: "use ours, but
 * model it on the architecture they have";
 * https://claude.com/blog/the-advisor-strategy). The everyday model calls it
 * with no input, and the advisor is handed the whole turn so far itself:
 * Tex's instructions, the tools it was given, the conversation, and every
 * tool call and result this turn (`turn.js` passes them at call time), the
 * everyday model's words before the call included. It runs under its own
 * instructions, holds no tools, so it can't act or reach anything the turn
 * could not, and only its advice goes back. Before, it saw the texts plus a
 * brief the everyday model wrote, never what the tools had returned, the
 * same blind spot that let a job's report pass unread (2026-10-31). It may
 * decline an ask the everyday model can handle, in one line, and the
 * everyday model answers itself.
 *
 * Its spend is metered under its own model (`route.js` `meter`), never
 * folded into the turn's. A turn may ask at most `MAX_ASKS` times (Dev2,
 * 2026-10-31: 10, and the everyday model is never told there is a limit).
 */

import { requestBuiltin } from "./builtin.js";

export const ADVISOR_TOOL = "ask_advisor";
export const MAX_ASKS = 10;
/** The most of Tex's instructions the advisor reads, and of the turn's transcript, newest kept. */
const MAX_SYSTEM_CHARS = 40_000;
const MAX_TRANSCRIPT_CHARS = 160_000;
/** The most of one tool result shown to it: a page read can be long. */
const MAX_RESULT_CHARS = 12_000;

export const ADVISOR_DEFINITION = {
  name: ADVISOR_TOOL,
  description:
    "Ask your advisor, a stronger model, when an ask needs judgment: weighing their goals or a trade-off, a plan with several steps, " +
    "something that goes wrong if answered carelessly, before you call a task done, or after a step failed and you are stuck. Not for a lookup, a simple write or a greeting. " +
    "It sees everything in this turn so far (your instructions, the conversation, every tool call and result), so call it with no input. " +
    "It answers you, never them; you still do the work and write the text. If it declines, answer yourself.",
  inputSchema: { type: "object", properties: {} },
};

export const ADVISOR_PROMPT =
  "You are the advisor to Tex, a texting assistant. Below is everything Tex's everyday model has in this turn: its instructions, the tools " +
  "it was given, the conversation, and every tool call and result so far. It has paused to ask you for advice. You answer Tex, never the person, " +
  "and you can't call tools: Tex does the work and writes the text.\n\n" +
  "If Tex can handle this from what it has (a lookup, a simple write, a greeting, a plain yes or no), reply with one line " +
  'that starts with "Decline:" and says what to do.\n\n' +
  "Otherwise think it through and reply with what Tex should do and say: the decision and why, the steps in order, the facts to check, " +
  "and the mistake to avoid. Check whether what was asked is actually done: a tool result that failed, a step not taken, or words that " +
  "promise work nobody will do are what to catch. Be specific and short, a few hundred words at most. Never invent a fact that isn't in the transcript; " +
  "say what Tex must look up instead.";

const clip = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");

/**
 * The advisor as a local tool for one turn, or none when the setup names no
 * advisor or this deployment can't run it.
 *
 * @param {object} options
 * @param {string|null} options.model the setup's `models.advisor`
 * @param {string|undefined} [options.effort] how hard it thinks (`efforts[model]`)
 * @param {Array<{role: string, text: string}>} options.history the earlier texts the turn shows, read only when no live turn is passed
 * @param {string} options.question the person's text, likewise
 * @param {Function} options.request `(params) => answer`, `requestBuiltin` bound to the turn's provider
 * @param {Function} [options.meter] `(usage, failed, model, whole)`, `route.js`'s
 * @returns {Array<{tool: object, call: Function}>}
 */
export function advisorTools({ model, effort, history, question, request, meter = async () => {} }) {
  if (typeof model !== "string" || typeof request !== "function") return [];
  let asks = 0;
  /** `live`: the turn as it stands (`turn.js`): its system prompt, its tools and its messages so far. */
  const call = async (_args, live = null) => {
    if (asks >= MAX_ASKS) return text("Your advisor isn't available for the rest of this turn. Answer with what you have.", true);
    asks += 1;
    const transcript = Array.isArray(live?.messages) ? live.messages : [...history, { role: "user", text: question }];
    let answer;
    try {
      answer = await request({ model, system: ADVISOR_PROMPT, messages: [{ role: "user", text: advisorBrief(live, transcript) }], tools: [], ...(effort ? { effort } : {}) });
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

/**
 * The whole turn, as one text the advisor reads: Tex's instructions, its
 * tools by name, then every message in order, tool calls and results
 * included. A long turn keeps its newest part.
 */
export function advisorBrief(live, transcript) {
  const system = clip(live?.system, MAX_SYSTEM_CHARS);
  const tools = (Array.isArray(live?.tools) ? live.tools : []).map((tool) => tool?.name).filter((name) => typeof name === "string" && name !== ADVISOR_TOOL);
  const lines = transcript.map(messageLine).filter(Boolean);
  let body = lines.join("\n\n");
  if (body.length > MAX_TRANSCRIPT_CHARS) body = `(earlier part of the turn left out)\n\n${body.slice(-MAX_TRANSCRIPT_CHARS)}`;
  return (
    (system ? `<tex_instructions>\n${system}\n</tex_instructions>\n\n` : "") +
    (tools.length > 0 ? `<tex_tools>${tools.join(", ")}</tex_tools>\n\n` : "") +
    `<transcript>\n${body || "(nothing yet)"}\n</transcript>\n\nTex has paused here to ask your advice.`
  );
}

function messageLine(message) {
  if (!message || typeof message !== "object") return "";
  const said = typeof message.text === "string" ? message.text.trim() : "";
  if (message.role === "tool") {
    const result = said.length > MAX_RESULT_CHARS ? `${said.slice(0, MAX_RESULT_CHARS)}\n[cut]` : said;
    return `[result of ${message.name ?? "a tool"}${message.isError ? ", failed" : ""}]\n${result || "(no result)"}${Array.isArray(message.images) && message.images.length > 0 ? "\n(with a picture)" : ""}`;
  }
  const calls = Array.isArray(message.toolCalls) && message.toolCalls.length > 0
    ? message.toolCalls.map((made) => `[Tex calls ${made?.name ?? "a tool"} ${JSON.stringify(made?.args ?? {}).slice(0, 2_000)}]`).join("\n")
    : "";
  const who = message.role === "assistant" ? "Tex" : "Them";
  return [said ? `${who}: ${said}` : "", calls].filter(Boolean).join("\n");
}

const text = (words, isError) => ({ content: [{ type: "text", text: words }], ...(isError ? { isError: true } : {}) });

/** `requestBuiltin` bound to a turn's provider options, for `advisorTools`. */
export function advisorRequest(providerOptions) {
  return (params) => requestBuiltin(params, providerOptions.ai, providerOptions);
}
