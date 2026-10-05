/**
 * `POST /extract` — instructions, one piece of text and the shape of the
 * answer in, an answer of that shape out, nothing kept.
 *
 * `/decide`'s writing sibling. Clef can only pick from what it is offered, and
 * "What changed" has to say things nobody offered it: that a meeting says
 * somebody left, which projects they owned, the sentence that says so. So
 * this route runs a generative model, open weights on Cloudflare's own GPUs,
 * constrained to a JSON schema the control plane sends. Workers AI does not
 * train on or keep what it is sent; the reasoning and the bounds are in
 * docs/decisions/storage-and-credentials/inference.md.
 *
 * Every rule from the header of ./index.ts applies unchanged, with "note text"
 * for "audio": never persisted, never logged, never echoed in an error. The
 * answer is the model's writing about a note, so it is note content too and
 * gets the same treatment.
 *
 * The models are a fixed list named here. The caller may pick one of them by
 * its short name, so the live score can compare them; it can never name a
 * model id, so this route is not a way to reach anything else on the account.
 */

import { isAuthorized } from "./auth";
import { CALLER_HEADER, readCaller } from "./rateLimit";
import { readBoundedBody } from "./transcribe";
import type { Env } from "./index";

/**
 * Prices per million tokens, in then out (Cloudflare's Workers AI pricing
 * page, checked 2026-10-05): Gemma 4 26B $0.10 / $0.30, a 256K window;
 * GLM-4.7 Flash $0.06 / $0.40, a 131K window. GLM is the default because it
 * is the one that passes: on the live What changed score (2026-10-05) GLM
 * answered 6 of 6 and scored 100%, while half of Gemma's answers were not
 * readable JSON. Gemma stays on the list so the score can keep measuring it.
 */
export const WRITING_MODELS = {
  gemma: "@cf/google/gemma-4-26b-a4b-it",
  glm: "@cf/zai-org/glm-4.7-flash",
} as const;
export type WritingModel = keyof typeof WRITING_MODELS;
export const DEFAULT_WRITING_MODEL: WritingModel = "glm";

/** About 30K tokens of text: one long meeting, one busy day of mail. Bounds a call's cost. */
export const MAX_TEXT_CHARS = 120_000;
export const MAX_EXTRACT_BODY_BYTES = 200_000;
const MAX_INSTRUCTION_CHARS = 12_000;
const MAX_SCHEMA_CHARS = 12_000;
/** Room for the model's thinking and a full answer. */
const MAX_COMPLETION_TOKENS = 8_192;

export interface ExtractRequest {
  instructions: string;
  text: string;
  schema: Record<string, unknown>;
  model: WritingModel;
}

type Parsed = { ok: true; value: ExtractRequest } | { ok: false };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function isWritingModel(value: unknown): value is WritingModel {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(WRITING_MODELS, value);
}

/** The request, or a refusal. Exactly these keys; `model` only from the list. */
export function readExtractRequest(body: unknown): Parsed {
  if (!isRecord(body)) return { ok: false };
  const keys = Object.keys(body);
  const allowed = new Set(["instructions", "text", "schema", "model"]);
  if (!keys.every((key) => allowed.has(key))) return { ok: false };
  if (!isText(body.instructions, MAX_INSTRUCTION_CHARS)) return { ok: false };
  if (!isText(body.text, MAX_TEXT_CHARS)) return { ok: false };
  if (!isRecord(body.schema) || body.schema.type !== "object") return { ok: false };
  if (JSON.stringify(body.schema).length > MAX_SCHEMA_CHARS) return { ok: false };
  if (body.model !== undefined && !isWritingModel(body.model)) return { ok: false };
  return {
    ok: true,
    value: {
      instructions: body.instructions,
      text: body.text,
      schema: body.schema,
      model: (body.model as WritingModel | undefined) ?? DEFAULT_WRITING_MODEL,
    },
  };
}

function parseObject(raw: string): Record<string, unknown> | null {
  // Some models think out loud before the answer, or fence it; the answer is
  // the outermost object either way.
  const unthought = raw.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const trimmed = unthought.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  if (!trimmed) return null;
  for (const candidate of [trimmed, trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1)]) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (isRecord(value)) return value;
    } catch {
      // try the next reading
    }
  }
  return null;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

