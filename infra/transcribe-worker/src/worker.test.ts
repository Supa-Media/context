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
 *     the `isReadableAnswer` guard deleted (the shape it shipped with)
 *         → "refuses an object it can read nothing out of", "502s an object
 *           the engine's shape changed under", and "logs a shape change as a
 *           fault, never as a transcription" (3)
 *     `isReadableAnswer` narrowed to `text` AND `segments`
 *         → seven, including the two flat-answer paths and the fallback
 *           model's words-only answer — the check must not have become
 *           "refuse anything that is not the turbo model's full shape" (7)
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
 *     the bounded read replaced by `await request.json()`
 *         → "413s a body over the cap, without buffering it and without asking
 *            the engine" (1)
 *
 * ── The rate limit, added when the review found there was none ─────────────
 *
 * Twelve more, run the same way and measured rather than expected. The suite
 * was 61 checks before and is 90 after; each line is the count that reddened
 * and nothing else reddened in its place.
 *
 *   src/rateLimit.ts
 *     `catch { return "allowed" }`
 *         → "fails closed when the limiter itself throws", "…when the limiter
 *           rejects", "a limiter that throws refuses…", "tells a broken
 *           limiter apart…" (4)
 *     an absent binding read as `allowed`
 *         → "fails closed when the binding is not there at all", "a binding
 *           removed from wrangler.jsonc refuses too" (2)
 *     `CALLER_PATTERN` widened to `/^[0-9a-f]+$/`
 *         → "refuses an identifier that is not exactly the shape we mint",
 *           "refuses an identifier that is not the shape the control plane
 *           mints" (2)
 *
 *   src/index.ts
 *     a missing identifier bucketed under a constant instead of refused
 *         → "a request with no caller identifier is refused, not bucketed
 *           together" (2)
 *     the `unavailable` verdict treated as `allowed`
 *         → three, including "tells a broken limiter apart from a busy caller"
 *     the limiter keyed on a constant rather than the caller
 *         → "lets a caller under the limit through, keyed by the header it
 *           sent" (1) — and nothing else, which is why that assertion checks
 *           the KEY and not only the status
 *     the limit moved BELOW `readBoundedBody`
 *         → "refuses before the body is read, not after", plus three body
 *           tests (4)
 *     the limit moved ABOVE `isAuthorized`
 *         → "an unauthenticated caller never touches anybody's bucket", plus
 *           both credential tests (3)
 *     `caller` dropped from the `rate_limited` log
 *         → "names the account in the log, because a bill has to be
 *           traceable" (1)
 *     `caller` dropped from the `transcribed` log
 *         → "names the account on the request that SUCCEEDS" (1) — the one
 *           that costs money, and the one a refusal-only log cannot attribute
 *
 *   wrangler.jsonc
 *     `simple.limit` raised to 20000, constants untouched
 *         → "declares exactly the limit rateLimit.ts justifies in prose" (1)
 *     the whole `ratelimits` block deleted
 *         → four in wranglerConfig.test.ts. Nothing in this file: no unit test
 *           can see a wrangler binding, which is the entire reason that file
 *           exists.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleRequest } from "./index";
import { MAX_AUDIO_BYTES, MAX_BODY_BYTES, TURBO_MODEL, FALLBACK_MODEL } from "./transcribe";
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

/**
 * A caller identifier in exactly the shape the control plane mints: hex
 * SHA-256, lowercase. Not derived from anything — this repository is public and
 * a real one would be a fact about an account.
 */
const CALLER = "b3".repeat(32);

/**
 * A rate limiter that always allows, recording the keys it was asked about.
 *
 * The default for every test below that is not *about* the limit, so those
 * tests keep testing what they were written to test. The limit's own behaviour
 * — allowed, refused, and the binding throwing or missing — is `src/
 * rateLimit.test.ts` for the unit and "the rate limit" here for the wiring.
 */
