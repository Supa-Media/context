/**
 * Decide and the last look, asked of Clef here in the gateway (Dev2's pick, 2026-11-05: decide moves into the
 * gateway, its daily cap and usage rows kept). The texting Worker asks over the `TexTexts` service binding (no public
 * URL, no secret of its own), with the body it used to send the control plane's `/agent-texts/decide` and
 * `/agent-texts/recheck`. The questions and how answers read are the control plane's own copy
 * (`packages/shared/src/textDecide.cjs`), so the two never drift.
 *
 * The cap and the usage rows stay in the control plane: the Worker asks its gate now and then and reports what was
 * decided after the answer is in (`apps/agent/src/decide.ts`). So this answers with `meter`, the counts that report
 * needs: questions asked and characters Clef read, never words.
 *
 * The transcript and the draft are answered on, never kept or logged here: the one log line carries counts and codes.
 * The judge's verdict on a group's moment is kept in that chat's ledger as a `judge` entry (`judgeVerdictEntry`), when
 * the Worker names the chat's ledger key: what it chose, the why, the event it judged, never a word of the chat.
 */

import { DECISION_MODEL, decisionEngine } from "./decide.js";
import { ledgerFor, ledgerWriter } from "./ledger.js";
import { decideRequest, readDecideAnswers, readDecideBody, readRecheckAnswers, readRecheckBody, recheckRequest } from "../../../../packages/shared/src/textDecide.cjs";

/** The paths the Worker posts to on the `TexTexts` binding. */
export const TEXTS_DECIDE_PATH = "/texts/decide";
export const TEXTS_RECHECK_PATH = "/texts/recheck";
/** A transcript, a draft, 32 ids and 8 asks, with room for the JSON around them. */
const MAX_BODY_CHARS = 64_000;

async function readJson(request) {
  if (request.method !== "POST") return null;
  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) return null;
  try {
    const body = JSON.parse(text);
    return body !== null && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

/**
 * `{ ...decide's answer, meter: { questions, chars, ms } }`; a model that fails or answers off the set is
 * `{ ok: false, reason: "unavailable", cause }`, as the control plane answered it. `engine` is for tests.
 */
export async function decideForTexts(request, env, { engine = decisionEngine(env?.AI), ledger = (key) => ledgerFor(env, { chat: key }), waitUntil = null } = {}) {
  const path = new URL(request.url).pathname;
  const recheck = path === TEXTS_RECHECK_PATH;
  const raw = await readJson(request);
  const body = raw === null ? null : recheck ? readRecheckBody(raw) : readDecideBody(raw);
  if (body === null) return new Response(null, { status: 400 });
  // No model here (a gateway with no AI binding): 503, so the Worker asks the control plane as it did before.
  if (engine === null) return new Response(null, { status: 503 });
  const asked = recheck ? recheckRequest(body) : decideRequest(body);
  const meter = { questions: Object.keys(asked.questions).length, chars: asked.state.length + JSON.stringify(asked.questions).length, ms: 0 };
  const started = Date.now();
  const answers = await engine(asked.state, asked.questions);
  meter.ms = Date.now() - started;
  const result =
    answers === null
      ? { ok: false, reason: "unavailable", cause: "model_failed" }
      : recheck
        ? readRecheckAnswers(answers)
        : readDecideAnswers(body, answers);
  // Counts and codes only: never the transcript, a draft, or a number.
  console.log(
    JSON.stringify({
      event: recheck ? "texts_recheck_gateway" : "texts_decide_gateway",
      style: body.style,
      candidates: body.candidates.length,
      ms: meter.ms,
      ...(result.ok ? (recheck ? { fits: result.fits } : { act: result.act, covers: result.covers.length }) : { cause: result.cause }),
    }),
  );
  // The verdict in the group's ledger, behind the answer: never on the text's path.
  if (!recheck && result.ok && body.ledger) {
    const written = ledgerWriter(ledger(body.ledger), body.ledger)?.write(judgeVerdictEntry(body, result, meter.ms)) ?? Promise.resolve();
    if (typeof waitUntil === "function") waitUntil(written);
  }
  return Response.json({ ...result, meter: { ...meter, answered: answers !== null } });
}

/** The verdict words the design names (`one-judge-one-record.md`) for the contract's acts. */
const VERDICT = { answer: "respond", react: "react", silent: "quiet", wait: "wait" };

/**
 * One judging of a moment as a `judge` entry (`agent/ledger.js`): `by: "moment"`, the verdict, its why (one of the
 * judge's labels), the event judged, and when a turn ran, what that text does to it. Names and codes only.
 */
export function judgeVerdictEntry(body, result, ms) {
  return {
    v: 1,
    id: `judge${body.newest.replace(/[^0-9]/g, "")}${body.running ? "r" : ""}${Date.now().toString(36)}`,
    at: Date.now(),
    kind: "judge",
    by: "moment",
    model: DECISION_MODEL,
    verdict: VERDICT[result.act],
    went: result.act === "answer",
    event: body.newest,
    ...(result.why ? { why: result.why } : {}),
    ...(result.emoji ? { emoji: result.emoji } : {}),
    ...(result.midTurn ? { midTurn: result.midTurn } : {}),
    confidence: result.confidence,
    ms,
  };
}