/**
 * The model's answer as one JSON object, and what it cost in tokens. Read
 * from the chat shape (`choices[0].message.content`) or the older Workers AI
 * shape (`response`, a string or already an object). Anything else is
 * unreadable; the caller treats that as "nothing found", never as a guess.
 */
export function readOutput(raw: unknown): { output: Record<string, unknown>; usage: { input: number; output: number } } | null {
  if (!isRecord(raw)) return null;
  let output: Record<string, unknown> | null = null;
  const choice = Array.isArray(raw.choices) ? raw.choices[0] : undefined;
  if (isRecord(choice) && isRecord(choice.message) && typeof choice.message.content === "string") {
    output = parseObject(choice.message.content);
  } else if (isRecord(raw.response)) {
    output = raw.response;
  } else if (typeof raw.response === "string") {
    output = parseObject(raw.response);
  }
  if (!output) return null;
  const usage = isRecord(raw.usage) ? raw.usage : {};
  return { output, usage: { input: count(usage.prompt_tokens), output: count(usage.completion_tokens) } };
}

interface ExtractLog {
  event: "extracted" | "extract_failed" | "extract_unreadable" | "extract_refused" | "unauthorized" | "ai_not_bound";
  caller?: string;
  model?: WritingModel;
  chars?: number;
  tokensIn?: number;
  tokensOut?: number;
  ms?: number;
  reason?: "malformed" | "too_large" | "no_caller";
}

/** Numbers about the request, never any of its text or the answer's. */
function log(fields: ExtractLog): void {
  console.log(JSON.stringify({ worker: "context-transcribe", route: "extract", ...fields }));
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export async function handleExtract(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthorized(request.headers.get("authorization"), env.TRANSCRIBE_WORKER_SECRET))) {
    log({ event: "unauthorized" });
    return new Response(null, { status: 401 });
  }
  const caller = readCaller(request.headers.get(CALLER_HEADER));
  if (caller === null) {
    log({ event: "extract_refused", reason: "no_caller" });
    return json(400, { error: "invalid request" });
  }
  if (!env.AI) {
    log({ event: "ai_not_bound", caller });
    return json(500, { error: "workers ai is not bound" });
  }
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_EXTRACT_BODY_BYTES) {
    log({ event: "extract_refused", caller, reason: "too_large" });
    return json(413, { error: "request too large" });
  }
  let body: unknown;
  try {
    const bounded = await readBoundedBody(request.body, MAX_EXTRACT_BODY_BYTES);
    if (!bounded.ok) {
      log({ event: "extract_refused", caller, reason: "too_large" });
      return json(413, { error: "request too large" });
    }
    body = JSON.parse(bounded.text);
  } catch {
    log({ event: "extract_refused", caller, reason: "malformed" });
    return json(400, { error: "invalid request body" });
  }
  const parsed = readExtractRequest(body);
  if (!parsed.ok) {
    log({ event: "extract_refused", caller, reason: "malformed" });
    return json(400, { error: "invalid request body" });
  }
  const { instructions, text, schema, model } = parsed.value;
  const started = Date.now();
  let raw: unknown;
  try {
    raw = await env.AI.run(WRITING_MODELS[model], {
      messages: [
        { role: "system", content: instructions },
        { role: "user", content: text },
      ],
      response_format: { type: "json_schema", json_schema: { name: "answer", schema, strict: true } },
      max_completion_tokens: MAX_COMPLETION_TOKENS,
      temperature: 0.2,
    });
  } catch {
    // The upstream error may quote the text back; none of it leaves here.
    log({ event: "extract_failed", caller, model, chars: text.length });
    return json(502, { error: "the writing model failed" });
  }
  const answer = readOutput(raw);
  if (!answer) {
    log({ event: "extract_unreadable", caller, model, chars: text.length });
    return json(502, { error: "the writing model returned an unreadable answer" });
  }
  log({
    event: "extracted",
    caller,
    model,
    chars: text.length,
    tokensIn: answer.usage.input,
    tokensOut: answer.usage.output,
    ms: Date.now() - started,
  });
  return json(200, answer);
}