function allowingLimiter() {
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

function envWith(ai: unknown, limiter: unknown = allowingLimiter().binding): Env {
  return { TRANSCRIBE_WORKER_SECRET: SECRET, AI: ai, TRANSCRIBE_RATE_LIMIT: limiter } as Env;
}

/** The headers every legitimate request carries. */
function authHeaders(): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${SECRET}`,
    "x-caller-hash": CALLER,
  };
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://transcribe.invalid/transcribe", {
    method: "POST",
    headers: { ...authHeaders(), ...headers },
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
/**
 * THE LIMIT, WIRED IN. `src/rateLimit.test.ts` proves the unit; this proves the
 * three things about it that are properties of the HANDLER and cannot be seen
 * from the unit at all.
 *
 * Until this existed, a signed-in account was the only thing between a caller
 * and this account's Workers AI budget, and sign-up is open email OTP with no
 * invite gate. Each request may carry 8 MiB of audio.
 *
 * SABOTAGE, each caught by the named test:
 *
 *   move the limit check below `readBoundedBody`
 *       → "refuses before the body is read, not after" (an 8 MiB upload is
 *         buffered for a caller who was never going to be served)
 *   move it above `isAuthorized`
 *       → "an unauthenticated caller never touches anybody's bucket"
 *   treat the `unavailable` verdict as `allowed`
 *       → "a limiter that throws refuses, it does not wave the caller through"
 *   `readCaller(...) ?? "anonymous"`
 *       → "a request with no caller identifier is refused, not bucketed
 *         together"
 *   drop `caller` from the 429 log
 *       → "names the account in the log, because a bill has to be traceable"
 */
describe("the rate limit", () => {
  /** A limiter with a fixed verdict, recording every key it was asked about. */
  function limiterAnswering(success: boolean) {
    const keys: string[] = [];
    return {
      keys,
      binding: {
        limit(options: { key: string }) {
          keys.push(options.key);
          return Promise.resolve({ success });
        },
      },
    };
  }

  /** Every line `log()` wrote during `run`. */
  async function loggedDuring(run: () => Promise<Response>): Promise<{
    response: Response;
    lines: string[];
  }> {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    try {
      return { response: await run(), lines };
    } finally {
      vi.restoreAllMocks();
    }
  }

  it("lets a caller under the limit through, keyed by the header it sent", async () => {
    const ai = fakeAi(TIMED_ANSWER);
    const limiter = limiterAnswering(true);

    const response = await handleRequest(
      post({ audioBase64: AUDIO, mimeType: "audio/webm" }),
      envWith(ai.binding, limiter.binding),
    );

    expect(response.status).toBe(200);
    // Keyed by the caller and by nothing else. A constant key would rate limit
    // the entire product as if it were one account.
    expect(limiter.keys).toEqual([CALLER]);
  });

  it("refuses a caller over the limit with a bare 429, before any inference", async () => {
    const ai = fakeAi(TIMED_ANSWER);

    const response = await handleRequest(
      post({ audioBase64: AUDIO, mimeType: "audio/webm" }),
      envWith(ai.binding, limiterAnswering(false).binding),
    );

    expect(response.status).toBe(429);
    // No body: no retry-after, no remaining count, nothing a caller could
    // shape their traffic around.
    expect(await response.text()).toBe("");
    // The whole point. A refusal that runs after the engine call costs exactly
    // what it was meant to save.
    expect(ai.calls).toEqual([]);
  });

  it("a limiter that throws refuses, it does not wave the caller through", async () => {
    const ai = fakeAi(TIMED_ANSWER);
    const broken = {
      limit(): Promise<{ success: boolean }> {
        throw new Error("rate limiter unavailable");
      },
    };

    const response = await handleRequest(
      post({ audioBase64: AUDIO, mimeType: "audio/webm" }),
      envWith(ai.binding, broken),
    );

    expect(response.status).toBe(429);
    expect(ai.calls).toEqual([]);
  });

  it("a binding removed from wrangler.jsonc refuses too", async () => {
    // `wrangler deploy` succeeds with the block deleted, exactly as it does
    // with Workers AI unprovisioned. Failing open there would restore the
    // finding silently, on a green deploy.
    const ai = fakeAi(TIMED_ANSWER);
    // Built by hand rather than through `envWith`, whose default exists to keep
    // every OTHER test testing what it was written to test — and a default
    // cannot express "the key is not there".
    const env = { TRANSCRIBE_WORKER_SECRET: SECRET, AI: ai.binding } as Env;
    expect(env.TRANSCRIBE_RATE_LIMIT).toBeUndefined();

    const response = await handleRequest(
      post({ audioBase64: AUDIO, mimeType: "audio/webm" }),
      env,
    );

    expect(response.status).toBe(429);
    expect(ai.calls).toEqual([]);
  });

  it("a request with no caller identifier is refused, not bucketed together", async () => {
    // Bucketing every unidentified request under one key would be worse than
    // no limit: one abuser would exhaust the shared bucket and lock out
    // everybody, and the abuser would still be nameless.
    const ai = fakeAi(TIMED_ANSWER);
    const limiter = limiterAnswering(true);
    const request = new Request("https://transcribe.invalid/transcribe", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ audioBase64: AUDIO, mimeType: "audio/webm" }),
    });

    const response = await handleRequest(request, envWith(ai.binding, limiter.binding));

    expect(response.status).toBe(400);
    expect(ai.calls).toEqual([]);
    expect(limiter.keys).toEqual([]);
  });

  it("refuses an identifier that is not the shape the control plane mints", async () => {
    const ai = fakeAi(TIMED_ANSWER);
    const limiter = limiterAnswering(true);

    for (const value of ["", "not-a-hash", "A".repeat(64), "a".repeat(65), "a".repeat(8192)]) {
      const response = await handleRequest(
        post({ audioBase64: AUDIO, mimeType: "audio/webm" }, { "x-caller-hash": value }),
        envWith(ai.binding, limiter.binding),
      );
      expect(response.status, value.slice(0, 16)).toBe(400);
    }
    // An unbounded key is an unbounded string handed to the limiter, and a
    // caller free to vary its key has no limit at all — so neither reaches it.
    expect(limiter.keys).toEqual([]);
    expect(ai.calls).toEqual([]);
  });

  it("refuses before the body is read, not after", async () => {
    // The reason the identifier is a header. A limit that ran after the body
    // would let a refused caller push 8 MiB into the isolate first, which is
    // most of what the request costs us.
    const ai = fakeAi(TIMED_ANSWER);
    let produced = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (produced >= MAX_BODY_BYTES * 3) {
          controller.close();
          return;
        }
        produced += 64 * 1024;
        controller.enqueue(new Uint8Array(64 * 1024).fill(0x61));
      },
    });
    const request = new Request("https://transcribe.invalid/transcribe", {
      method: "POST",
      headers: authHeaders(),
      body,
      duplex: "half",
    } as unknown as RequestInit);

    const response = await handleRequest(
      request,
      envWith(ai.binding, limiterAnswering(false).binding),
    );

    // 429 rather than 413: the refusal happened before anything was measured.
    expect(response.status).toBe(429);
    // One chunk, which is the stream priming itself on construction — the
    // handler never pulled. Move the limit below `readBoundedBody` and this
    // climbs past `MAX_BODY_BYTES`, because the body gets drained to the cap
    // before anybody asks whether this caller was going to be served.
    expect(produced).toBeLessThanOrEqual(64 * 1024);
    expect(ai.calls).toEqual([]);
  });

  it("an unauthenticated caller never touches anybody's bucket", async () => {
    // The limit sits AFTER the credential check on purpose. In front of it, a
    // caller with no secret could spend a stranger's allowance simply by
    // sending their identifier — and identifiers travel in headers.
    const ai = fakeAi(TIMED_ANSWER);
    const limiter = limiterAnswering(true);

    const response = await handleRequest(
      post({ audioBase64: AUDIO, mimeType: "audio/webm" }, { authorization: "Bearer wrong" }),
      envWith(ai.binding, limiter.binding),
    );

    expect(response.status).toBe(401);
    expect(limiter.keys).toEqual([]);
    expect(ai.calls).toEqual([]);
  });

  it("names the account in the log, because a bill has to be traceable", async () => {
    const { response, lines } = await loggedDuring(() =>
      handleRequest(
        post({ audioBase64: AUDIO, mimeType: "audio/webm" }),
        envWith(fakeAi(TIMED_ANSWER).binding, limiterAnswering(false).binding),
      ),
    );

    expect(response.status).toBe(429);
    const refusal = lines.map((line) => JSON.parse(line)).find((l) => l.event === "rate_limited");
    expect(refusal).toBeDefined();
    expect(refusal.caller).toBe(CALLER);
    // The operator's half of the distinction the caller is denied.
    expect(refusal.reason).toBe("over_limit");
  });

  it("tells a broken limiter apart from a busy caller, in the log only", async () => {
    const broken = { limit: () => Promise.reject(new Error("down")) };
    const { response, lines } = await loggedDuring(() =>
      handleRequest(
        post({ audioBase64: AUDIO, mimeType: "audio/webm" }),
        envWith(fakeAi(TIMED_ANSWER).binding, broken),
      ),
    );

    // Identical on the wire — "we are down" is not something to tell a caller.
    expect(response.status).toBe(429);
    expect(await response.text()).toBe("");
    const refusal = lines.map((line) => JSON.parse(line)).find((l) => l.event === "rate_limited");
    // Distinct in the log, because "somebody is hammering us" and "nobody can
    // transcribe" are different pages to wake somebody for.
    expect(refusal.reason).toBe("limiter_unavailable");
  });

  it("names the account on the request that SUCCEEDS, which is the one that costs money", async () => {
    // Logging the identifier only on refusals would attribute nothing: the bill
    // is made of the requests that were served.
    const { response, lines } = await loggedDuring(() =>
      handleRequest(
        post({ audioBase64: AUDIO, mimeType: "audio/webm" }),
        envWith(fakeAi(TIMED_ANSWER).binding),
      ),
    );

    expect(response.status).toBe(200);
    const done = lines.map((line) => JSON.parse(line)).find((l) => l.event === "transcribed");
    expect(done.caller).toBe(CALLER);
  });

  it("never echoes the identifier back to the caller", async () => {
    // It is opaque, not secret — but a response that quotes it back is one more
    // place it turns up, and this Worker quotes nothing back on principle.
    for (const env of [
      envWith(fakeAi(TIMED_ANSWER).binding),
      envWith(fakeAi(TIMED_ANSWER).binding, limiterAnswering(false).binding),
    ]) {
      const response = await handleRequest(post({ audioBase64: AUDIO, mimeType: "audio/webm" }), env);
      expect(await response.text()).not.toContain(CALLER);
    }
  });
});

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
      // Present and allowing, so this test still fails on the AI branch it is
      // about rather than on the limit that now sits in front of it.
      TRANSCRIBE_RATE_LIMIT: allowingLimiter().binding,
    } as Env);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "workers ai is not bound" });
  });
});

/**
 * SABOTAGE: put `body = await request.json()` back and "413s a chunked body
 * that declares no length" goes RED — the isolate buffers and parses whatever
 * an authenticated caller feels like sending, and `MAX_AUDIO_BASE64_CHARS`
 * only gets a say once the string exists.
 */
describe("a body that declares no length", () => {
  /**
   * A POST whose body is a stream, which is what chunked transfer encoding
   * looks like on this side: no `Content-Length` header at all.
   *
   * `duplex: "half"` is required by the fetch spec for a streaming body and is
   * not in `@cloudflare/workers-types`' `RequestInit`, hence the assertion.
   */
  function chunkedPost(totalBytes: number): { request: Request; produced: () => number } {
    const PIECE = 64 * 1024;
    let produced = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (produced >= totalBytes) {
          controller.close();
          return;
        }
        const size = Math.min(PIECE, totalBytes - produced);
        produced += size;
        controller.enqueue(new Uint8Array(size).fill(0x61));
      },
    });
    const request = new Request("https://transcribe.invalid/transcribe", {
      method: "POST",
      headers: authHeaders(),
      body,
      duplex: "half",
    } as unknown as RequestInit);
    return { request, produced: () => produced };
  }

  it("declares no length, which is the hole the old check had", () => {
    // Pinned rather than assumed: the whole finding rests on `Number(null)`
    // being `0` — finite, and not greater than the cap — for this request.
    const { request } = chunkedPost(1024);
    expect(request.headers.get("content-length")).toBeNull();
  });

  it("413s a body over the cap, without buffering it and without asking the engine", async () => {
    const ai = fakeAi(TIMED_ANSWER);
    const { request, produced } = chunkedPost(MAX_BODY_BYTES * 3);

    const response = await handleRequest(request, envWith(ai.binding));

    expect(response.status).toBe(413);
    expect(ai.calls).toEqual([]);
    // The bound is real: the isolate never held the body it refused.
    expect(produced()).toBeLessThan(MAX_BODY_BYTES * 2);
  });

  it("still reads a well-formed chunked body that fits", async () => {
    // The other half: refusing everything with no `Content-Length` would refuse
    // every proxy that re-frames a request, which is most of them.
    const ai = fakeAi(TIMED_ANSWER);
    const encoded = new TextEncoder().encode(
      JSON.stringify({ audioBase64: AUDIO, mimeType: "audio/webm", durationMs: 1500 }),
    );
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let at = 0; at < encoded.length; at += 7) controller.enqueue(encoded.slice(at, at + 7));
        controller.close();
      },
    });
    const request = new Request("https://transcribe.invalid/transcribe", {
      method: "POST",
      headers: authHeaders(),
      body,
      duplex: "half",
    } as unknown as RequestInit);

    const response = await handleRequest(request, envWith(ai.binding));

    expect(response.status).toBe(200);
    expect(ai.calls).toEqual([{ model: TURBO_MODEL, input: { audio: AUDIO } }]);
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

  /**
   * SABOTAGE: let `toTranscription` accept any object again — the guard it
   * shipped with was `typeof raw !== "object"` and nothing more — and both
   * tests below go RED, along with two in transcribe.test.ts.
   *
   * This is the failure worth spelling out, because nothing about it looks like
   * a failure. A Workers AI response-shape change answers 200 with an object
   * this Worker can read nothing out of; the old code turned that into one
   * blank segment; the control plane drops blank segments and returns
   * `segments: []`, which it documents as *the worker listened and heard
   * nothing*. So every meeting in the product transcribes to nothing, `/health`
   * stays green because the binding is still bound, and the logs say
   * `event: "transcribed"`. The audio is gone by then.
   */
  it("502s an object the engine's shape changed under, rather than hearing silence", async () => {
    for (const answer of [
      {},
      { result: { text: "a whole minute of somebody's meeting" } },
      { success: true, errors: [] },
    ]) {
      const ai = fakeAi(answer);
      const response = await handleRequest(
        post({ audioBase64: AUDIO, mimeType: "audio/webm", durationMs: 30_000 }),
        envWith(ai.binding),
      );
      expect(response.status, JSON.stringify(answer)).toBe(502);
      expect((await response.json()) as Record<string, unknown>).toMatchObject({
        error: expect.stringContaining("unreadable"),
      });
    }
  });

  it("logs a shape change as a fault, never as a transcription", async () => {
    // The half a green dashboard is made of. `event: "transcribed", segments:
    // 1` is what the old code emitted for an answer it had read nothing out of,
    // so the one signal an operator would look at agreed that it was working.
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => void logs.push(args.join(" ")));

    await handleRequest(
      post({ audioBase64: AUDIO, mimeType: "audio/webm", durationMs: 30_000 }),
      envWith(fakeAi({}).binding),
    );

    expect(logs.join("\n")).toContain("engine_unreadable");
    expect(logs.join("\n")).not.toContain("transcribed");
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
