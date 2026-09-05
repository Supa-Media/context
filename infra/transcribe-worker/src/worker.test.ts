/**
 * The Worker as a caller meets it: one route, one credential, and one thing
 * that must never leave the process.
 *
 * **Audio is transient.** `docs/decisions/meetings.md` makes that a rule rather
 * than an aspiration — the note is the artifact and the recording is not — and
 * `CLAUDE.md` says structured logs carry request and workspace identifiers,
 * never secrets and never note content. A minute of somebody's meeting is
 * squarely note content. The hardest place for that to hold is an error path,
 * because an error string is the easiest thing in a system to build by
 * interpolation, so the last `describe` here drives an engine that throws the
 * audio back at us and asserts it reaches neither the response nor a log.
 *
 * Each `describe` is a sabotage target; the comment names the edit that defeats
 * it and the test that catches it.
 *
 * ============================================================================
 * SABOTAGE RECORD
 * ============================================================================
 *
 * This suite went green on its first run, which is the state to distrust: a
 * test that has never failed has not been shown to test anything. So each
 * invariant was broken deliberately, one at a time, and the run recorded. All
 * nine reddened the named test and nothing else reddened in its place:
 *
 *   src/auth.ts
 *     `timingSafeEqual` → `return a === b`
 *         → "compares without an early exit on length, and without ===" (1)
 *     `if (!expected) return false` → `return true`
 *         → "refuses everything when the secret is unset", and
 *           "refuses everything when the deployment has no secret" (2)
 *
 *   src/transcribe.ts
 *     `confidence` derived from `Math.exp(avg_logprob)`
 *         → "never invents a confidence from a log-probability", plus the two
 *           mapping tests that assert the whole segment (3)
 *     `isUnknownModelError` → `return true`
 *         → "does not match an ordinary failure", and
 *           "does not retry an ordinary engine failure on a second model" (2)
 *     the `bytes > MAX_AUDIO_BYTES` check deleted
 *         → "413s audio over the cap", and "refuses audio over the cap" (2)
 *     `start * 1000` → `start`
 *         → "reads the engine's seconds as seconds", and two more (3)
 *
 *   src/index.ts
 *     the 502 interpolates `String(error)`
 *         → "keeps the audio out of a 502, even when the engine throws it
 *            back" (1) — the invariant this Worker most exists under, caught
 *           by the one test written for the debugging edit that breaks it
 *     `path !== "/transcribe"` → `!path.startsWith("/transcribe")`
 *         → "404s every other path and method" (1)
 *     the `if (!env.AI)` branch removed
 *         → "says so, in the one string CI greps for" (1)
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleRequest } from "./index";
import { MAX_AUDIO_BYTES, TURBO_MODEL, FALLBACK_MODEL } from "./transcribe";
import type { Env } from "./index";

const SECRET = "test-only-transcribe-secret";

/** Recognisable, and long enough that a substring check means something. */
const AUDIO = Buffer.from("pretend this is a minute of somebody's meeting").toString("base64");

