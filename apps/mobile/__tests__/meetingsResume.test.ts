import { describe, expect, test } from "@jest/globals";

import { ConvexError } from "convex/values";

import { MEETING_WRITE_SENTENCES, createConvexGateway } from "../features/meetings/convexGateway";
import { MeetingsController } from "../features/meetings/controller";
import { fakeGateway, type FakeGateway } from "../features/meetings/fakeGateway";
import { fakeRecorder } from "../features/meetings/capture/fake";
import { memoryStore, type KeyValueStore } from "../features/offline/memory";
import { ERRORS, PROTOCOL_VERSION, type MeetingSession } from "../features/meetings/protocol";
import {
  emptyAck,
  parseContinuation,
  type MeetingContinuation,
  type MeetingRecord,
} from "../features/meetings/record";
import {
  RESUME_BAR_WINDOW_MS,
  continuationFromNote,
  continuationFromRecord,
  destinationForNote,
  mayResume,
  resumeBarOffer,
} from "../features/meetings/resume";
import { seedSession } from "../features/meetings/session";
import { parseMeetingNote, renderMeetingNote } from "@context/meetings/note";

/**
 * A MEETING PICKED BACK UP, FROM THE PHONE'S SIDE.
 *
 * The splice itself — what a resumed part does to the note's text — is
 * `packages/meetings/test/continuation.test.mjs`. What is checked here is
 * everything around it on this app's side: the writer reading the note it is
 * about to add to and writing it back conditionally, the recorder carrying
 * `continues` from the press to the finalize, and the one set of rules every
 * surface asks before it offers Resume (`resume.ts`).
 *
 * ## Sabotage record
 *
 * Each applied, this file run, reverted:
 *
 *  1. `continueInto` wrote without `expectedEtag`.
 *     → 5 failed, led by `the part lands in the same note`: without the etag
 *     the write is create-only, and the note is already there.
 *  2. `continueInto` skipped the `continuesMeetingNote` check.
 *     → `a retry whose answer was lost does not add the part twice` failed.
 *  3. `continueInto` treated `CONFLICT` as a failure rather than reading again.
 *     → 2 failed, led by `somebody typing into the note mid-save is kept`.
 *  4. `continueInto` spliced into whatever was at the path, without comparing
 *     meeting ids.
 *     → `a different meeting at that path is never spliced into` failed.
 *  5. `mayResume` ignored a part still in flight.
 *     → `not while a part of the same meeting is still on its way` failed.
 *  6. `latestLandedPart` kept the first part it met rather than the newest.
 *     → `a third part continues from the end of the second, not the first`
 *     failed.
 *  7. The controller's event fold stopped carrying `continues`.
 *     → `resuming records a new part that is written into the first part's
 *     note` failed. This one was found by that test, not planted: the first
 *     version of this feature had exactly this bug.
 */

const STARTED = "2026-09-06T18:00:00.000Z";
const FIRST_ID = "mtg_abcdefghjkmnpqrstvwx";
const PART_ID = "mtg_bcdefghjkmnpqrstvwxy";
const PATH = "1-projects/launch/2026-09-06-design-review-mnpqrstv.md";

function session(over: Partial<MeetingSession> = {}): MeetingSession {
  return {
    ...seedSession({
      id: FIRST_ID,
      version: PROTOCOL_VERSION,
      title: "Design review",
      startedAt: STARTED,
      source: { kind: "in-person" },
      device: { platform: "ios", name: "a phone" },
      transcription: "on-device",
    }),
    ...over,
  };
}

/** The first part, as it landed: a note in the bucket. */
function firstNote(): string {
  return renderMeetingNote(
    {
      ...session({
        state: "complete",
        notes: "- pricing page",
        endedAt: "2026-09-06T18:30:00.000Z",
        recordedMs: 30 * 60_000,
      }),
      notePath: PATH,
    },
    { now: "2026-09-06T18:31:00.000Z" },
  );
}

