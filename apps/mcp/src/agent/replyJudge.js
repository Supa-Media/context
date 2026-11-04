/**
 * THE REPLY JUDGE: A DECISION MODEL BETWEEN TEX AND THE PERSON (Dev2,
 * 2026-11-04, after a customer's group chat where Tex said someone else would
 * know where a logo was, then thanked the customer for naming the folder and
 * did nothing: "a small judge that sits between the interaction agent and the
 * user that just makes sure that no bs gets through").
 *
 * Before a texted reply goes, Clef (`decide.js`) reads what the person asked,
 * the last few texts, every action the turn took (each call with its
 * arguments and what came back) and the reply itself, and picks one verdict.
 * Anything but `accepted` goes back to the model once, with the verdict's
 * reason, and the model writes the reply again before anything is sent. The
 * second reply is sent as it is: one retry, never a loop (Dev2's pick, the
 * same day).
 *
 * Why a decision model and not a pattern over the words: the owner rejected
 * phrase-pattern checks on reply quality the same day ("pattern is not the
 * right fix"). Clef reads meaning, answers in a fixed set of verdicts (typed
 * by construction, nothing to parse), and is fast enough to sit in front of
 * every reply. A verdict below the setup's confidence (`judge_at`) is not
 * acted on, and a judge that fails or times out is no verdict: the reply goes.
 *
 * Turned on per setup with `reply_judge: clef` or `reply_judge: clef-flash`
 * (`production.js`), so the benchmark measures it against production before
 * it goes live.
 */

import { decisionEngine, decisionTokens } from "./decide.js";

/** The decision models a setup may name, by the word it uses. */
export const JUDGE_MODELS = {
  clef: { model: "@cf/cloudflare/clef", selector: "clef" },
  "clef-flash": { model: "@cf/cloudflare/clef-flash", selector: "clef-flash" },
};

/** Below this confidence a verdict other than `accepted` is not acted on, unless the setup says otherwise. */
export const DEFAULT_JUDGE_AT = 0.5;

/** The judge never holds a reply longer than this; past it, the reply goes. */
export const JUDGE_TIMEOUT_MS = 3_000;

/** The most the judge reads, in characters; the reply and the ask come first, so nothing that matters is cut. */
const MAX_STATE_CHARS = 16_000;

/** What each verdict means, as Clef is shown it. `accepted` first: it is the common case. */
export const VERDICTS = {
  accepted:
    "The reply does what they asked, or truly needs something only they can give (a sign-in code, a payment, a choice that is theirs, a fact only they know), and says it plainly in a few lines.",
  not_started:
    "They asked for something to be done or found, and the actions show it was not attempted, or barely: one search and then 'couldn't find it', no other place looked (email, the chat, the web, a site or folder named).",
  not_finished:
    "The work started but stopped short of what they asked, with steps left the assistant could take itself (open the page, follow the folder, read the file, finish the form), and it neither took them nor handed them to a background job.",
  offered_instead:
    "The reply offers or asks permission to do something the assistant could just do itself and that reaches nobody else ('want me to look?', 'should I check?', 'I can search for it if you like').",
  only_acknowledged:
    "They gave something the earlier ask needed (where a file is, which site, a name, an answer to the assistant's question), and the reply only thanks or acknowledges it instead of acting on it.",
  sent_elsewhere:
    "The reply tells them someone else would know, or tells them to find, open, download or do the thing themselves, when the assistant could do it.",
  unbacked_claim:
    "The reply says something was found, opened, saved, sent, booked or done, but the actions do not show it (no such call, or the call failed).",
  wrong_question:
    "The reply answers a different question than the one they asked, or misses part of what they asked.",
  too_verbose:
    "The reply does the job but is far longer than a text should be: it retells what they already know, lists options nobody asked for, or explains the steps it took.",
};

/** What the model is told for each verdict, before it writes the reply again. */
export const VERDICT_NOTICES = {
  not_started:
    "A check read your reply against what you did this turn and found the ask not done: you stopped before really trying. Do it now: look in the other places it would be (their email, this chat's earlier texts, the web, a site or folder they named), or hand it to a background job with everything you know. Then reply with what you found.",
  not_finished:
    "A check found steps left that you can take yourself. Take them now (open the page, follow the folder, read the file, finish it), or hand the rest to a background job with everything you've found, and reply with the result.",
  offered_instead:
    "A check found your reply offers to do something you can just do, and it reaches nobody else. Do it now and reply with the result, not a question about it.",
  only_acknowledged:
    "A check found they gave you what the earlier ask needed, and your reply only acknowledged it. The ask continues: act on what they told you now, keep it in the note it belongs in, and reply with the result.",
  sent_elsewhere:
    "A check found your reply sends them to someone else or tells them to do it themselves. Do it yourself first: look, open, fetch. Hand back only what truly needs them (a sign-in code, a payment, a choice that's theirs).",
  unbacked_claim:
    "A check found your reply says something was done or found that your actions this turn don't show. Do it now if you can, or say exactly what you did and didn't do.",
  wrong_question:
    "A check found your reply doesn't answer what they asked, or misses part of it. Read their text again and answer that, all of it.",
  too_verbose:
    "A check found your reply too long for a text. Say the same thing in a sentence or two: the answer or result first, nothing they already know, no list of steps.",
};

