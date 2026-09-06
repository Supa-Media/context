import { describe, expect, test } from "@jest/globals";
import { ERRORS, PROTOCOL_VERSION } from "../features/meetings/protocol";
import { fakeGateway } from "../features/meetings/fakeGateway";
import { fakeSegment } from "../features/meetings/capture/fake";
import {
  ackStep,
  classifySyncFailure,
  emptyAck,
  isSynced,
  markSyncFailed,
  metadataFingerprint,
  parseRecord,
  pendingSteps,
  retrySync,
  MAX_SYNC_ATTEMPTS,
  type MeetingRecord,
} from "../features/meetings/record";
import { drainMeetings } from "../features/meetings/sync";
import { seedSession } from "../features/meetings/session";
import { createHttpGateway, MeetingGatewayError } from "../features/meetings/gateway";
import type { MeetingEvent, MeetingSession } from "../features/meetings/protocol";

/**
 * Getting a meeting off the device.
 *
 * The cases worth covering are the ones that only ever happen in production —
 * a phone in a pocket for the second half of a meeting, a gateway that refuses
 * the last of four steps, an app relaunched with three meetings waiting — and
 * every one of them is an ordinary test here because the transport is injected
 * (`fakeGateway`) and the clock is an argument. That is `features/offline/sync.ts`'s
 * arrangement and it is the reason this feature's hardest behaviour is not
 * something anybody has to reproduce by hand.
 *
 * The protocol's idempotency claims are **enforced by the fake**, not assumed
 * by it: the same segment id replaces, and a second finalize returns the path
 * it already wrote rather than writing a second note. So a test that re-sends
 * and counts notes is asserting something real.
 */

const SEED = {
  id: "mtg_abcdefghjkmnpqrstv",
  title: "Design review",
  startedAt: "2026-09-05T18:00:00.000Z",
  source: { kind: "in-person" as const },
  device: { platform: "ios" as const },
  transcription: "cloud" as const,
  version: PROTOCOL_VERSION,
};

function record(session: Partial<MeetingSession> = {}): MeetingRecord {
  return {
    version: 1,
    workspaceId: "ws-1",
    session: { ...seedSession(SEED), ...session },
    // Nobody was asked, so the gateway's own default stands. See
    // `MeetingRecord.destination` for why that is `null` and not a guess.
    destination: null,
    acked: emptyAck(),
    runningSince: null,
    updatedAt: 0,
    attempts: 0,
  };
}

const now = () => 1_000;

describe("what still has to be sent, and in what order", () => {
  test("a fresh meeting sends its metadata first", () => {
    // Everything else is addressed under `/meetings/sessions/:id`, so the
    // session has to exist at the gateway before any of it means anything.
    expect(pendingSteps(record())[0]).toEqual({ kind: "session" });
  });

  test("finalize is last, behind the segments it turns into a note", () => {
    const waiting = record({
      state: "finalizing",
      notes: "typed",
      transcript: [fakeSegment("s1", 0, "said")],
    });
    expect(pendingSteps(waiting).map((step) => step.kind)).toEqual([
      "session",
      "segments",
      "notes",
      "finalize",
    ]);
  });

  test("only the segments the gateway does not already hold", () => {
    const waiting = record({ transcript: [fakeSegment("s1", 0, "a"), fakeSegment("s2", 1, "b")] });
    const partly: MeetingRecord = { ...waiting, acked: { ...waiting.acked, segmentIds: ["s1"] } };
    const step = pendingSteps(partly).find((candidate) => candidate.kind === "segments");
    expect(step).toEqual({ kind: "segments", segments: [waiting.session.transcript[1]] });
  });

  test("typing does not re-send the metadata", () => {
    /*
      The reason `metadataFingerprint` names its fields instead of stringifying
      the session: notes and the transcript have their own routes, and folding
      them into the fingerprint would mean a `session` POST on every keystroke.
    */
    const before = record();
    const acked = ackStep(before, { kind: "session" }, now());
    const typed: MeetingRecord = { ...acked, session: { ...acked.session, notes: "hello" } };
    expect(pendingSteps(typed).map((s) => s.kind)).toEqual(["notes"]);
  });

  test("an answer from the gateway is not read back as a local change", () => {
    // `enhanced` and `notePath` are things the gateway tells the client. In the
    // fingerprint they would make every answer look like something to send back.
    const before = ackStep(record(), { kind: "session" }, now());
    const answered: MeetingRecord = {
      ...before,
      session: { ...before.session, enhanced: "## Summary", notePath: "0-inbox/a.md" },
    };
    expect(pendingSteps(answered)).toEqual([]);
  });

  test("a meeting nobody typed into does not POST an empty body", () => {
    // `notes: ""` never acknowledged and `notes: null` acknowledged are the same
    // fact. Treating them as different made every silent meeting spend a round
    // trip on somebody's gateway to say nothing.
    const silent = ackStep(record(), { kind: "session" }, now());
    expect(pendingSteps(silent)).toEqual([]);
  });

  test("deleting everything you typed still syncs the deletion", () => {
    let entry = record({ notes: "what I typed" });
    for (const step of pendingSteps(entry)) entry = ackStep(entry, step, now());
    const cleared: MeetingRecord = { ...entry, session: { ...entry.session, notes: "" } };
    expect(pendingSteps(cleared)).toEqual([{ kind: "notes", markdown: "" }]);
  });

  test("a `complete` meeting is not finalized again", () => {
    const done = record({ state: "complete", notePath: "0-inbox/a.md" });
    expect(pendingSteps(done).some((step) => step.kind === "finalize")).toBe(false);
  });

  test("`isSynced` is `pendingSteps` being empty, and nothing else", () => {
    let entry = record({ notes: "hi" });
    expect(isSynced(entry)).toBe(false);
    for (const step of pendingSteps(entry)) entry = ackStep(entry, step, now());
    expect(isSynced(entry)).toBe(true);
  });

  test("the fingerprint moves when the title does", () => {
    const before = record();
    const renamed = record({ title: "Design review — Portal" });
    expect(metadataFingerprint(before.session)).not.toBe(metadataFingerprint(renamed.session));
  });
});

