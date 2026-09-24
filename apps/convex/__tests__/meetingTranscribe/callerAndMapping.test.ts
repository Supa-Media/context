import { describe, expect, test, vi } from "vitest";
import { api } from "../../_generated/api";
import {
  CALLER_HMAC_CONTEXT,
  MAX_CHUNK_ID_LENGTH,
  callerHash,
} from "../../functions/meetings/transcribe";
import {
  asUser,
  captureError,
  createUser,
  errorCode,
  setupTest,
  type TestConvex,
} from "../fixtures.helpers";
import {
  WORKER_URL,
  WORKER_SECRET,
  CHUNK,
  stubWorker,
  workerReturning,
  configureWorker,
  transcribe,
} from "./fixtures.helpers";

describe("who the worker is told is asking", () => {
  /**
   * The identifier, computed independently of the implementation.
   *
   * `node:crypto` rather than the exported helper on purpose: this is the
   * recomputation path an operator would follow from a Worker log line back to
   * an account, written out in full so that it is checked rather than merely
   * documented. If this and `callerHash` ever disagree, the documented
   * procedure is the one that is right.
   */
  async function recompute(userId: string, secret: string): Promise<string> {
    const { createHmac } = await import("node:crypto");
    return createHmac("sha256", secret)
      .update(`${CALLER_HMAC_CONTEXT}${userId}`)
      .digest("hex");
  }

  /** One chunk from a named user, returning what the worker was sent. */
  async function transcribeAs(t: TestConvex, email: string) {
    const userId = await createUser(t, email);
    const requests = workerReturning([{ startMs: 0, endMs: 10, text: "ok" }]);
    await asUser(t, userId).action(api.functions.meetings.transcribe.transcribeChunk, CHUNK);
    return { userId: String(userId), requests };
  }

  /**
   * Sabotage: drop the header from the fetch.
   *
   * The worker then has nothing to key a limit by and nothing to name in a log,
   * which is the finding exactly — and it fails closed there, so this also
   * stops transcription rather than silently un-limiting it.
   */
  test("sends an opaque caller identifier the worker can key a limit by", async () => {
    const t = setupTest();
    configureWorker();
    const { userId, requests } = await transcribeAs(t, "spender@example.invalid");

    const sent = requests[0].headers["x-caller-hash"];
    expect(sent).toBe(await recompute(userId, WORKER_SECRET));
    // Fixed width, lowercase hex: the shape the worker's `readCaller` bounds
    // its rate-limit key to.
    expect(sent).toMatch(/^[0-9a-f]{64}$/);
  });

  /**
   * Sabotage: send `userId` itself, or `hashToken(userId)`.
   *
   * A raw id hands the worker — and anyone who reads its logs, and anyone who
   * intercepts the header — an account identifier it has no need for. A plain
   * digest is barely better: anybody holding a user id can confirm a guess
   * against it, because there is no secret in the construction. The HMAC is
   * what makes it opaque to everyone except the party that already holds the
   * secret AND the users table, which is this control plane.
   */
  test("never sends the user id, in the header, the body, or the URL", async () => {
    const t = setupTest();
    configureWorker();
    const { userId, requests } = await transcribeAs(t, "private@example.invalid");

    const everything = JSON.stringify(requests[0]);
    expect(everything).not.toContain(userId);
    expect(requests[0].url).not.toContain(userId);
    // And the body is still exactly what it was: the audio, its type, its
    // length. The identifier is a header because the worker must be able to
    // refuse BEFORE it reads 8 MiB, and a body field could not do that.
    expect(Object.keys(requests[0].body as object).sort()).toEqual([
      "audioBase64",
      "durationMs",
      "mimeType",
    ]);
  });

  /**
   * Sabotage: derive it from anything per-request — the chunk id, a timestamp,
   * `crypto.randomUUID()`.
   *
   * A key that changes per call is a fresh bucket per call, which is no limit
   * at all, and the suite would otherwise stay green: every other assertion
   * here is about one request.
   */
  test("is the same for the same account on every call", async () => {
    const t = setupTest();
    configureWorker();
    const userId = await createUser(t, "steady@example.invalid");
    const caller = await asUser(t, userId);
    const requests = workerReturning([{ startMs: 0, endMs: 10, text: "ok" }]);

    await caller.action(api.functions.meetings.transcribe.transcribeChunk, CHUNK);
    await caller.action(api.functions.meetings.transcribe.transcribeChunk, {
      ...CHUNK,
      chunkId: "chunk-00000000-0000-4000-8000-000000000000-4",
      offsetMs: 200_000,
    });

    expect(requests).toHaveLength(2);
    expect(requests[0].headers["x-caller-hash"]).toBe(requests[1].headers["x-caller-hash"]);
  });

  /**
   * Sabotage: key it on a constant.
   *
   * One bucket for the whole product: the first abuser locks every customer
   * out, and the log names nobody. Caught here and nowhere else, because a
   * constant is perfectly stable and the test above would pass.
   */
  test("is different for a different account", async () => {
    const t = setupTest();
    configureWorker();
    const first = await transcribeAs(t, "one@example.invalid");
    const second = await transcribeAs(t, "two@example.invalid");

    expect(first.requests[0].headers["x-caller-hash"]).not.toBe(
      second.requests[0].headers["x-caller-hash"],
    );
  });

  /**
   * Sabotage: key the HMAC with a constant, or with the URL.
   *
   * The secret is what makes the identifier unguessable to anyone who does not
   * already hold it. Two deployments sharing a construction but not a secret
   * must not produce the same identifier for the same person either.
   */
  test("is keyed by the worker secret, so it is not derivable without it", async () => {
    const t = setupTest();
    const userId = await createUser(t, "keyed@example.invalid");
    const caller = await asUser(t, userId);

    vi.stubEnv("TRANSCRIBE_WORKER_URL", WORKER_URL);
    vi.stubEnv("TRANSCRIBE_WORKER_SECRET", WORKER_SECRET);
    const first = workerReturning([{ startMs: 0, endMs: 10, text: "ok" }]);
    await caller.action(api.functions.meetings.transcribe.transcribeChunk, CHUNK);

    vi.stubEnv("TRANSCRIBE_WORKER_SECRET", `${WORKER_SECRET}-rotated`);
    const second = workerReturning([{ startMs: 0, endMs: 10, text: "ok" }]);
    await caller.action(api.functions.meetings.transcribe.transcribeChunk, CHUNK);

    expect(first[0].headers["x-caller-hash"]).not.toBe(second[0].headers["x-caller-hash"]);
    expect(second[0].headers["x-caller-hash"]).toBe(
      await recompute(String(userId), `${WORKER_SECRET}-rotated`),
    );
  });

  /**
   * Sabotage: drop the domain-separation prefix.
   *
   * The same secret authorizes the request in the `Authorization` header. An
   * HMAC over a bare user id under that key is one construction away from
   * whatever the next thing signed with it is, and a signature that could be
   * mistaken for another signature is how two protocols become one.
   */
  test("is domain-separated, so it cannot be confused with another use of the secret", async () => {
    expect(CALLER_HMAC_CONTEXT).toContain("transcribe");
    expect(CALLER_HMAC_CONTEXT).toMatch(/v1/);
    const t = setupTest();
    configureWorker();
    const { userId, requests } = await transcribeAs(t, "separated@example.invalid");
    const { createHmac } = await import("node:crypto");
    const undomained = createHmac("sha256", WORKER_SECRET).update(userId).digest("hex");
    expect(requests[0].headers["x-caller-hash"]).not.toBe(undomained);
  });

  test("the exported helper is the documented recomputation, so an operator can invert a log line", async () => {
    // The one function `docs/decisions/meetings.md` tells an operator to run
    // against every user id to find the account behind a Worker log line.
    const identifier = await callerHash("some-user-id", WORKER_SECRET);
    expect(identifier).toBe(await recompute("some-user-id", WORKER_SECRET));
  });

  test("the identifier never reaches a log line here", async () => {
    // It is opaque, not public. The worker logs it because that is where a
    // bill is attributed; this side has no reason to, and a log line naming a
    // caller alongside a chunk id is a fragment of a recording's provenance.
    const t = setupTest();
    configureWorker();
    const lines: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args.map((arg) => String(arg)).join(" "));
      });
    }
    let identifier: string;
    try {
      const { userId } = await transcribeAs(t, "quiet@example.invalid");
      identifier = await recompute(userId, WORKER_SECRET);
      stubWorker(() => new Response("nope", { status: 502 }));
      await captureError(() => transcribe(t));
    } finally {
      vi.restoreAllMocks();
    }
    expect(lines.join("\n")).not.toContain(identifier);
  });
});

