import { describe, expect, test, vi } from "vitest";
import { api } from "../../_generated/api";
import schema from "../../schema";
import {
  MAX_CHUNK_ID_LENGTH,
  TRANSCRIBE_CHUNKS_PER_WINDOW,
  TRANSCRIBE_WINDOW_MS,
  consumeTranscribeBudget,
} from "../../functions/meetings/transcribe";
import { MAX_SEGMENT_ID_CHARS } from "../../../../packages/meetings/src/transcript.js";
import {
  RATE_LIMIT_PERIOD_SECONDS,
  RATE_LIMIT_REQUESTS,
} from "../../../../infra/transcribe-worker/src/rateLimit";
import {
  asUser,
  captureError,
  createUser,
  errorCode,
  setupTest,
  type TestConvex,
} from "../fixtures.helpers";
import {
  WORKER_SECRET,
  AUDIO,
  BUDGET_TABLE,
  CHUNK,
  stubWorker,
  workerReturning,
  configureWorker,
  signedIn,
  transcribe,
} from "./fixtures.helpers";

describe("what one account may spend", () => {
  /** One user, and a worker that answers, for a whole test. */
  async function budgetFixture() {
    const t = setupTest();
    configureWorker();
    const requests = workerReturning([{ startMs: 0, endMs: 10, text: "ok" }]);
    const userId = await createUser(t, "spender@example.invalid");
    const caller = asUser(t, userId);
    let n = 0;
    /** One chunk, with a fresh id so nothing else can be what refused it. */
    const send = (overrides: Partial<typeof CHUNK> = {}) =>
      caller.action(api.functions.meetings.transcribe.transcribeChunk, {
        ...CHUNK,
        chunkId: `chunk-${(n += 1)}`,
        ...overrides,
      });
    return { t, requests, userId, send };
  }

  /** Every `rateLimits` row, which is the only table this path may write. */
  async function limitRows(t: TestConvex) {
    return await t.run(async (ctx) => await ctx.db.query("rateLimits").collect());
  }

  /**
   * Sabotage: make `consumeTranscribeBudget` a `mutation`.
   *
   * A public one is callable by any signed-in client, which means a caller can
   * spend their own budget to nothing and — much worse — that the argument
   * validator below stops being a thing only this file supplies.
   */
  test("the budget mutation is internal, not public", () => {
    const fn = consumeTranscribeBudget as unknown as {
      isInternal?: boolean;
      isPublic?: boolean;
    };
    expect(fn.isInternal).toBe(true);
    expect(fn.isPublic).not.toBe(true);
  });

  /**
   * Sabotage: add any second field to `args` — `audioBase64`, `chunkId`, a
   * "reason" string, anything.
   *
   * This is the enforceable half of the property this branch narrowed. The
   * action holds a `ctx.runMutation` now, so "it is structurally unable to
   * persist a transcript" is no longer true of the *handle*; it is true of the
   * one function that handle can reach, because that function's arguments have
   * no field a transcript fits in. A key set asserted exactly is what stops the
   * next person adding one without meaning anything by it.
   */
  test("the budget mutation cannot be handed content", () => {
    const args = JSON.parse(
      (consumeTranscribeBudget as unknown as { exportArgs: () => string }).exportArgs(),
    ) as { type: string; value: Record<string, { fieldType: { type: string } }> };

    expect(args.type).toBe("object");
    expect(Object.keys(args.value).sort()).toEqual(["userId"]);
    // And it is an id, not a string: there is no free text here at all.
    expect(args.value.userId.fieldType.type).toBe("id");
  });

  /**
   * Sabotage: raise `TRANSCRIBE_CHUNKS_PER_WINDOW` to 200, or stretch
   * `TRANSCRIBE_WINDOW_MS` to an hour.
   *
   * Every other test in this block spends `TRANSCRIBE_CHUNKS_PER_WINDOW` and
   * then one more, so all of them keep passing at any number at all — a limit
   * whose only tests are written in terms of itself is a limit anybody can
   * raise to infinity without a single red line. So the numbers are pinned to
   * the workload the module header reasons about, and to the Worker's own
   * declared ceiling, which `infra/transcribe-worker/src/wranglerConfig.test.ts`
   * in turn pins to `wrangler.jsonc`.
   *
   * That chain is the point: three files now say 20 a minute, and a change to
   * any one of them fails here. The Worker's binding does not enforce, so its
   * number is not doing the work any more — but it is still declared, still
   * deployed, and still what somebody reads first, and two ceilings that
   * disagree is how a justification ends up describing neither.
   */
  test("the ceiling is the one the comment argues for, and the Worker's own", () => {
    // Twenty a minute against a workload of three (a 20s chunk rotation) and
    // six (the same meeting on two devices). See the module header.
    expect(TRANSCRIBE_CHUNKS_PER_WINDOW).toBe(20);
    expect(TRANSCRIBE_WINDOW_MS).toBe(60_000);
    // And the same ceiling the Worker declares, so there are not two numbers.
    expect(TRANSCRIBE_CHUNKS_PER_WINDOW).toBe(RATE_LIMIT_REQUESTS);
    expect(TRANSCRIBE_WINDOW_MS).toBe(RATE_LIMIT_PERIOD_SECONDS * 1000);
    // Headroom over the real two-device workload, stated as an inequality so
    // that lowering it into a user's way is as red as raising it out of use.
    const TWO_DEVICES_PER_MINUTE = 6;
    expect(TRANSCRIBE_CHUNKS_PER_WINDOW).toBeGreaterThanOrEqual(
      TWO_DEVICES_PER_MINUTE * 3,
    );
  });

  /**
   * Sabotage: delete the `ctx.runMutation` from the action, or make
   * `consumeTranscribeBudget` return `{ allowed: true }` unconditionally.
   *
   * Either way this is the test that notices, and it is the only one that
   * notices the *first* of those — every other test in this file passes with no
   * limit at all, which is exactly how #222 shipped.
   */
  test("the call after the limit is refused, and buys no inference", async () => {
    const { requests, send } = await budgetFixture();

    for (let i = 0; i < TRANSCRIBE_CHUNKS_PER_WINDOW; i += 1) await send();
    expect(requests).toHaveLength(TRANSCRIBE_CHUNKS_PER_WINDOW);

    const error = await captureError(send);
    expect(errorCode(error)).toBe("RATE_LIMITED");
    // The refusal happens before the fetch. A ceiling that refuses after the
    // inference is not a ceiling, it is a log line.
    expect(requests).toHaveLength(TRANSCRIBE_CHUNKS_PER_WINDOW);
  });

  /**
   * Sabotage: throw `transcriptionFailed` instead, or drop `retryAfterMs`.
   *
   * `TRANSCRIPTION_FAILED` tells a client the chunk broke and the next one may
   * work, so a client that could not tell the two apart would retry straight
   * back into the limit and report a broken worker while doing it.
   */
  test("the refusal is its own code, and says when to come back", async () => {
    const { send } = await budgetFixture();
    for (let i = 0; i < TRANSCRIBE_CHUNKS_PER_WINDOW; i += 1) await send();

    const error = (await captureError(send)) as {
      data?: { code?: string; message?: string; retryAfterMs?: number | null };
    };
    expect(error.data?.code).toBe("RATE_LIMITED");
    expect(typeof error.data?.retryAfterMs).toBe("number");
    expect(error.data?.retryAfterMs).toBeGreaterThan(0);
    expect(error.data?.retryAfterMs).toBeLessThanOrEqual(TRANSCRIBE_WINDOW_MS);
    // Nothing the caller sent, and nothing about the deployment, comes back.
    expect(error.data?.message ?? "").not.toContain(WORKER_SECRET);
    expect(error.data?.message ?? "").not.toContain(AUDIO);
  });

  /**
   * Sabotage: key the limit by a constant, or by the chunk id.
   *
   * A constant key is one bucket for the whole product — the first person
   * recording a meeting locks everybody else out — and a per-chunk key is a
   * fresh bucket per request, which is no limit at all. Both pass every other
   * test here.
   */
  test("one account's spending does not touch another's", async () => {
    const t = setupTest();
    configureWorker();
    const requests = workerReturning([{ startMs: 0, endMs: 10, text: "ok" }]);

    const spender = asUser(t, await createUser(t, "spender@example.invalid"));
    const bystander = asUser(t, await createUser(t, "bystander@example.invalid"));
    const chunk = (id: string) => ({ ...CHUNK, chunkId: id });

    for (let i = 0; i < TRANSCRIBE_CHUNKS_PER_WINDOW; i += 1) {
      await spender.action(
        api.functions.meetings.transcribe.transcribeChunk,
        chunk(`spender-${i}`),
      );
    }
    const refused = await captureError(() =>
      spender.action(api.functions.meetings.transcribe.transcribeChunk, chunk("spender-x")),
    );
    expect(errorCode(refused)).toBe("RATE_LIMITED");

    // The bystander was recording all along and is untouched.
    const served = await bystander.action(
      api.functions.meetings.transcribe.transcribeChunk,
      chunk("bystander-0"),
    );
    expect(served.segments).toHaveLength(1);
    expect(requests).toHaveLength(TRANSCRIBE_CHUNKS_PER_WINDOW + 1);
  });

  /**
   * Sabotage: make the limit a lifetime cap — drop the window rollover from
   * `consumeRateLimit`, or set `windowMs` to something enormous.
   *
   * A meeting is longer than a minute. Twenty chunks is under seven minutes of
   * recording, so a limit that never rolls over would silently stop
   * transcribing every meeting in the product at the seven-minute mark and
   * produce the half-empty note `capture/audio.ts` calls worse than no feature.
   */
  test("the budget is per window, so a long meeting keeps transcribing", async () => {
    const { send } = await budgetFixture();
    for (let i = 0; i < TRANSCRIBE_CHUNKS_PER_WINDOW; i += 1) await send();
    expect(errorCode(await captureError(send))).toBe("RATE_LIMITED");

    // Only `Date.now` moves: `vi.useFakeTimers` would also stop the timers
    // convex-test runs its scheduler on.
    // A literal minute, deliberately NOT `TRANSCRIBE_WINDOW_MS`: a test that
    // advances its clock by whatever the constant says passes just as happily
    // when the constant is a year, which is the sabotage this exists to catch.
    const ONE_MINUTE_AND_A_BIT = 60_001;
    const realNow = Date.now.bind(Date);
    const clock = vi
      .spyOn(Date, "now")
      .mockImplementation(() => realNow() + ONE_MINUTE_AND_A_BIT);
    try {
      const result = await send();
      expect(result.segments).toHaveLength(1);
    } finally {
      clock.mockRestore();
    }
  });

  /**
   * Sabotage: move the `ctx.runMutation` in front of the `getAuthUserId` check.
   *
   * There is no user id to key by yet at that point, so it would have to be
   * keyed by something shared — and an anonymous caller who can move a counter
   * is an anonymous caller spending somebody's allowance. It also has to write
   * *nothing*: a row per anonymous request is an unauthenticated write.
   */
  test("an anonymous caller spends nobody's budget, and writes nothing", async () => {
    const t = setupTest();
    configureWorker();
    const requests = workerReturning([{ startMs: 0, endMs: 10, text: "ok" }]);

    const error = await captureError(() =>
      t.action(api.functions.meetings.transcribe.transcribeChunk, CHUNK),
    );

    expect(errorCode(error)).toBe("NOT_AUTHENTICATED");
    expect(requests).toHaveLength(0);
    expect(await limitRows(t)).toHaveLength(0);
  });

  /**
   * Sabotage: move the `chunkId` check in front of the budget.
   *
   * `docs/decisions/meetings.md` fixes the order as authenticate → rate limit →
   * validate → call the Worker, and the reason validation goes *after* is that
   * a caller who can make this action do a million cheap refusals a second is
   * still a caller we are paying to serve. A bad chunk id spends budget on
   * purpose.
   */
  test("an over-budget caller is told about the budget, not about their chunk id", async () => {
    const { send, requests } = await budgetFixture();
    for (let i = 0; i < TRANSCRIBE_CHUNKS_PER_WINDOW; i += 1) await send();

    // A chunk id that `CHUNK_ID_PATTERN` refuses, from a caller who is also out
    // of budget. Both refusals apply; only one of them ran first, and this
    // asserts which.
    const overBudgetWithBadId = await captureError(() =>
      send({ chunkId: "a".repeat(MAX_CHUNK_ID_LENGTH + 1) }),
    );
    expect(errorCode(overBudgetWithBadId)).toBe("RATE_LIMITED");
    expect(requests).toHaveLength(TRANSCRIBE_CHUNKS_PER_WINDOW);

    // And the same caller, inside their budget, still gets the chunk-id
    // refusal — so the test above is about ordering rather than about the id
    // check having quietly stopped working.
    const fresh = await budgetFixture();
    const badIdInBudget = await captureError(() =>
      fresh.send({ chunkId: "a".repeat(MAX_CHUNK_ID_LENGTH + 1) }),
    );
    expect(errorCode(badIdInBudget)).toBe("INVALID_CHUNK_ID");
  });

  /**
   * Sabotage: put the caller's email, the chunk id, or the audio in the key.
   *
   * The row survives the request, which is the whole difference between this
   * design and the one it replaced. What is allowed to survive is a counter and
   * an opaque-enough key; nothing about the *content* of the call may.
   */
  test("the row it writes holds a counter and a key, and no part of the call", async () => {
    const { t, send } = await budgetFixture();
    await send();

    const rows = await limitRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(1);
    expect(rows[0].key).toContain("meetings.transcribeChunk:");

    const written = JSON.stringify(rows);
    expect(written).not.toContain(AUDIO);
    expect(written).not.toContain(CHUNK.mimeType);
    expect(written).not.toContain("chunk-1");
  });
});

