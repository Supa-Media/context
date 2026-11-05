/**
 * THE REPLY JUDGES: CLEF FLASH BETWEEN TEX AND THE PERSON (Dev2, 2026-11-04,
 * "a small judge that sits between the interaction agent and the user that
 * just makes sure that no bs gets through"; made ten parallel gates,
 * 2026-11-05: "a series of parallel judges, fine tuned individually ... [when]
 * they don't [pass] it's given back to the model and they are told which gates
 * don't pass", and "the judges can only send back 2 times").
 *
 * Before a reply goes, every gate (`replyGates.js`) reads the same packet:
 * what the person asked, the last few texts, every action the turn took (each
 * call with its arguments and what came back) and the reply. Each gate is its
 * own Clef Flash call with one yes/no question, and they all run at once, so
 * the wait is the slowest gate, not the sum. A gate whose yes reaches its
 * threshold fails. Every failed gate goes back to the model in one notice that
 * names it and says what it needs (`sendBackNotice`); the model writes the
 * reply again and every gate reads it again, since a rewrite can bring in a
 * fault the first draft did not have (review, 2026-11-05). At most
 * `MAX_SEND_BACKS` send-backs a turn: after that the reply goes as it is, so
 * a judge can never hold a turn in a loop.
 *
 * A gate that errors or runs past `JUDGE_TIMEOUT_MS` is no verdict, and the
 * reply is not held for it.
 *
 * Turned on per setup with `reply_judge: clef-flash` (or `clef`), read by
 * `production.js`; `judge_at` sets one threshold for every gate in place of
 * each gate's own.
 */

import { decisionEngine, decisionTokens } from "./decide.js";
import { isControlWord } from "./jobReport.js";
import { DEFAULT_GATE_AT, GATES, gateFact, gateQuestion, gateReads, gatesFor, sendBackNotice } from "./replyGates.js";

/** The decision models a setup may name, by the word it uses. */
export const JUDGE_MODELS = {
  clef: { model: "@cf/cloudflare/clef", selector: "clef" },
  "clef-flash": { model: "@cf/cloudflare/clef-flash", selector: "clef-flash" },
};

/** Every gate's threshold when the setup names none and the gate has no tuned one. */
export const DEFAULT_JUDGE_AT = DEFAULT_GATE_AT;

/** No gate holds a reply longer than this; past it, that gate is no verdict. */
export const JUDGE_TIMEOUT_MS = 3_000;

/** The most times the gates send one turn's reply back (Dev2, 2026-11-05: "only send back 2 times"). */
export const MAX_SEND_BACKS = 2;

/** The most the judges read, in characters; the reply and the ask come first, so nothing that matters is cut. */
const MAX_STATE_CHARS = 16_000;

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