/**
 * THE CHUNK ID IS A CLIENT-SUPPLIED STRING THAT BECOMES A SEGMENT ID.
 *
 * The ids this action mints are `${chunkId}-${index}`, and `chunkId` is where that
 * bound belongs: it is this contract's own argument, arriving from a client,
 * and bounding it here is cheaper and more honest than teaching every consumer
 * downstream to distrust what we handed it.
 *
 * Real ids are `<Date.now()>-<index>` (`capture/segments.ts`), so the bound is
 * enormously generous relative to the workload and still refuses the shapes
 * that cause trouble: a megabyte of id in a bucket-bound note, and characters
 * that mean something to a Markdown renderer or a path.
 */
describe("the chunk id a client may send", () => {
  /** Try one chunk id; return the refusal and whether the worker was called. */
  async function withChunkId(chunkId: string) {
    const t = setupTest();
    configureWorker();
    const requests = workerReturning([{ startMs: 0, endMs: 10, text: "ok" }]);
    const error = await captureError(() => transcribe(t, { chunkId }));
    return { error, requests };
  }

  test("accepts the ids the recorders actually mint", async () => {
    for (const chunkId of ["1764500000000-0", "1764500000000-137", CHUNK.chunkId, "a"]) {
      const t = setupTest();
      configureWorker();
      workerReturning([{ startMs: 0, endMs: 10, text: "ok" }]);
      const result = await transcribe(t, { chunkId });
      expect(result.segments[0].id, chunkId).toBe(`${chunkId}-0`);
    }
  });

  /**
   * Sabotage: leave `chunkId` as a bare `v.string()`.
   *
   * An unbounded id is written verbatim into a note in the customer's own
   * bucket, once per segment, by a consumer that does not check.
   */
  test("refuses an id longer than the bound, before spending any inference", async () => {
    const { error, requests } = await withChunkId("a".repeat(MAX_CHUNK_ID_LENGTH + 1));

    expect(errorCode(error)).toBe("INVALID_CHUNK_ID");
    // Before the fetch, like every other refusal here: a check that runs after
    // one has already bought the inference it was meant to refuse.
    expect(requests).toHaveLength(0);
  });

  test("accepts an id exactly at the bound", async () => {
    // The off-by-one in the safe direction is still a bug: it refuses a
    // legitimate client for no reason.
    const t = setupTest();
    configureWorker();
    workerReturning([{ startMs: 0, endMs: 10, text: "ok" }]);
    const chunkId = "a".repeat(MAX_CHUNK_ID_LENGTH);
    const result = await transcribe(t, { chunkId });
    expect(result.segments[0].id).toBe(`${chunkId}-0`);
  });

  test("refuses characters that mean something to a renderer, a path, or a shell", async () => {
    for (const chunkId of [
      "",
      "  ",
      "chunk 1",
      "../../etc/passwd",
      "chunk/1",
      "chunk\n1",
      "chunk ",
      "[link](https://example.invalid)",
      "chunk#1",
      "chunk%2e%2e",
      "<script>",
      "\u202eevil",
    ]) {
      const { error, requests } = await withChunkId(chunkId);
      expect(errorCode(error), JSON.stringify(chunkId)).toBe("INVALID_CHUNK_ID");
      expect(requests, JSON.stringify(chunkId)).toHaveLength(0);
    }
  });

  test("the refusal names the field without quoting what was sent", async () => {
    // The value is caller-supplied text and this message goes back to a client;
    // echoing it is how a refusal becomes a reflection.
    const marker = "\u202ereflected-marker-value";
    const { error } = await withChunkId(marker);
    const message = (error as { data?: { message?: string } })?.data?.message ?? "";
    expect(message.toLowerCase()).toContain("chunk");
    expect(message).not.toContain(marker);
  });

  test("an anonymous caller with a bad chunk id is still just anonymous", async () => {
    // Authentication comes first, always: the shape of an unauthenticated
    // caller's arguments is not something to tell them about.
    const t = setupTest();
    configureWorker();
    const requests = workerReturning([{ startMs: 0, endMs: 10, text: "ok" }]);

    const error = await captureError(() =>
      t.action(api.functions.meetings.transcribe.transcribeChunk, {
        ...CHUNK,
        chunkId: "a".repeat(MAX_CHUNK_ID_LENGTH + 1),
      }),
    );

    expect(errorCode(error)).toBe("NOT_AUTHENTICATED");
    expect(requests).toHaveLength(0);
  });
});