describe("the audio goes nowhere", () => {
  /** Every table the schema defines, counted. */
  async function tableCounts(t: TestConvex): Promise<Record<string, number>> {
    const tables = Object.keys(schema.tables);
    return await t.run(async (ctx) => {
      const counts: Record<string, number> = {};
      for (const table of tables) {
        counts[table] = (
          await ctx.db.query(table as keyof typeof schema.tables).collect()
        ).length;
      }
      return counts;
    });
  }

  /**
   * Sabotage: add any second `ctx.runMutation` to the handler — an audit row, a
   * usage counter, a "chunks transcribed" tally — or make
   * `consumeTranscribeBudget` write anywhere besides `rateLimits`.
   *
   * **This used to say `no table is written`, and it does not any more.** That
   * assertion was the enforceable form of a property this action has now
   * deliberately given up: it held no `ctx.db`, `ctx.storage`, `ctx.scheduler`
   * or `ctx.runMutation`, so it was *structurally* unable to persist a
   * transcript. The Worker-side rate limit that bought that property does not
   * enforce on this account — measured twice, on two `namespace_id` values,
   * zero 429s — so the ceiling moved here and the action gained exactly one
   * `ctx.runMutation`, to exactly one internal mutation, which writes exactly
   * one table.
   *
   * What replaced the old assertion is stronger everywhere except at that one
   * point. `no table is written` could not tell a first write from a second:
   * once anything wrote, it failed, and once somebody relaxed it to let the
   * counter through it would have had nothing left to say about the row after
   * it. This names the one table that may move, counts every other table in the
   * schema exactly as before, and pins the amount `rateLimits` moves by — so a
   * second write, a wider write, or a write to any other table all fail here.
   *
   * `docs/decisions/meetings.md`: a meetings table would be the second copy
   * non-negotiable 3 exists to prevent, and it would be the copy the privacy
   * engine does not guard.
   */
  test("only `rateLimits` is written, and nothing is scheduled or stored", async () => {
    const t = setupTest();
    configureWorker();
    workerReturning([{ startMs: 0, endMs: 10, text: "something said out loud" }]);

    // The caller exists before the snapshot: `signedIn` inserts a `users` row,
    // and a fixture that moves a count is a fixture that hides the thing this
    // test is looking for.
    const caller = await signedIn(t);
    const before = await tableCounts(t);
    // Named rather than spelled, so a typo cannot make this test vacuous by
    // pointing the exception at a table that does not exist.
    expect(Object.keys(before)).toContain(BUDGET_TABLE);

    await caller.action(api.functions.meetings.transcribe.transcribeChunk, CHUNK);
    const after = await tableCounts(t);

    // One row, in one table, and that row is the ceiling.
    expect(after[BUDGET_TABLE]).toBe(before[BUDGET_TABLE] + 1);
    // Everything else, counted the same way it always was.
    const { [BUDGET_TABLE]: _ignored, ...otherTablesAfter } = after;
    const { [BUDGET_TABLE]: _alsoIgnored, ...otherTablesBefore } = before;
    expect(otherTablesAfter).toEqual(otherTablesBefore);

    const { scheduled, files } = await t.run(async (ctx) => ({
      scheduled: (await ctx.db.system.query("_scheduled_functions").collect()).length,
      files: (await ctx.db.system.query("_storage").collect()).length,
    }));
    // A scheduled write is still a write, one tick later — and file storage is
    // where "just cache the audio for the retry" would land. The budget
    // mutation is awaited inline; nothing here is allowed to be deferred.
    expect(scheduled).toBe(0);
    expect(files).toBe(0);
  });

  /**
   * Sabotage: put `args.audioBase64`, `args.chunkId`, or a returned segment's
   * text into the rate-limit key — or into any row this path can reach.
   *
   * The action is allowed to write one counter now, and a counter is not a
   * place to keep a meeting. This reads back **every document in every table**
   * after a successful transcription and looks for the audio, for any long
   * slice of it, and for the words the worker said — the same breadth as the
   * console sweep beside it, and for the same reason: the row that has to be
   * caught is the one nobody has thought of yet.
   */
  test("no row written anywhere carries the audio or the transcript", async () => {
    const t = setupTest();
    configureWorker();
    const SPOKEN = "something said out loud in a private meeting";
    workerReturning([{ startMs: 0, endMs: 10, text: SPOKEN }]);

    const caller = await signedIn(t);
    await caller.action(api.functions.meetings.transcribe.transcribeChunk, CHUNK);

    const everything = await t.run(async (ctx) => {
      const docs: unknown[] = [];
      for (const table of Object.keys(schema.tables)) {
        docs.push(...(await ctx.db.query(table as keyof typeof schema.tables).collect()));
      }
      return JSON.stringify(docs);
    });

    expect(everything).not.toContain(AUDIO);
    // A slice long enough that it could only have come from the audio: a
    // truncated cache is not a redaction, it is a fragment of the meeting.
    for (let start = 0; start + 16 <= AUDIO.length; start += 8) {
      expect(everything).not.toContain(AUDIO.slice(start, start + 16));
    }
    expect(everything).not.toContain(SPOKEN);
    // And nothing about which chunk of which recording it was, either.
    expect(everything).not.toContain(CHUNK.chunkId);
  });

  /**
   * Sabotage: log the request body, or a "first 32 characters" of it.
   *
   * Every console method, on the success path and on the failure path, because
   * the tempting place to print the audio is the one where something already
   * went wrong. A truncated slice is not a redaction: it is a fragment of the
   * customer's meeting in our logs.
   */
  test("no log line carries the audio, on either path", async () => {
    const t = setupTest();
    configureWorker();
    const lines: string[] = [];
    const record =
      () =>
      (...args: unknown[]) => {
        lines.push(args.map((arg) => String(arg)).join(" "));
      };
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation(record());
    }

    try {
      workerReturning([{ startMs: 0, endMs: 10, text: "something said out loud" }]);
      await transcribe(t);

      stubWorker(() => new Response("nope", { status: 502 }));
      await captureError(() => transcribe(t));
    } finally {
      vi.restoreAllMocks();
    }

    const logged = lines.join("\n");
    expect(logged).not.toContain(AUDIO);
    // A slice long enough that it could only have come from the audio.
    for (let start = 0; start + 16 <= AUDIO.length; start += 8) {
      expect(logged).not.toContain(AUDIO.slice(start, start + 16));
    }
    // The transcript is note content, and the standards say logs never carry
    // it either.
    expect(logged).not.toContain("something said out loud");
  });
});