/** An engine that answers with a fixed value, recording what it was asked. */
function fakeAi(answer: unknown | ((model: string) => unknown)) {
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

function envWith(ai: unknown): Env {
  return { TRANSCRIBE_WORKER_SECRET: SECRET, AI: ai } as Env;
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://transcribe.invalid/transcribe", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}`, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const TIMED_ANSWER = {
  text: " Morning.",
  segments: [{ start: 0, end: 1.5, text: " Morning.", avg_logprob: -0.2 }],
  transcription_info: { duration: 1.5 },
};

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * SABOTAGE: return 401 with a body naming which half failed — "no header" vs
 * "wrong secret" — and "says nothing about why" goes RED. A caller who can tell
 * those apart can find out whether a guessed prefix was on the right track.
 */
describe("the credential", () => {
  it("refuses a request with no Authorization header, with no detail", async () => {
    const response = await handleRequest(
      new Request("https://transcribe.invalid/transcribe", {
        method: "POST",
        body: JSON.stringify({ audioBase64: AUDIO, mimeType: "audio/webm" }),
      }),
      envWith(fakeAi(TIMED_ANSWER).binding),
    );
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("");
  });

  it("says nothing about why, whatever was wrong", async () => {
    for (const header of ["", "Bearer", "Basic x", "Bearer wrong", `Bearer ${SECRET}x`]) {
      const response = await handleRequest(
        post({ audioBase64: AUDIO, mimeType: "audio/webm" }, { authorization: header }),
        envWith(fakeAi(TIMED_ANSWER).binding),
      );
      expect(response.status, header).toBe(401);
      expect(await response.text(), header).toBe("");
    }
  });

  it("never reaches the engine on a refused request", async () => {
    // The order that matters: authorization before anything reads the body, so
    // an unauthenticated caller cannot spend the account's inference budget.
    const ai = fakeAi(TIMED_ANSWER);
    await handleRequest(
      post({ audioBase64: AUDIO, mimeType: "audio/webm" }, { authorization: "Bearer wrong" }),
      envWith(ai.binding),
    );
    expect(ai.calls).toEqual([]);
  });

  it("refuses everything when the deployment has no secret", async () => {
    const response = await handleRequest(
      post({ audioBase64: AUDIO, mimeType: "audio/webm" }),
      { AI: fakeAi(TIMED_ANSWER).binding } as Env,
    );
    expect(response.status).toBe(401);
  });
});

/**
 * SABOTAGE: route on `startsWith` instead of an exact path and
 * `/transcribe/../health` — or `/transcribeXYZ` — becomes a live route.
 */
describe("routing", () => {
  it("answers /health honestly, and without a credential", async () => {
    // This is how CI learns whether Workers AI is actually enabled on the
    // account: `wrangler deploy` succeeds either way, and a binding that was
    // never provisioned is simply absent at runtime. It reveals nothing — the
    // answer does not depend on any caller, any workspace, or any secret — so
    // it is deliberately unauthenticated, and the deploy workflow fails the job
    // when `ai` is false.
    const bound = await handleRequest(
      new Request("https://transcribe.invalid/health"),
      envWith(fakeAi(TIMED_ANSWER).binding),
    );
    expect(bound.status).toBe(200);
    expect(await bound.json()).toEqual({ ok: true, ai: true });

    const unbound = await handleRequest(new Request("https://transcribe.invalid/health"), {
      TRANSCRIBE_WORKER_SECRET: SECRET,
    } as Env);
    expect(unbound.status).toBe(200);
    expect(await unbound.json()).toEqual({ ok: true, ai: false });
  });

  it("404s every other path and method", async () => {
    const env = envWith(fakeAi(TIMED_ANSWER).binding);
    const cases: [string, string][] = [
      ["GET", "https://transcribe.invalid/"],
      ["GET", "https://transcribe.invalid/transcribe"],
      ["POST", "https://transcribe.invalid/health"],
      ["POST", "https://transcribe.invalid/transcribeXYZ"],
      ["POST", "https://transcribe.invalid/transcribe/extra"],
      ["PUT", "https://transcribe.invalid/transcribe"],
      ["DELETE", "https://transcribe.invalid/transcribe"],
    ];
    for (const [method, url] of cases) {
      const response = await handleRequest(
        new Request(url, {
          method,
          headers: { authorization: `Bearer ${SECRET}` },
          ...(method === "POST" || method === "PUT"
            ? { body: JSON.stringify({ audioBase64: AUDIO, mimeType: "audio/webm" }) }
            : {}),
        }),
        env,
      );
      expect(response.status, `${method} ${url}`).toBe(404);
    }
  });
});

/**
 * SABOTAGE: let the handler fall through to `env.AI.run` when the binding is
 * absent and the Worker throws a `TypeError` instead — which Cloudflare surfaces
 * as a generic "worker script threw an exception" with no cause anywhere, the
 * exact failure shape `deploy-email-worker.yml`'s header records hours lost to.
 */
describe("a deployment with no Workers AI binding", () => {
  it("says so, in the one string CI greps for", async () => {
    const response = await handleRequest(post({ audioBase64: AUDIO, mimeType: "audio/webm" }), {
      TRANSCRIBE_WORKER_SECRET: SECRET,
    } as Env);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "workers ai is not bound" });
  });
});

describe("the body", () => {
  it("413s audio over the cap, before the engine is asked", async () => {
    const ai = fakeAi(TIMED_ANSWER);
    const oversized = Buffer.from(new Uint8Array(MAX_AUDIO_BYTES + 1)).toString("base64");
    const response = await handleRequest(
      post({ audioBase64: oversized, mimeType: "audio/webm" }),
      envWith(ai.binding),
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: "audio chunk too large",
      maxBytes: MAX_AUDIO_BYTES,
    });
    expect(ai.calls).toEqual([]);
  });

  it("400s a body that is not the documented shape", async () => {
    const env = envWith(fakeAi(TIMED_ANSWER).binding);
    for (const body of ["not json", {}, { audioBase64: AUDIO }, { mimeType: "audio/webm" }]) {
      const response = await handleRequest(post(body), env);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid request body" });
    }
  });
});

/**
 * SABOTAGE: pass the decoded bytes to the binding instead of the base64 string
 * and "asks the turbo model for the audio it was given" goes RED — which is the
 * only place the call's actual shape is pinned, the binding being mocked
 * everywhere else.
 */
