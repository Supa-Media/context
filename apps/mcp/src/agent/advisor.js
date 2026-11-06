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
 * Its spend is metered under its own model (`texEntryPoint.js` `meter`), never
 * folded into the turn's. A turn may ask at most `MAX_ASKS` times (Dev2,
 * 2026-10-31: 10, and the everyday model is never told there is a limit).
 */

import { requestBuiltin } from "./builtin.js";
import { withoutTag } from "./promptFence.js";

export const ADVISOR_TOOL = "ask_advisor";
export const MAX_ASKS = 10;
/**
 * The most of Tex's instructions the advisor reads, and of the transcript: the
 * earlier texts and this turn have a budget each, so this turn growing never
 * moves the cached part (`advisorBrief`). Each keeps its newest messages whole.
 */
const MAX_SYSTEM_CHARS = 40_000;
const MAX_HISTORY_CHARS = 100_000;
const MAX_TURN_CHARS = 60_000;
/** The most of one tool result shown to it: a page read can be long. */
const MAX_RESULT_CHARS = 12_000;

export const ADVISOR_DEFINITION = {
  name: ADVISOR_TOOL,
  description:
    "Ask your advisor, a stronger model, when an ask needs judgment: weighing their goals or a trade-off, a plan with several steps, " +
    "something that goes wrong if answered carelessly, before you call a task done, or after a step failed and you are stuck. Not for a lookup, a simple write or a greeting. " +
    "On an ask like that, look around first (read the notes, search), then ask before you commit to an approach, and again before you say it is done. " +
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

/**
 * A job's turn runs on the everyday model from its first round (Dev2, 2026-11-05: "for the Tex minions knock them down to
 * Haiku, and also make sure that they have access to the advisor, whenever they need it"). Opus planning every job's first
 * rounds, and taking back every round after a failed call, was most of Tex's Opus spend. So the job is told where the
 * judgment now comes from: the advisor, asked when the job needs it. Never the limit on asks.
 */
export const JOB_ADVISOR_LINE =
  "\n\nYou run this job on a fast model. Your advisor (send with action advisor) is a stronger model that sees the whole job so far: " +
  "ask it before your first step when the job has several steps or needs judgment, when a step fails and the next way isn't clear, " +
  "and before you report the job finished.";

/** The line for a job's turn when its advisor is offered, else "". */
export function jobAdvisorLine(job, offered) {
  return job !== null && job !== undefined && offered === true ? JOB_ADVISOR_LINE : "";
}

const clip = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");

/** The tags the brief quotes in (`advisorBrief`); a quoted word that is one of them would end the quote. */
const BRIEF_TAGS = ["tex_instructions", "tex_tools", "transcript"];

/** Content the brief quotes, with its own tags neutralized (`promptFence.js`): a page's words never become the brief's. */
const quoted = (value) => BRIEF_TAGS.reduce((text, tag) => withoutTag(tag, text), String(value ?? ""));

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
 * @param {Function} [options.meter] `(usage, failed, model, whole)`, `texEntryPoint.js`'s
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
    const earlier = Number.isInteger(live?.cachedThrough) ? live.cachedThrough : Array.isArray(live?.messages) ? 0 : history.length;
    let answer;
    try {
      // `display: "summarized"`: its thinking comes back in words, kept with its answer in the chat's
      // history (Dev, 2026-11-02: "'Its private reasoning isn't kept.' - why?"). It never goes to Tex.
      // Two parts, the stable one cached (`aiGateway.js` `cachedThrough`): a second ask, or the next text's, reads it back.
      const [stable, fresh] = advisorBrief(live, transcript, earlier);
      answer = await request({ model, system: ADVISOR_PROMPT, messages: [{ role: "user", text: stable }, { role: "user", text: fresh }], cachedThrough: 1, tools: [], display: "summarized", ...(effort ? { effort } : {}) });
    } catch {
      await meter(null, true, model, false);
      return text("Your advisor couldn't be reached. Answer with what you have.", true);
    }
    await meter(answer?.usage ?? null, false, model, false);
    const words = typeof answer?.text === "string" ? answer.text.trim() : "";
    const thought = advisorThinking(answer);
    // `declined`: kept in the turn's trace, so the bench counts how often it declined (`bench/advisorBench.mjs`).
    const result = words ? { ...text(words, false), ...(/^Decline:/i.test(words) ? { declined: true } : {}) } : text("Your advisor had nothing to add. Answer with what you have.", false);
    return thought ? { ...result, thinking: thought } : result;
  };
  return [{ tool: ADVISOR_DEFINITION, call }];
}