const QUESTIONS = {
  verdict: {
    type: "choice",
    instructions:
      "A person texted their assistant, which can search their notes and email, browse the web, open sites with saved logins, write notes and start background jobs. " +
      "Below are their text, what the assistant did this turn, and the reply it is about to send. " +
      "Judge only the reply against what they asked and what was done. Pick accepted unless one of the other verdicts clearly applies.",
    criteria: VERDICTS,
  },
};

/** One line per action the turn took: each call with its arguments, then what came back, both cut short. */
export function actionsOf(messages) {
  const lines = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role === "assistant" && Array.isArray(message.toolCalls)) {
      for (const call of message.toolCalls) lines.push(`- called ${String(call?.name ?? "?")} ${clip(argsText(call?.args), 300)}`);
    } else if (message?.role === "tool") {
      lines.push(`  ${message.isError === true ? "failed" : "returned"}: ${clip(String(message.text ?? ""), 400)}`);
    }
  }
  return lines;
}

/** What Clef reads: the ask and the reply first, then every action, then the earlier texts. */
export function judgeState({ question, history = [], messages = [], answer }) {
  const actions = actionsOf(messages);
  const earlier = (Array.isArray(history) ? history : [])
    .slice(-6)
    .map((turn) => `${turn?.role === "assistant" ? "Assistant" : "Person"}: ${clip(String(turn?.text ?? ""), 600)}`);
  return [
    `Their text now: ${clip(String(question ?? ""), 3_000)}`,
    "",
    `The reply about to be sent: ${clip(String(answer ?? ""), 3_000)}`,
    "",
    `What the assistant did this turn (${actions.length === 0 ? "nothing: no searches, reads or other actions" : `${actions.filter((line) => line.startsWith("- ")).length} actions`}):`,
    ...actions,
    "",
    "Earlier texts in this chat, oldest first:",
    ...(earlier.length === 0 ? ["(none)"] : earlier),
  ]
    .join("\n")
    .slice(0, MAX_STATE_CHARS);
}

/**
 * `{ check, verdicts }` for `runTurn`'s `answerCheck`, around the turn's other
 * check (`doItChecks.js`, `claimCheck.js` or `untriedWeb.js`), which runs first.
 * `check(answer, { messages })` judges once a turn; `verdicts` keeps what each
 * judging decided, for the turn's log and the benchmark.
 */
export function replyJudge({ ai, setting, question, history = [], inner = null, clock = Date.now, log = console.log }) {
  const pick = JUDGE_MODELS[setting?.model];
  const decide = pick ? decisionEngine(ai, pick) : null;
  const at = typeof setting?.at === "number" ? setting.at : DEFAULT_JUDGE_AT;
  const verdicts = [];
  let judged = false;
  return {
    verdicts,
    async check(answer, turn = {}) {
      const before = typeof inner?.check === "function" ? await inner.check(answer, turn) : null;
      if (before !== null && before !== undefined) return before;
      if (judged || decide === null) return null;
      judged = true;
      const state = judgeState({ question, history, messages: turn.messages, answer });
      const started = clock();
      const answers = await withTimeout(decide(state, QUESTIONS), JUDGE_TIMEOUT_MS);
      const ms = clock() - started;
      const verdict = typeof answers?.verdict?.choice === "string" && answers.verdict.choice in VERDICTS ? answers.verdict.choice : null;
      const confidence = typeof answers?.verdict?.confidence === "number" ? answers.verdict.confidence : null;
      const acted = verdict !== null && verdict !== "accepted" && (confidence === null || confidence >= at);
      verdicts.push({ verdict, confidence, ms, acted, tokens: decisionTokens(state, QUESTIONS) });
      turn.mark?.({ verdict, confidence, ms, acted, ok: verdict !== null });
      // Ids and numbers only: never the reply or the question (`docs/decisions/observability`).
      log(JSON.stringify({ event: "tex_reply_judge", model: pick.model, verdict, confidence, ms, acted }));
      return acted ? VERDICT_NOTICES[verdict] : null;
    },
  };
}

/** `reply_judge:` in a setup: absent is off; `clef` or `clef-flash` names the judge; anything else refuses the setup (`undefined`). */
export function readReplyJudge(value, at) {
  if (value === undefined || value === "off" || value === false) return at === undefined ? null : undefined;
  if (typeof value !== "string" || !(value in JUDGE_MODELS)) return undefined;
  if (at === undefined) return { model: value, at: DEFAULT_JUDGE_AT };
  if (typeof at !== "string" || !/^(?:0(?:\.\d{1,2})?|1(?:\.0{1,2})?)$/.test(at)) return undefined;
  return { model: value, at: Number(at) };
}

function argsText(args) {
  try {
    return typeof args === "string" ? args : JSON.stringify(args ?? {});
  } catch {
    return "";
  }
}

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).catch(() => null),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