describe("a drain, end to end", () => {
  test("a whole meeting reaches the gateway and comes back with a path", async () => {
    const gateway = fakeGateway();
    const events: MeetingEvent[] = [];
    const waiting = record({
      state: "finalizing",
      notes: "curiosity is the prerequisite",
      transcript: [fakeSegment("s1", 0, "hello")],
    });

    const { records, report } = await drainMeetings([waiting], {
      gateway,
      now,
      onEvents: (_id, produced) => events.push(...produced),
    });

    expect(report.synced).toEqual([waiting.session.id]);
    expect(gateway.calls).toEqual(["session", "segments", "notes", "finalize"]);
    expect(isSynced(records[0])).toBe(true);
    // The note path arrives as an *event*, folded through the same reducer as
    // everything else. There is no second path by which a session's state moves.
    expect(events).toEqual([
      { type: "written", notePath: `0-inbox/meetings/${waiting.session.id}.md` },
    ]);
  });

  test("the human's own Markdown reaches the gateway unaltered", async () => {
    const gateway = fakeGateway();
    const typed = "  Phil 1:6 — he who began a good work\n\n- James 2:19\n";
    await drainMeetings([record({ notes: typed })], { gateway, now });
    expect(gateway.held.get(SEED.id)?.notes).toBe(typed);
  });
});

describe("a phone in a pocket", () => {
  test("nothing is lost, and the retry sends only what is missing", async () => {
    const gateway = fakeGateway();
    const waiting = record({
      state: "finalizing",
      notes: "typed",
      transcript: [fakeSegment("s1", 0, "a")],
    });

    // The connection dies after the metadata and the segments have landed.
    gateway.offlineFor(0);
    const first = await drainMeetings([waiting], { gateway, now });
    expect(first.report.synced).toEqual([waiting.session.id]);

    // Now the interesting one: a fresh meeting whose third step fails.
    const second = fakeGateway();
    second.failNext(ERRORS.unavailable, "your context could not be reached");
    const partial = await drainMeetings([waiting], { gateway: second, now });
    expect(partial.report.stoppedEarly).toBe(true);
    expect(second.calls).toEqual(["session"]);
    // Nothing acknowledged, nothing lost.
    expect(isSynced(partial.records[0])).toBe(false);

    // When it comes back, the whole meeting goes.
    const resumed = await drainMeetings(partial.records, { gateway: second, now });
    expect(resumed.report.synced).toEqual([waiting.session.id]);
  });

  test("progress inside one meeting is kept when a later step fails", async () => {
    /*
      The property that stops a meeting failing on its last step from
      re-uploading its whole transcript on every reconnection.
    */
    const gateway = fakeGateway();
    const waiting = record({
      state: "finalizing",
      notes: "typed",
      transcript: [fakeSegment("s1", 0, "a"), fakeSegment("s2", 1, "b")],
    });

    // Let session + segments through, refuse the notes.
    const failing = {
      ...gateway,
      putNotes: async () => {
        throw new MeetingGatewayError(ERRORS.unavailable, "gone");
      },
    };
    const { records } = await drainMeetings([waiting], { gateway: failing, now });

    expect(records[0].acked.segmentIds.sort()).toEqual(["s1", "s2"]);
    expect(pendingSteps(records[0]).map((step) => step.kind)).toEqual(["notes", "finalize"]);
  });

  test("re-sending a whole meeting writes one note, not two", async () => {
    // The protocol's own claim, enforced by the fake: "finalize on an
    // already-complete session returns the note path it already wrote rather
    // than writing a second note."
    const gateway = fakeGateway();
    const waiting = record({ state: "finalizing", notes: "typed" });
    await drainMeetings([waiting], { gateway, now });
    await drainMeetings([waiting], { gateway, now });
    expect(gateway.notesWritten()).toBe(1);
  });

  test("a segment sent twice is one utterance in the note", async () => {
    const gateway = fakeGateway();
    const waiting = record({ transcript: [fakeSegment("s1", 0, "hello")] });
    await drainMeetings([waiting], { gateway, now });
    const ack = await gateway.putSegments(waiting.session.id, [fakeSegment("s1", 0, "hello")]);
    expect(ack.segmentCount).toBe(1);
  });
});