/** The advisor's thinking in words (`aiGateway.js` hands back the answer's blocks when it thought), or "". */
export function advisorThinking(answer) {
  const blocks = Array.isArray(answer?.content) ? answer.content : [];
  return blocks
    .filter((block) => block?.type === "thinking" && typeof block.thinking === "string")
    .map((block) => block.thinking.trim())
    .filter(Boolean)
    .join("\n\n");
}

/**
 * The whole turn as the advisor reads it, in two parts. The stable part is
 * the same on every ask of the turn and, the earlier texts unchanged, of the
 * next: Tex's instructions, its tools by name and the earlier texts. The
 * fresh part is this turn: its per-turn facts (`preamble`), then every message
 * from the person's text on, tool calls and results included. Each part drops
 * its oldest whole messages past its budget, so the stable one never shifts
 * while this turn grows.
 */
export function advisorBrief(live, transcript, earlier = 0) {
  const system = quoted(clip(live?.system, MAX_SYSTEM_CHARS));
  const preamble = quoted(clip(live?.preamble, MAX_SYSTEM_CHARS));
  const tools = (Array.isArray(live?.tools) ? live.tools : []).map((tool) => tool?.name).filter((name) => typeof name === "string" && name !== ADVISOR_TOOL);
  const before = newest(transcript.slice(0, earlier).map(messageLine).filter(Boolean), MAX_HISTORY_CHARS, "(earlier texts left out)");
  const now = newest(transcript.slice(earlier).map(messageLine).filter(Boolean), MAX_TURN_CHARS, "(earlier part of the turn left out)");
  const stable =
    (system ? `<tex_instructions>\n${system}\n</tex_instructions>\n\n` : "") +
    (tools.length > 0 ? `<tex_tools>${tools.join(", ")}</tex_tools>\n\n` : "") +
    `<transcript>\n${before || "(no earlier texts)"}`;
  const fresh = `${preamble ? `(this turn's facts) ${preamble}\n\n` : ""}${now || "(nothing yet)"}\n</transcript>\n\nTex has paused here to ask your advice.`;
  return [stable, fresh];
}

/** The newest whole lines that fit in `max` characters, oldest first, with `gap` said when any were left out. */
function newest(lines, max, gap) {
  const kept = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].length > max ? lines[i].slice(-max) : lines[i];
    if (size + line.length > max) break;
    kept.unshift(line);
    size += line.length + 2;
  }
  return [...(kept.length < lines.length ? [gap] : []), ...kept].join("\n\n");
}

function messageLine(message) {
  if (!message || typeof message !== "object") return "";
  const said = typeof message.text === "string" ? message.text.trim() : "";
  if (message.role === "tool") {
    const cut = said.length > MAX_RESULT_CHARS ? `${said.slice(0, MAX_RESULT_CHARS)}\n[cut]` : said;
    const result = quoted(cut);
    return `[result of ${message.name ?? "a tool"}${message.isError ? ", failed" : ""}]\n${result || "(no result)"}${Array.isArray(message.images) && message.images.length > 0 ? "\n(with a picture)" : ""}`;
  }
  const calls = Array.isArray(message.toolCalls) && message.toolCalls.length > 0
    ? message.toolCalls.map((made) => `[Tex calls ${made?.name ?? "a tool"} ${quoted(JSON.stringify(made?.args ?? {}).slice(0, 2_000))}]`).join("\n")
    : "";
  const who = message.role === "assistant" ? "Tex" : "Them";
  return [said ? `${who}: ${quoted(said)}` : "", calls].filter(Boolean).join("\n");
}

const text = (words, isError) => ({ content: [{ type: "text", text: words }], ...(isError ? { isError: true } : {}) });

/** `requestBuiltin` bound to a turn's provider options, for `advisorTools`. */
export function advisorRequest(providerOptions) {
  return (params) => requestBuiltin(params, providerOptions.ai, providerOptions);
}
