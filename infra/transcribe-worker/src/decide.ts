/**
 * `POST /decide` — one piece of note text and a few typed questions in, typed
 * answers out, nothing kept.
 *
 * The auto-organize sweep's only way to reach Jev, TypeSafe's decision model,
 * which Workers AI serves as `typesafe/jev` with zero data retention. Jev never
 * writes text: it answers yes/no (`noul`), picks one of the options it was
 * given (`choice`), or places the text on a scale (`score`). The reasoning for
 * running it at all, and the bounds that make it allowed, are in
 * docs/decisions/storage-and-credentials/inference.md.
 *
 * It lives in this Worker rather than a new one because this Worker is already
 * exactly the right shape: one caller (the control plane), one shared secret,
 * a Workers AI binding and nowhere to keep anything. A second Worker would be a
 * second secret and a second deploy with the same guarantees. The rules from
 * the header of ./index.ts apply here unchanged, with "note text" for "audio":
 * never persisted, never logged, never echoed in an error.
 *
 * The caller identifier is required and logged, for attribution, and the
 * per-caller limiter is NOT consulted: its budget is sized for audio chunks and
 * it does not meter on this account anyway (see ./index.ts). What bounds spend
 * here is the control plane, which is the only thing that can call this route
 * and which sweeps a workspace at most once a day under a fixed note cap.
 */

import { isAuthorized } from "./auth";
import { CALLER_HEADER, readCaller } from "./rateLimit";
import { readBoundedBody } from "./transcribe";
import type { Env } from "./index";

export const JEV_MODEL = "typesafe/jev";

/** Jev's window is 32K tokens; four bytes a token with room for the questions. */
export const MAX_STATE_CHARS = 100_000;
export const MAX_DECIDE_BODY_BYTES = 160_000;
export const MAX_QUESTIONS = 16;
export const MAX_CHOICE_OPTIONS = 64;
export const MAX_SCORE_LEVELS = 10;
const MAX_INSTRUCTION_CHARS = 1_000;
const MAX_CRITERION_CHARS = 400;
const NAME = /^[a-z][a-z0-9_]{0,39}$/;
const OPTION = /^[a-z0-9][a-z0-9_-]{0,59}$/;

type Question =
  | { type: "noul"; instructions: string; criteria: { true: string; false: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

export interface DecideRequest {
  state: string;
  questions: Record<string, Question>;
}

export type Answer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "score"; score: number; confidence: number; probabilities: Record<string, number> };

type Parsed = { ok: true; value: DecideRequest } | { ok: false };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function readQuestion(value: unknown): Question | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "criteria,instructions,type") return null;
  if (!isText(value.instructions, MAX_INSTRUCTION_CHARS)) return null;
  const { criteria } = value;
  if (value.type === "noul") {
    if (!isRecord(criteria) || Object.keys(criteria).sort().join(",") !== "false,true") return null;
    if (!isText(criteria.true, MAX_CRITERION_CHARS) || !isText(criteria.false, MAX_CRITERION_CHARS)) return null;
    return { type: "noul", instructions: value.instructions, criteria: { true: criteria.true, false: criteria.false } };
  }
  if (value.type === "choice") {
    if (!isRecord(criteria)) return null;
    const entries = Object.entries(criteria);
    if (entries.length < 2 || entries.length > MAX_CHOICE_OPTIONS) return null;
    if (!entries.every(([key, text]) => OPTION.test(key) && isText(text, MAX_CRITERION_CHARS))) return null;
    return { type: "choice", instructions: value.instructions, criteria: criteria as Record<string, string> };
  }
  if (value.type === "score") {
    if (!Array.isArray(criteria) || criteria.length < 2 || criteria.length > MAX_SCORE_LEVELS) return null;
    if (!criteria.every((level) => isText(level, MAX_CRITERION_CHARS))) return null;
    return { type: "score", instructions: value.instructions, criteria: criteria as string[] };
  }
  return null;
}