describe("a refusal is parked, and an unknown one is parked too", () => {
  test("only `unavailable` and `conflict` are retried", () => {
    expect(classifySyncFailure({ code: ERRORS.unavailable, message: "" }).kind).toBe("failed");
    // The protocol's own instruction for a lost conditional put: "Re-read and
    // retry." Two clients finalizing one meeting are writing the same note from
    // the same log, not two divergent drafts, so this is not a person's
    // decision the way a note conflict is.
    expect(classifySyncFailure({ code: ERRORS.conflict, message: "" }).kind).toBe("failed");
    expect(classifySyncFailure({ code: ERRORS.forbidden, message: "" }).kind).toBe("rejected");
    expect(classifySyncFailure({ code: ERRORS.invalid, message: "" }).kind).toBe("rejected");
  });

  test("a code this build has never heard of parks rather than retrying forever", () => {
    /*
      The allowlist's whole point, and the expensive direction if it were
      inverted: a refusal added to the gateway next year, retried on every
      reconnection against a customer's own quota, for a request that was never
      going to succeed, with nobody able to see it happening.
    */
    expect(classifySyncFailure({ code: "meeting_over_quota", message: "" }).kind).toBe("rejected");
  });

  test("a parked meeting is skipped by later drains until a person says otherwise", async () => {
    const gateway = fakeGateway();
    gateway.failNext(ERRORS.forbidden, "that meeting does not belong to this context");
    const { records, report } = await drainMeetings([record()], { gateway, now });

    expect(report.rejected).toHaveLength(1);
    expect(records[0].rejection?.code).toBe(ERRORS.forbidden);

    const calls = gateway.calls.length;
    await drainMeetings(records, { gateway, now });
    expect(gateway.calls.length).toBe(calls);

    // And one press puts it back.
    const retried = retrySync(records[0]);
    expect(retried.rejection).toBeUndefined();
    const after = await drainMeetings([retried], { gateway, now });
    expect(after.report.synced).toHaveLength(1);
  });

  test("a refusal about one meeting does not stop the others", async () => {
    const gateway = fakeGateway();
    gateway.failNext(ERRORS.invalid, "no");
    const first = record({ id: "mtg_aaaaaaaaaaaaaaaaaaaa", startedAt: "2026-09-05T09:00:00.000Z" });
    const second = record({ id: "mtg_bbbbbbbbbbbbbbbbbbbb", startedAt: "2026-09-05T10:00:00.000Z" });

    const { report } = await drainMeetings([second, first], { gateway, now });
    // Oldest first: the meeting that has been waiting since this morning is the
    // one somebody is missing.
    expect(report.rejected).toEqual([first.session.id]);
    expect(report.synced).toEqual([second.session.id]);
  });

  test("a transient failure stops the drain, because the next one has the same problem", async () => {
    const gateway = fakeGateway();
    gateway.offlineFor(1);
    const first = record({ id: "mtg_aaaaaaaaaaaaaaaaaaaa", startedAt: "2026-09-05T09:00:00.000Z" });
    const second = record({ id: "mtg_bbbbbbbbbbbbbbbbbbbb", startedAt: "2026-09-05T10:00:00.000Z" });

    const { report } = await drainMeetings([first, second], { gateway, now });
    expect(report.stoppedEarly).toBe(true);
    expect(report.synced).toEqual([]);
    // The second was never attempted, so it carries no failure of its own.
    expect(gateway.calls).toEqual(["session"]);
  });

  test("six failed reconnections park a meeting and say so", () => {
    let entry = record();
    for (let attempt = 0; attempt < MAX_SYNC_ATTEMPTS; attempt += 1) {
      entry = markSyncFailed(entry, "gone", now());
    }
    expect(entry.rejection?.code).toBe("RETRIES_EXHAUSTED");
    // Still on the device, with words a person can act on. Nothing is dropped.
    expect(entry.rejection?.message).toContain("still on this device");
    expect(entry.session.notes).toBe(entry.session.notes);
  });

  test("a bug in this app parks rather than retrying", async () => {
    // Not a gateway answer at all — a `TypeError` in a step. Retrying a defect
    // on every reconnection is the failure the allowlist exists to avoid, and
    // it should reach a person as a sentence rather than as silence.
    const broken = {
      ...fakeGateway(),
      putSession: async () => {
        throw new TypeError("undefined is not a function");
      },
    };
    const { records } = await drainMeetings([record()], { gateway: broken, now });
    expect(records[0].rejection?.code).toBe("UNKNOWN");
  });
});