describe("transcribing a chunk", () => {
  it("asks the turbo model for the audio it was given, and maps the timings", async () => {
    const ai = fakeAi(TIMED_ANSWER);
    const response = await handleRequest(
      post({ audioBase64: AUDIO, mimeType: "audio/webm" }),
      envWith(ai.binding),
    );
    expect(response.status).toBe(200);
    expect(ai.calls).toEqual([{ model: TURBO_MODEL, input: { audio: AUDIO } }]);
    expect(await response.json()).toEqual({
      text: "Morning.",
      segments: [{ startMs: 0, endMs: 1500, text: "Morning.", confidence: null }],
    });
  });

  it("emits one segment with a null confidence when the engine gives a flat string", async () => {
    const ai = fakeAi({ text: "hello there" });
    const response = await handleRequest(
      post({ audioBase64: AUDIO, mimeType: "audio/webm", durationMs: 12_000 }),
      envWith(ai.binding),
    );
    expect(await response.json()).toEqual({
      text: "hello there",
      segments: [{ startMs: 0, endMs: 12_000, text: "hello there", confidence: null }],
    });
  });

  it("falls back to the older model only when the turbo one does not exist", async () => {
    const ai = fakeAi((model: string) =>
      model === TURBO_MODEL ? new Error("No such model") : { text: "from the old one" },
    );
    const response = await handleRequest(
      post({ audioBase64: AUDIO, mimeType: "audio/webm" }),
      envWith(ai.binding),
    );
    expect(response.status).toBe(200);
    expect(ai.calls.map((call) => call.model)).toEqual([TURBO_MODEL, FALLBACK_MODEL]);
  });

  it("does not retry an ordinary engine failure on a second model", async () => {
    // Retrying everything would turn one transient turbo outage into a silent,
    // permanent downgrade to the worse model — invisible, because both answer.
    const ai = fakeAi(new Error("capacity exceeded"));
    const response = await handleRequest(
      post({ audioBase64: AUDIO, mimeType: "audio/webm" }),
      envWith(ai.binding),
    );
    expect(response.status).toBe(502);
    expect(ai.calls.map((call) => call.model)).toEqual([TURBO_MODEL]);
  });

  it("502s an unreadable engine answer rather than returning an empty transcript", async () => {
    const response = await handleRequest(
      post({ audioBase64: AUDIO, mimeType: "audio/webm" }),
      envWith(fakeAi("just a string").binding),
    );
    expect(response.status).toBe(502);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      error: expect.stringContaining("engine"),
    });
  });
});

/**
 * THE RULE THIS WORKER EXISTS UNDER.
 *
 * SABOTAGE: interpolate the caught error's own `message` into the 502 body, or
 * add the request body to the log line, and both tests below go RED. That is
 * not a hypothetical edit — it is the obvious one to make while debugging a
 * 502, which is exactly why the invariant is pinned rather than trusted.
 */
describe("audio never leaves this process", () => {
  it("keeps the audio out of a 502, even when the engine throws it back", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => void logs.push(args.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...args) => void logs.push(args.join(" ")));

    // An engine that echoes its input into the error message. Real upstreams do
    // this — a validation error quoting the payload is ordinary — so the
    // defence cannot be "engines do not do that".
    const ai = fakeAi(new Error(`upstream rejected payload: {"audio":"${AUDIO}"}`));
    const response = await handleRequest(
      post({ audioBase64: AUDIO, mimeType: "audio/webm" }),
      envWith(ai.binding),
    );

    expect(response.status).toBe(502);
    const body = await response.text();
    expect(body).not.toContain(AUDIO);
    // Not just the whole string: a truncated error message would leak a prefix.
    expect(body).not.toContain(AUDIO.slice(0, 24));
    expect(body).toContain("engine");
    for (const line of logs) {
      expect(line).not.toContain(AUDIO.slice(0, 24));
    }
  });

  it("keeps the audio out of the log on the path that succeeds", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => void logs.push(args.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...args) => void logs.push(args.join(" ")));

    await handleRequest(
      post({ audioBase64: AUDIO, mimeType: "audio/webm" }),
      envWith(fakeAi(TIMED_ANSWER).binding),
    );

    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) {
      expect(line).not.toContain(AUDIO.slice(0, 24));
      // The transcript is note content too, and a log aggregator is not the
      // customer's bucket. Byte counts and a model name are all this may carry.
      expect(line).not.toContain("Morning");
      // And a mime type is caller-supplied text, so it never reaches a log
      // either — the closed field set in `log()` is what makes that structural.
      expect(line).not.toContain("audio/webm");
    }
  });

  it("holds no state between requests", async () => {
    // No KV, no R2, no D1, no module-level mutable anything. Two identical
    // requests are independent, and nothing about the first is visible in the
    // second — which is what "the recording is not the artifact" means when the
    // component is a Worker rather than a note renderer.
    const env = envWith(fakeAi(TIMED_ANSWER).binding);
    const first = await handleRequest(post({ audioBase64: AUDIO, mimeType: "audio/webm" }), env);
    const second = await handleRequest(post({ audioBase64: AUDIO, mimeType: "audio/webm" }), env);
    expect(await first.json()).toEqual(await second.json());
  });
});