/** The request, or a refusal. Exactly `state` and `questions`: no model choice. */
export function readDecideRequest(body: unknown): Parsed {
  if (!isRecord(body)) return { ok: false };
  if (Object.keys(body).sort().join(",") !== "questions,state") return { ok: false };
  if (!isText(body.state, MAX_STATE_CHARS)) return { ok: false };
  if (!isRecord(body.questions)) return { ok: false };
  const entries = Object.entries(body.questions);
  if (entries.length < 1 || entries.length > MAX_QUESTIONS) return { ok: false };
  const questions: Record<string, Question> = {};
  for (const [name, raw] of entries) {
    if (!NAME.test(name)) return { ok: false };
    const question = readQuestion(raw);
    if (!question) return { ok: false };
    questions[name] = question;
  }
  return { ok: true, value: { state: body.state, questions } };
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function readProbabilities(value: unknown): Record<string, number> | null {
  if (!isRecord(value)) return null;
  const out: Record<string, number> = {};
  for (const [key, p] of Object.entries(value)) {
    if (!isProbability(p)) return null;
    out[key] = p;
  }
  return out;
}

/**
 * Jev's answer, re-read against what was asked. A missing question, a type
 * that disagrees, or a choice outside the offered options is unreadable, and
 * the caller treats unreadable as "no suggestion", never as a guess.
 */
export function readAnswers(
  raw: unknown,
  asked: Record<string, Question>,
): Record<string, Answer> | null {
  if (!isRecord(raw) || !isRecord(raw.answers)) return null;
  const answers: Record<string, Answer> = {};
  for (const [name, question] of Object.entries(asked)) {
    const answer = raw.answers[name];
    if (!isRecord(answer) || answer.type !== question.type) return null;
    if (question.type === "noul") {
      if (!isProbability(answer.noul)) return null;
      answers[name] = { type: "noul", noul: answer.noul };
      continue;
    }
    const probabilities = readProbabilities(answer.probabilities);
    if (!probabilities || !isProbability(answer.confidence)) return null;
    if (question.type === "choice") {
      if (typeof answer.choice !== "string" || !(answer.choice in question.criteria)) return null;
      answers[name] = { type: "choice", choice: answer.choice, confidence: answer.confidence, probabilities };
    } else {
      const score = answer.score;
      if (typeof score !== "number" || !Number.isFinite(score)) return null;
      if (score < 0 || score > question.criteria.length - 1) return null;
      answers[name] = { type: "score", score, confidence: answer.confidence, probabilities };
    }
  }
  return answers;
}

interface DecideLog {
  event: "decided" | "decide_failed" | "decide_unreadable" | "decide_refused" | "unauthorized" | "ai_not_bound";
  caller?: string;
  questions?: number;
  chars?: number;
  ms?: number;
  reason?: "malformed" | "too_large" | "no_caller";
}

/** Numbers about the request, never any of its text. */
function log(fields: DecideLog): void {
  console.log(JSON.stringify({ worker: "context-transcribe", route: "decide", ...fields }));
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export async function handleDecide(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthorized(request.headers.get("authorization"), env.TRANSCRIBE_WORKER_SECRET))) {
    log({ event: "unauthorized" });
    return new Response(null, { status: 401 });
  }
  const caller = readCaller(request.headers.get(CALLER_HEADER));
  if (caller === null) {
    log({ event: "decide_refused", reason: "no_caller" });
    return json(400, { error: "invalid request" });
  }
  if (!env.AI) {
    log({ event: "ai_not_bound", caller });
    return json(500, { error: "workers ai is not bound" });
  }
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_DECIDE_BODY_BYTES) {
    log({ event: "decide_refused", caller, reason: "too_large" });
    return json(413, { error: "request too large" });
  }
  let text: string;
  try {
    const bounded = await readBoundedBody(request.body, MAX_DECIDE_BODY_BYTES);
    if (!bounded.ok) {
      log({ event: "decide_refused", caller, reason: "too_large" });
      return json(413, { error: "request too large" });
    }
    text = bounded.text;
  } catch {
    log({ event: "decide_refused", caller, reason: "malformed" });
    return json(400, { error: "invalid request body" });
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    log({ event: "decide_refused", caller, reason: "malformed" });
    return json(400, { error: "invalid request body" });
  }
  const parsed = readDecideRequest(body);
  if (!parsed.ok) {
    log({ event: "decide_refused", caller, reason: "malformed" });
    return json(400, { error: "invalid request body" });
  }
  const { state, questions } = parsed.value;
  const started = Date.now();
  let raw: unknown;
  try {
    raw = await env.AI.run(JEV_MODEL, { state, questions });
  } catch {
    // The upstream error may quote the state back; none of it leaves here.
    log({ event: "decide_failed", caller, questions: Object.keys(questions).length });
    return json(502, { error: "the decision engine failed" });
  }
  const answers = readAnswers(raw, questions);
  if (!answers) {
    log({ event: "decide_unreadable", caller, questions: Object.keys(questions).length });
    return json(502, { error: "the decision engine returned an unreadable answer" });
  }
  log({
    event: "decided",
    caller,
    questions: Object.keys(questions).length,
    chars: state.length,
    ms: Date.now() - started,
  });
  return json(200, { answers });
}
