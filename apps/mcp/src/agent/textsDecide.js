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
 */

import { decisionEngine } from "./decide.js";
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
export async function decideForTexts(request, env, { engine = decisionEngine(env?.AI) } = {}) {
  const path = new URL(request.url).pathname;
  const recheck = path === TEXTS_RECHECK_PATH;
  const raw = await readJson(request);
  const body = raw === null ? null : recheck ? readRecheckBody(raw) : readDecideBody(raw);
  if (body === null) return new Response(null, { status: 400 });
  const asked = recheck ? recheckRequest(body) : decideRequest(body);
  const meter = { questions: Object.keys(asked.questions).length, chars: asked.state.length + JSON.stringify(asked.questions).length, ms: 0 };
  const started = Date.now();
  const answers = engine === null ? null : await engine(asked.state, asked.questions);
  meter.ms = Date.now() - started;
  const result =
    engine === null
      ? { ok: false, reason: "unavailable", cause: "unconfigured" }
      : answers === null
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
  return Response.json({ ...result, meter: { ...meter, answered: answers !== null } });
}