describe("mapping the worker's answer", () => {
  /**
   * Sabotage: drop `offsetMs` from the mapping.
   *
   * The worker sees one chunk and times everything from the start of it, so
   * every segment of a forty-minute meeting would claim to be in its first
   * thirty seconds. The transcript would be complete, correctly ordered
   * *within* a chunk, and wrong everywhere — and a flag, whose whole job per
   * `docs/decisions/meetings.md` is to land on the right sentence, would land
   * on nothing.
   */
  test("chunk-relative times are offset by where the chunk begins", async () => {
    const t = setupTest();
    configureWorker();
    workerReturning([
      { startMs: 0, endMs: 1_500, text: "first" },
      { startMs: 1_500, endMs: 4_250, text: "second" },
    ]);

    const { segments } = await transcribe(t, { offsetMs: 180_000 });

    expect(segments.map((segment) => [segment.startMs, segment.endMs])).toEqual([
      [180_000, 181_500],
      [181_500, 184_250],
    ]);
  });

  test("an offset of zero leaves the worker's own times alone", async () => {
    const t = setupTest();
    configureWorker();
    workerReturning([{ startMs: 40, endMs: 900, text: "first" }]);

    const { segments } = await transcribe(t, { offsetMs: 0 });

    expect(segments[0].startMs).toBe(40);
    expect(segments[0].endMs).toBe(900);
  });

  /**
   * Sabotage: `Math.min(segment.endMs, args.durationMs)`.
   *
   * Measured: with only the argument's doc comment forbidding it, clamping
   * passed all 29 tests in this file. `durationMs` is now forwarded to the
   * worker, and forwarding it is one keystroke away from using it here — so
   * the rule that it may not trim a time the engine stated is a check rather
   * than a paragraph.
   *
   * A segment running past the end of its chunk is a fact about the
   * transcription: Whisper pads, and a word straddling a rotation boundary is
   * timed past it. Trimming it would be this action editing somebody's meeting
   * to make its own arithmetic tidier.
   */
  test("a segment that runs past the end of its chunk is not trimmed to fit", async () => {
    const t = setupTest();
    configureWorker();
    workerReturning([{ startMs: 29_500, endMs: 31_200, text: "over the edge" }]);

    const { segments } = await transcribe(t, { offsetMs: 60_000, durationMs: 30_000 });

    expect(segments[0].endMs).toBe(91_200);
  });

  test("every segment is a mic segment with no speaker", async () => {
    const t = setupTest();
    configureWorker();
    workerReturning([
      { startMs: 0, endMs: 10, text: "one" },
      { startMs: 10, endMs: 20, text: "two" },
    ]);

    const { segments } = await transcribe(t);

    // Sabotage: fill `speaker` in with "Speaker 1". Whisper does no
    // diarization, and `docs/meetings/roadmap.md` is explicit that a label
    // must never be presented with more confidence than it has earned.
    expect(segments.every((segment) => segment.speaker === null)).toBe(true);
    expect(segments.every((segment) => segment.channel === "mic")).toBe(true);
  });

  test("confidence is passed through untouched, including when it is absent", async () => {
    const t = setupTest();
    configureWorker();
    workerReturning([
      { startMs: 0, endMs: 10, text: "certain", confidence: 0.98 },
      { startMs: 10, endMs: 20, text: "unsure", confidence: 0 },
      { startMs: 20, endMs: 30, text: "unknown", confidence: null },
      { startMs: 30, endMs: 40, text: "unsaid" },
    ]);

    const { segments } = await transcribe(t);

    // `0` is a real confidence and must survive; a missing one is `null` and
    // must not become `1`, or `0`, or anything else we made up.
    expect(segments.map((segment) => segment.confidence)).toEqual([0.98, 0, null, null]);
  });
});