/** The second part, stopped and waiting to be written. */
function part(over: Partial<MeetingSession> = {}): MeetingSession {
  return session({
    id: PART_ID,
    startedAt: "2026-09-06T18:48:00.000Z",
    endedAt: "2026-09-06T18:52:00.000Z",
    recordedMs: 4 * 60_000,
    state: "finalizing",
    notes: "- dates: 14th to 16th",
    ...over,
  });
}

const CONTINUES: MeetingContinuation = {
  path: PATH,
  meetingId: FIRST_ID,
  offsetMs: 30 * 60_000,
  previousEndedAt: "2026-09-06T18:30:00.000Z",
  part: 2,
};

function refusal(code: string): ConvexError<{ code: string; message: string }> {
  return new ConvexError({ code, message: "server prose" });
}

/**
 * One note in a bucket, with an etag that moves on every write, and a way to
 * have somebody else write to it between a read and a write.
 */
function bucket(initial: string | null = firstNote(), options: { encrypted?: boolean } = {}) {
  let text = initial;
  let version = 1;
  const writes: Array<{ path: string; text: string; expectedEtag?: string }> = [];
  let interleave: Array<(current: string) => string> = [];
  const readNote = async (args: { workspaceId: string; path: string }) => {
    if (text === null || args.path !== PATH) throw refusal("FILE_NOT_FOUND");
    return { path: PATH, text, etag: `v${version}`, encrypted: options.encrypted };
  };
  const writeNote = async (args: {
    workspaceId: string;
    path: string;
    text: string;
    expectedEtag?: string;
  }) => {
    writes.push({ path: args.path, text: args.text, expectedEtag: args.expectedEtag });
    const typed = interleave.shift();
    if (typed !== undefined && text !== null) {
      // Somebody saved the note between this writer's read and its write.
      text = typed(text);
      version += 1;
    }
    if (args.expectedEtag !== undefined && args.expectedEtag !== `v${version}`) {
      throw refusal("CONFLICT");
    }
    if (args.expectedEtag === undefined && args.path === PATH && text !== null) {
      throw refusal("CONFLICT");
    }
    if (args.path === PATH) {
      text = args.text;
      version += 1;
    }
    return { path: args.path };
  };
  return {
    readNote,
    writeNote,
    writes,
    text: () => text,
    /** Each call makes one future write find the note changed under it. */
    typeBeforeNextWrite: (edit: (current: string) => string) => {
      interleave = [...interleave, edit];
    },
  };
}

function writer(store = bucket(), withRead = true) {
  const gateway = createConvexGateway({
    writeNote: store.writeNote,
    ...(withRead ? { readNote: store.readNote } : {}),
    resolveWorkspaceId: () => "ws-1",
    now: () => "2026-09-06T18:53:00.000Z",
  });
  return { gateway, store };
}

/* -------------------------------------------------------------------------- */