/** What Clef reads: the ask and the reply first, then a job's report when the turn is one, every action, then the earlier texts. */
export function judgeState({ question, history = [], messages = [], answer, report = null }) {
  const actions = actionsOf(messages);
  const earlier = (Array.isArray(history) ? history : [])
    .slice(-6)
    .map((turn) => `${turn?.role === "assistant" ? "Assistant" : "Person"}: ${clip(String(turn?.text ?? ""), 600)}`);
  return [
    `Their text now: ${clip(String(question ?? ""), 3_000)}`,
    "",
    `The reply about to be sent: ${clip(String(answer ?? ""), 3_000)}`,
    "",
    ...(report ? [`The job's report (job "${clip(String(report.title ?? ""), 120)}", ${String(report.state ?? "done")}), which the person has not seen:`, clip((Array.isArray(report.texts) ? report.texts : []).join("\n\n") || "(nothing)", 4_000), ""] : []),
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
 * check (`claimCheck.js`; the word checks the gates replace, `doItChecks.js` and
 * `untriedWeb.js`, are off when they run), which runs first.
 * `check(answer, { messages })` runs the gates; `verdicts` keeps each judging,
 * for the turn's log and the benchmark. `report`, a job's report (`jobReport.js`
 * `jobReportOf`), runs the report set in place of the text set, and the gates read it.
 */
export function replyJudge({ ai, setting, question, history = [], inner = null, report = null, clock = Date.now, log = console.log }) {
  const pick = JUDGE_MODELS[setting?.model];
  const decide = pick ? decisionEngine(ai, pick) : null;
  const atOf = (name) => (typeof setting?.at === "number" ? setting.at : (GATES[name].at ?? DEFAULT_GATE_AT));
  const verdicts = [];
  // A computer owner's ask goes out in the gateway's own words whatever the turn says (`jobReport.js`): nothing to judge.
  const set = report?.ask ? [] : gatesFor({ report: report !== null }); // every gate reads every draft it applies to: a rewrite can bring in a fault the first draft did not have
  let sentBack = 0;
  return {
    verdicts,
    async check(answer, turn = {}) {
      const before = typeof inner?.check === "function" ? await inner.check(answer, turn) : null;
      if (before !== null && before !== undefined) {
        // The code checks that run first: what they sent back, kept in the chat's history too.
        turn.tell?.(judgeEvent({ by: "code", round: sentBack, draft: answer, went: false, notice: before }));
        return before;
      }
      const open = set.filter((name) => gateReads(name, answer, { question, history, messages: turn.messages }));
      if (decide === null || open.length === 0) return null;
      // A quiet word is never a text: nothing is sent, so there is nothing to judge (Tex Devs, 2026-11-05: a SKIP sent back three times; `sayNothing.js`).
      if (isControlWord(answer)) return null;
      if (sentBack >= MAX_SEND_BACKS) {
        turn.tell?.(judgeEvent({ by: "gates", model: pick.model, round: sentBack, draft: answer, went: true, reason: "sent back twice already, so it goes as it is" }));
        return null;
      }
      const state = judgeState({ question, history, messages: turn.messages, answer, report });
      const started = clock();
      const facts = open.filter((name) => gateFact(name, answer, { question, history })); // seen by code: no Clef call
      const yes = { ...(await runGates(decide, state, open.filter((name) => !facts.includes(name)))), ...Object.fromEntries(facts.map((name) => [name, 1])) };
      const ms = clock() - started;
      const failed = open.filter((name) => typeof yes[name] === "number" && yes[name] >= atOf(name));
      const acted = failed.length > 0;
      const answered = Object.values(yes).filter((value) => typeof value === "number");
      const confidence = answered.length === 0 ? null : Math.max(...answered);
      const verdict = answered.length === 0 ? null : acted ? failed.join(",") : "accepted";
      verdicts.push({ verdict, confidence, ms, acted, gates: yes, failed, round: sentBack, tokens: open.reduce((sum, name) => sum + decisionTokens(state, gateQuestion(name)), 0) });
      turn.mark?.({ verdict, confidence, ms, acted, ok: verdict !== null });
      // Gate names and numbers only: never the reply or the question (`docs/decisions/observability`).
      log(JSON.stringify({ event: "tex_reply_gates", model: pick.model, round: sentBack, ran: open, failed, ms, acted }));
      const notice = acted ? sendBackNotice(failed) : null;
      // Every judge's verdict on this draft, and whether it went, in the chat's history (Dev2, 2026-11-05: "so we can see how responses were shaped").
      turn.tell?.(judgeEvent({ by: "gates", model: pick.model, round: sentBack, draft: answer, went: !acted, ms, notice, judges: open.map((name) => ({ id: name, yes: typeof yes[name] === "number" ? round2(yes[name]) : null, at: atOf(name), passed: !failed.includes(name) })) }));
      if (!acted) return null;
      sentBack += 1;
      return notice;
    },
  };
}

const round2 = (value) => Math.round(value * 100) / 100;

/**
 * One judging of a draft, as the turn tells it (`turn.js` `tell`) and the
 * chat's ledger keeps it (`ledger.js` `judgeEntry`): who judged (`gates`, or
 * `code` for the checks that run first), the round, the draft, each judge's
 * id, yes and threshold, whether the draft went, and the notice it went back
 * with. `judges` is empty for `code` and for a draft the send-back cap let go.
 */
export function judgeEvent({ by, model = null, round, draft, went, ms = null, notice = null, reason = null, judges = [] }) {
  return { kind: "judge", by, ...(model ? { model } : {}), round, draft: String(draft ?? ""), went, ...(typeof ms === "number" ? { ms } : {}), ...(notice ? { notice } : {}), ...(reason ? { reason } : {}), judges, failed: judges.filter((judge) => !judge.passed).map((judge) => judge.id) };
}

/** Every gate at once, each its own call: `{ [gate]: yes }`, with no entry for a gate that failed or ran out of time. */
export async function runGates(decide, state, names) {
  const answers = await Promise.all(names.map((name) => withTimeout(decide(state, gateQuestion(name)), JUDGE_TIMEOUT_MS)));
  const yes = {};
  names.forEach((name, i) => {
    const value = answers[i]?.[name]?.noul;
    if (typeof value === "number" && Number.isFinite(value)) yes[name] = value;
  });
  return yes;
}

/** `reply_judge:` in a setup: absent is off; `clef` or `clef-flash` names the gates' model; `judge_at` one threshold for every gate; anything else refuses the setup (`undefined`). */
export function readReplyJudge(value, at) {
  if (value === undefined || value === "off" || value === false) return at === undefined ? null : undefined;
  if (typeof value !== "string" || !(value in JUDGE_MODELS)) return undefined;
  if (at === undefined) return { model: value, at: null }; // each gate's own tuned threshold
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
