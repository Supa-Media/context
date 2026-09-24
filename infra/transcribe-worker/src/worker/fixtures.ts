// Shared fixtures for the worker suite, split out of `worker.test.ts` so
// each behavioural slice can stay under the file-size ceiling. Named
// `fixtures.ts` rather than `*.test.ts` so vitest does not treat it as a
// suite of its own.
import { handleRequest } from "../index";
import { MAX_AUDIO_BYTES, MAX_BODY_BYTES, TURBO_MODEL, FALLBACK_MODEL } from "../transcribe";
import type { Env } from "../index";

export const SECRET = "test-only-transcribe-secret";

/** Recognisable, and long enough that a substring check means something. */
export const AUDIO = Buffer.from("pretend this is a minute of somebody's meeting").toString("base64");

/** An engine that answers with a fixed value, recording what it was asked. */
export function fakeAi(answer: unknown | ((model: string) => unknown)) {
  const calls: { model: string; input: unknown }[] = [];
  return {
    calls,
    binding: {
      run(model: string, input: unknown) {
        calls.push({ model, input });
        const value = typeof answer === "function" ? (answer as (m: string) => unknown)(model) : answer;
        if (value instanceof Error) throw value;
        return Promise.resolve(value);
      },
    },
  };
}

/**
 * A caller identifier in exactly the shape the control plane mints: hex
 * SHA-256, lowercase. Not derived from anything — this repository is public and
 * a real one would be a fact about an account.
 */
export const CALLER = "b3".repeat(32);

/**
 * A rate limiter that always allows, recording the keys it was asked about.
 *
 * The default for every test below that is not *about* the limit, so those
 * tests keep testing what they were written to test. The limit's own behaviour
 * — allowed, refused, and the binding throwing or missing — is `src/
 * rateLimit.test.ts` for the unit and "the rate limit" here for the wiring.
 */
export function allowingLimiter() {
  const keys: string[] = [];
  return {
    keys,
    binding: {
      limit(options: { key: string }) {
        keys.push(options.key);
        return Promise.resolve({ success: true });
      },
    },
  };
}

export function envWith(ai: unknown, limiter: unknown = allowingLimiter().binding): Env {
  return { TRANSCRIBE_WORKER_SECRET: SECRET, AI: ai, TRANSCRIBE_RATE_LIMIT: limiter } as Env;
}

/** The headers every legitimate request carries. */
export function authHeaders(): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${SECRET}`,
    "x-caller-hash": CALLER,
  };
}

export function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://transcribe.invalid/transcribe", {
    method: "POST",
    headers: { ...authHeaders(), ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

export const TIMED_ANSWER = {
  text: " Morning.",
  segments: [{ start: 0, end: 1.5, text: " Morning.", avg_logprob: -0.2 }],
  transcription_info: { duration: 1.5 },
};

/**
 * The evidence a chunk carries when the engine said nothing about speech.
 *
 * Zeros and `null`s, and the difference between them is the point: the counts
 * say how many segments were looked at, and every *reading* is `null` because
 * the engine stated none. A build that filled these in with `0` would be
 * reporting a confident measurement of silence that nobody made.
 */
export const SAID_NOTHING = {
  segments: 0,
  statedNoSpeech: 0,
  statedLogprob: 0,
  keptNoSpeechMax: null,
  keptLogprobMin: null,
  refusedNoSpeechMin: null,
  refusedLogprobMax: null,
  duration: null,
  durationAfterVad: null,
};


export { handleRequest, MAX_AUDIO_BYTES, MAX_BODY_BYTES, TURBO_MODEL, FALLBACK_MODEL };
export type { Env };
