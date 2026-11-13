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

import { withoutTag } from "./promptFence.js";
import { adviseOnce, advisorRequest, advisorThinking } from "./advisorRoles/core.js";
import { ADVISOR_PROMPT } from "./advisorRoles/chat.js";

// Its instructions live in `advisorRoles/chat.js`, beside the other roles' (`advisorRoles/core.js`).
export { ADVISOR_PROMPT, advisorRequest, advisorThinking };

export const ADVISOR_TOOL = "ask_advisor";
export const MAX_ASKS = 10;

/**
 * How long one ask may take before the asker is told it timed out. Opus
 * reading a whole turn with thinking on took 20.0 s at the quickest quarter,
 * 23.9 s at the median and 38.3 s at the slowest of the 19 asks from 10-29 to
 * 11-12 (AI Gateway timings), so the 20 s every other call gets cut off about
 * three in four, and both of the Nov Babies jobs ran without it (2026-11-12).
 * A job is on nobody's clock: 90 s. A text keeps 40 s, and the turn's own end
 * (`turn.js`) still cuts it so the answer fits the texting Worker's two minutes.
 */
export const ADVISOR_TIMEOUT_MS = Object.freeze({ job: 90_000, chat: 40_000 });

/** The advisor's limit for a turn: a job's, or a text's. */
export const advisorTimeoutMs = (job) => (job ? ADVISOR_TIMEOUT_MS.job : ADVISOR_TIMEOUT_MS.chat);
/** The most of Tex's instructions the advisor reads (only when a turn hands no parts), and of the turn's transcript, newest kept. */
const MAX_SYSTEM_CHARS = 40_000;
/** The most of what is about this person and this job (`system.context`: about.md, goals, jobs, workspaces, a job's brief). */
const MAX_ABOUT_CHARS = 40_000;
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
const BRIEF_TAGS = ["tex_instructions", "about_them", "this_moment", "tex_tools", "transcript"];

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
    let answer;
    try {
      answer = await adviseOnce({ request, model, effort, prompt: ADVISOR_PROMPT, role: "advisor", brief: advisorBrief(live, transcript) });
    } catch {
      await meter(null, true, model, false);
      return text("Your advisor couldn't be reached. Answer with what you have.", true);
    }
    await meter(answer?.usage ?? null, false, model, false);
    const words = typeof answer?.text === "string" ? answer.text.trim() : "";
    const thought = advisorThinking(answer);
    const result = words ? text(words, false) : text("Your advisor had nothing to add. Answer with what you have.", false);
    return thought ? { ...result, thinking: thought } : result;
  };
  return [{ tool: ADVISOR_DEFINITION, call }];
}

/**
 * The whole turn, as one text the advisor reads: Tex's instructions, its
 * tools by name, then every message in order, tool calls and results
 * included. A long turn keeps its newest part.
 */
export function advisorBrief(live, transcript) {
  // A turn hands its parts (`builtin.js` `liveTurn`): who they are and this moment, never the texting rules, which
  // used up the whole 40,000 characters and cut the person off (the context review, 2026-11-06).
  if (typeof live?.about === "string") {
    const about = quoted(clip(live.about, MAX_ABOUT_CHARS));
    const now = quoted(clip(live.now, 4_000));
    return briefOf(
      (about ? `<about_them>\n${about}\n</about_them>\n\n` : "") + (now ? `<this_moment>\n${now}\n</this_moment>\n\n` : ""),
      live,
      transcript,
    );
  }
  const system = quoted(clip(live?.system, MAX_SYSTEM_CHARS));
  return briefOf(system ? `<tex_instructions>\n${system}\n</tex_instructions>\n\n` : "", live, transcript);
}

function briefOf(head, live, transcript) {
  const tools = (Array.isArray(live?.tools) ? live.tools : []).map((tool) => tool?.name).filter((name) => typeof name === "string" && name !== ADVISOR_TOOL);
  const lines = transcript.map(messageLine).filter(Boolean);
  let body = lines.join("\n\n");
  if (body.length > MAX_TRANSCRIPT_CHARS) body = `(earlier part of the turn left out)\n\n${body.slice(-MAX_TRANSCRIPT_CHARS)}`;
  return (
    head +
    (tools.length > 0 ? `<tex_tools>${tools.join(", ")}</tex_tools>\n\n` : "") +
    `<transcript>\n${body || "(nothing yet)"}\n</transcript>\n\nTex has paused here to ask your advice.`
  );
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