describe("the record on disk", () => {
  test("a record from another version comes back as nothing, not half-parsed", () => {
    const stored = JSON.stringify({ ...record(), version: 99 });
    expect(parseRecord(stored, "ws-1")).toBeNull();
  });

  test("a record belonging to another context is refused", () => {
    // Tenancy, not tidiness: a key mis-filed by a bug must not surface one
    // context's meeting under another's name.
    expect(parseRecord(JSON.stringify(record()), "ws-2")).toBeNull();
  });

  test("nonsense on disk is `null` rather than a throw on launch", () => {
    expect(parseRecord("{not json", "ws-1")).toBeNull();
    expect(parseRecord("null", "ws-1")).toBeNull();
    expect(parseRecord(null, "ws-1")).toBeNull();
  });

  test("a good record round-trips with its acknowledgements", () => {
    const entry = ackStep(record({ notes: "typed" }), { kind: "session" }, now());
    const back = parseRecord(JSON.stringify(entry), "ws-1");
    expect(back?.acked.metadata).toBe(entry.acked.metadata);
    expect(back?.session.notes).toBe("typed");
  });
});

describe("the HTTP client refuses rather than sending an unauthenticated request", () => {
  test("no credential means no request at all", async () => {
    /*
      The one unsettled seam in this feature: which credential the phone
      presents to the gateway is the gateway half's decision. Until there is
      one, the client must not fire a request that will be refused — it keeps
      the meeting on the device and says so.
    */
    let called = false;
    const gateway = createHttpGateway({
      origin: "https://gateway.invalid",
      authorization: async () => null,
      fetchImpl: (async () => {
        called = true;
        return new Response("{}");
      }) as unknown as typeof fetch,
    });

    await expect(gateway.putNotes(SEED.id, "hi")).rejects.toMatchObject({
      code: ERRORS.forbidden,
    });
    expect(called).toBe(false);
  });

  test("the request is built from the protocol's routes", async () => {
    const seen: string[] = [];
    const gateway = createHttpGateway({
      origin: "https://gateway.invalid",
      authorization: async () => "Bearer test-token",
      fetchImpl: (async (url: string) => {
        seen.push(url);
        return new Response(JSON.stringify({ sessionId: SEED.id }), {
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });

    await gateway.finalize(SEED.id, null);
    expect(seen).toEqual([`https://gateway.invalid/meetings/sessions/${SEED.id}/finalize`]);
  });

  test("a status with no body still classifies into one of the protocol's codes", async () => {
    const statuses: Array<[number, string]> = [
      [401, ERRORS.forbidden],
      [409, ERRORS.conflict],
      [503, ERRORS.unavailable],
      [400, ERRORS.invalid],
      // Unknown statuses fall to the code that does *not* retry.
      [418, ERRORS.invalid],
    ];
    for (const [status, code] of statuses) {
      const gateway = createHttpGateway({
        origin: "https://gateway.invalid",
        authorization: async () => "Bearer test-token",
        fetchImpl: (async () => new Response("<html>nope</html>", { status })) as unknown as typeof fetch,
      });
      await expect(gateway.list()).rejects.toMatchObject({ code });
    }
  });

  test("a dropped socket is transient, not a refusal", async () => {
    const gateway = createHttpGateway({
      origin: "https://gateway.invalid",
      authorization: async () => "Bearer test-token",
      fetchImpl: (async () => {
        throw new TypeError("network request failed");
      }) as unknown as typeof fetch,
    });
    await expect(gateway.list()).rejects.toMatchObject({ code: ERRORS.unavailable });
  });
});