describe("the phone's writer adds a resumed part to the note it continues", () => {
  test("the part lands in the same note, and the ack says so", async () => {
    const { gateway, store } = writer();
    const ack = await gateway.finalize(null, part(), CONTINUES);

    expect(ack.notePath).toBe(PATH);
    expect(ack.state).toBe("complete");
    const parsed = parseMeetingNote(store.text()!);
    expect(parsed.frontmatter["meeting-id"]).toBe(FIRST_ID);
    expect(parsed.notes).toBe("- pricing page\n\n- dates: 14th to 16th");
    expect(parsed.transcript).toContain("_Resumed 2026-09-06 18:48:00 UTC");
  });

  test("the part is written back over the version that was read", async () => {
    const { gateway, store } = writer();
    await gateway.finalize(null, part(), CONTINUES);
    expect(store.writes).toHaveLength(1);
    expect(store.writes[0]!.expectedEtag).toBe("v1");
  });

  test("an edit made to the note before the part is kept", async () => {
    const store = bucket(firstNote().replace("# Design review", "# Design review with vendor"));
    const { gateway } = writer(store);
    await gateway.finalize(null, part(), CONTINUES);
    expect(parseMeetingNote(store.text()!).title).toBe("Design review with vendor");
  });

  test("a retry whose answer was lost does not add the part twice", async () => {
    const { gateway, store } = writer();
    await gateway.finalize(null, part(), CONTINUES);
    const once = store.text();

    const again = await gateway.finalize(null, part(), CONTINUES);
    expect(again.notePath).toBe(PATH);
    expect(store.text()).toBe(once);
    expect(store.writes).toHaveLength(1);
  });

  test("somebody typing into the note mid-save is kept, not overwritten", async () => {
    const { gateway, store } = writer();
    store.typeBeforeNextWrite((text) => text.replace("- pricing page", "- pricing page\n- typed meanwhile"));
    const ack = await gateway.finalize(null, part(), CONTINUES);

    expect(ack.notePath).toBe(PATH);
    expect(store.writes).toHaveLength(2);
    const notes = parseMeetingNote(store.text()!).notes;
    expect(notes).toContain("- typed meanwhile");
    expect(notes).toContain("- dates: 14th to 16th");
  });

  test("a note that will not hold still is retried later, with a sentence, not dropped", async () => {
    const { gateway, store } = writer();
    for (let i = 0; i < 5; i += 1) store.typeBeforeNextWrite((text) => `${text}\nmore`);
    await expect(gateway.finalize(null, part(), CONTINUES)).rejects.toMatchObject({
      code: ERRORS.unavailable,
      message: MEETING_WRITE_SENTENCES.noteBusy,
    });
  });

  test("a note that is gone gets the part as a note of its own, create-only", async () => {
    const { gateway, store } = writer(bucket(null));
    const ack = await gateway.finalize(null, part(), CONTINUES);

    expect(ack.notePath).not.toBe(PATH);
    expect(ack.notePath).not.toBeNull();
    const created = store.writes.at(-1)!;
    expect(created.expectedEtag).toBeUndefined();
    expect(parseMeetingNote(created.text).notes).toBe("- dates: 14th to 16th");
  });

  test("a different meeting at that path is never spliced into", async () => {
    const other = firstNote().replace(`meeting-id: ${FIRST_ID}`, "meeting-id: mtg_zzzzzzzzzzzzzzzzzzzz");
    const { gateway, store } = writer(bucket(other));
    const ack = await gateway.finalize(null, part(), CONTINUES);

    expect(ack.notePath).not.toBe(PATH);
    expect(store.text()).toBe(other);
  });

  test("an encrypted note is not opened to add to; the part files beside it", async () => {
    const { gateway, store } = writer(bucket(firstNote(), { encrypted: true }));
    const ack = await gateway.finalize(null, part(), CONTINUES);
    expect(ack.notePath).not.toBe(PATH);
    expect(store.writes.every((write) => write.path !== PATH)).toBe(true);
  });

  test("a writer that cannot read says so, and files the part as its own note", async () => {
    const { gateway, store } = writer(bucket(), false);
    expect(gateway.canContinue).toBe(false);
    const ack = await gateway.finalize(null, part(), CONTINUES);
    expect(ack.notePath).not.toBe(PATH);
    expect(store.writes[0]!.expectedEtag).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */

const DEVICE = { platform: "ios" as const, name: "a phone" };

async function controllerWith(gateway: FakeGateway = fakeGateway(), store: KeyValueStore = memoryStore()) {
  const controller = new MeetingsController();
  let now = Date.parse("2026-09-05T18:00:00.000Z");
  await controller.configure({
    workspaceId: "ws-1",
    store,
    gateway,
    recorder: fakeRecorder(),
    device: DEVICE,
    now: () => now,
    persistDebounceMs: 0,
  });
  return {
    controller,
    gateway,
    store,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1));
  await Promise.resolve();
}

async function recordAndStop(h: Awaited<ReturnType<typeof controllerWith>>, title = "Design review") {
  const id = await h.controller.start({ title });
  // Something captured, or the meeting ends `empty` and there is nothing to continue.
  h.controller.setNotes(id, "what I typed");
  h.advance(30 * 60_000);
  await h.controller.end();
  await settle();
  return id;
}

describe("the recorder carries a resumed part from the press to the note", () => {
  test("resuming records a new part that is written into the first part's note", async () => {
    const h = await controllerWith();
    const first = await recordAndStop(h);
    const landed = h.controller.getSnapshot().records.find((r) => r.session.id === first)!;
    expect(landed.session.state).toBe("complete");

    const continues = continuationFromRecord(h.controller.getSnapshot().records, landed)!;
    h.advance(10 * 60_000);
    const second = await h.controller.continueMeeting({ continues, title: "Design review", destination: null });
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(h.controller.getSnapshot().live?.continues).toEqual(continues);

    h.controller.setNotes(second!, "what I typed after the break");
    h.advance(5 * 60_000);
    await h.controller.end();
    await settle();

    expect(h.gateway.continued.get(second!)).toEqual(continues);
    const written = h.controller.getSnapshot().records.find((r) => r.session.id === second)!;
    expect(written.session.notePath).toBe(landed.session.notePath);
  });

  test("the snapshot says whether this device's writer can continue a note", async () => {
    expect((await controllerWith()).controller.getSnapshot().canContinue).toBe(true);
    const desktop = await controllerWith(fakeGateway({ canContinue: false }));
    expect(desktop.controller.getSnapshot().canContinue).toBe(false);
  });

  test("a writer that cannot continue is never asked to", async () => {
    const h = await controllerWith(fakeGateway({ canContinue: false }));
    const first = await recordAndStop(h);
    const landed = h.controller.getSnapshot().records.find((r) => r.session.id === first)!;
    const continues = continuationFromRecord(h.controller.getSnapshot().records, landed)!;
    expect(await h.controller.continueMeeting({ continues, title: "x", destination: null })).toBeNull();
    expect(h.controller.getSnapshot().live).toBeNull();
  });

  test("not while something else is recording", async () => {
    const h = await controllerWith();
    const first = await recordAndStop(h);
    const landed = h.controller.getSnapshot().records.find((r) => r.session.id === first)!;
    const continues = continuationFromRecord(h.controller.getSnapshot().records, landed)!;
    const other = await h.controller.start({ title: "Something else" });

    expect(await h.controller.continueMeeting({ continues, title: "x", destination: null })).toBeNull();
    expect(h.controller.getSnapshot().live?.session.id).toBe(other);
  });

  test("dismissing the bar's offer is remembered across a launch", async () => {
    const store = memoryStore();
    const h = await controllerWith(fakeGateway(), store);
    const first = await recordAndStop(h);
    h.controller.dismissResumeOffer(first);
    await settle();

    const again = await controllerWith(fakeGateway(), store);
    const record = again.controller.getSnapshot().records.find((r) => r.session.id === first);
    expect(record?.resumeDismissed).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */

function record(
  over: Omit<Partial<MeetingRecord>, "session"> & { session?: Partial<MeetingSession> } = {},
): MeetingRecord {
  const { session: sessionOver, ...rest } = over;
  return {
    version: 1,
    workspaceId: "ws-1",
    session: session({
      state: "complete",
      notePath: PATH,
      endedAt: "2026-09-06T18:30:00.000Z",
      recordedMs: 30 * 60_000,
      ...sessionOver,
    }),
    destination: null,
    acked: emptyAck(),
    runningSince: null,
    updatedAt: 0,
    attempts: 0,
    ...rest,
  };
}

const secondPart = record({
  session: {
    id: PART_ID,
    startedAt: "2026-09-06T18:48:00.000Z",
    endedAt: "2026-09-06T18:52:00.000Z",
    recordedMs: 4 * 60_000,
  },
  continues: CONTINUES,
});

describe("the rules every surface asks before it offers Resume", () => {
  const NOW = Date.parse("2026-09-06T18:40:00.000Z");

  test("a saved meeting may be resumed", () => {
    expect(mayResume({ records: [record()], live: null, canContinue: true, meetingId: FIRST_ID })).toBe(true);
  });

  test("not while a part of the same meeting is still on its way", () => {
    const inFlight = record({ session: { ...secondPart.session, state: "finalizing", notePath: null }, continues: CONTINUES });
    expect(
      mayResume({ records: [record(), inFlight], live: null, canContinue: true, meetingId: FIRST_ID }),
    ).toBe(false);
    expect(resumeBarOffer({ records: [inFlight, record()], live: null, canContinue: true, now: NOW })).toBeNull();
  });

  test("a third part continues from the end of the second, not the first", () => {
    const next = continuationFromRecord([record(), secondPart], record())!;
    expect(next.offsetMs).toBe(34 * 60_000);
    expect(next.part).toBe(3);
    expect(next.previousEndedAt).toBe("2026-09-06T18:52:00.000Z");
    expect(next.meetingId).toBe(FIRST_ID);
  });

  test("the bar offers the newest meeting only, and only for a while", () => {
    expect(resumeBarOffer({ records: [record()], live: null, canContinue: true, now: NOW })?.session.id).toBe(FIRST_ID);

    const later = Date.parse("2026-09-06T18:30:00.000Z") + RESUME_BAR_WINDOW_MS + 1;
    expect(resumeBarOffer({ records: [record()], live: null, canContinue: true, now: later })).toBeNull();

    const newer = record({ session: { id: PART_ID, startedAt: "2026-09-06T18:35:00.000Z", state: "empty", notePath: null } });
    expect(resumeBarOffer({ records: [record(), newer], live: null, canContinue: true, now: NOW })).toBeNull();
  });

  test("the bar goes when it is dismissed, and never shows where a writer cannot continue", () => {
    expect(
      resumeBarOffer({ records: [record({ resumeDismissed: true })], live: null, canContinue: true, now: NOW }),
    ).toBeNull();
    expect(resumeBarOffer({ records: [record()], live: null, canContinue: false, now: NOW })).toBeNull();
  });

  test("the note's own offer reads the note, and is absent on any other note", () => {
    const found = continuationFromNote(PATH, firstNote())!;
    expect(found.title).toBe("Design review");
    expect(found.continues).toEqual({
      path: PATH,
      meetingId: FIRST_ID,
      offsetMs: 30 * 60_000,
      previousEndedAt: "2026-09-06T18:30:00.000Z",
      part: 2,
    });
    expect(continuationFromNote("1-projects/list.md", "# Groceries\n\n- eggs\n")).toBeNull();
  });

  test("a part started from a note is addressed to the note's context and folder", () => {
    expect(destinationForNote("@acme", PATH)).toMatchObject({
      contextSlug: "acme",
      folder: "1-projects/launch",
    });
    expect(destinationForNote("acme", "root.md").folder).toBe("");
  });
});

describe("a stored continuation is read back only when it is one", () => {
  test("a valid one survives", () => {
    expect(parseContinuation(CONTINUES)).toEqual(CONTINUES);
  });

  test("anything that could address another note, or no note, is dropped", () => {
    expect(parseContinuation({ ...CONTINUES, path: "../escape.md" })).toBeNull();
    expect(parseContinuation({ ...CONTINUES, path: "1-projects/launch/" })).toBeNull();
    expect(parseContinuation({ ...CONTINUES, meetingId: "not-an-id" })).toBeNull();
    expect(parseContinuation({ ...CONTINUES, offsetMs: -1 })).toBeNull();
    expect(parseContinuation({ ...CONTINUES, part: 1 })).toBeNull();
    expect(parseContinuation({ ...CONTINUES, previousEndedAt: "yesterday-ish" })).toBeNull();
    expect(parseContinuation("1-projects/launch/note.md")).toBeNull();
  });
});