/**
 * THE TWO ID BOUNDS ARE COUPLED, AND NOTHING ELSE SAYS SO.
 *
 * `MAX_CHUNK_ID_LENGTH` bounds what a client may send here.
 * `MAX_SEGMENT_ID_CHARS` bounds what `normalizeSegment` will merge, over in
 * `packages/meetings`, which has its own test runner and would not notice a
 * change made in this file.
 *
 * The segment ids this action mints are `${chunkId}-${index}`, so the longest
 * one is `MAX_CHUNK_ID_LENGTH` plus a separator plus the index digits. If that
 * ever exceeds `MAX_SEGMENT_ID_CHARS`, every segment from this path is refused
 * at the merge — and refused *silently* from the user's seat, because the ack
 * carries a `rejected` count that no client reads yet. The meeting would simply
 * produce an empty transcript, which `capture/audio.ts` calls the one outcome
 * this feature exists to prevent.
 *
 * So the relationship is asserted rather than described. `segmentsPerRequest` is
 * 1,000, so four index digits is the most a real batch produces; eight is twice
 * that and still leaves the assertion generous.
 */
describe("the chunk id bound and the segment id bound", () => {
  const INDEX_DIGITS = 8;

  test("a chunk id at its own limit still fits inside the segment id limit", () => {
    const longestMintedId = MAX_CHUNK_ID_LENGTH + "-".length + INDEX_DIGITS;
    expect(longestMintedId).toBeLessThanOrEqual(MAX_SEGMENT_ID_CHARS);
  });

  test("and the headroom is real rather than exact, so neither may be raised blind", () => {
    expect(MAX_SEGMENT_ID_CHARS - MAX_CHUNK_ID_LENGTH).toBeGreaterThanOrEqual(32);
  });
});
