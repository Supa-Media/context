import { describe, expect, test } from "@jest/globals";

import {
  meetingLanding,
  meetingNeedsAttention,
  rejectionNotice,
  strandedMeetings,
} from "../features/meetings/landing";
import { emptyAck, type MeetingRecord } from "../features/meetings/record";
import { ERRORS } from "../features/meetings/protocol";

/**
 * What a person is told about a meeting that is not in their bucket, and what
 * they are offered instead.
 *
 * ## The defect this file is the rule for
 *
 * A meeting was recorded, ended, and drawn in the console's Meetings panel
 * under one flat sentence — *"This meeting has not been written to your
 * context yet"* — with nothing beside it. No reason, no Retry, and no way to
 * read the note that was never written. The owner's words were "how do I get
 * it???", which is the correct question and the panel had no answer to it.
 *
 * `MeetingNoteScreen`'s `Landing` already knew all of this: that an `empty`
 * session will never be sent, that a `failed` one is retried by a person, that
 * a refusal is said in words and not as a status code. That knowledge was
 * spelled out in a `.tsx` that imports `expo-router`, so the panel could not
 * reach it — the same module-graph trap `noteLink.ts` was carved out of — and
 * what the panel had instead was a second, worse vocabulary for one state.
 *
 * So the rule lives here, pure, and both surfaces read it. These tests are the
 * rule; the two renderings are checked where they render
 * (`meetingsScreens.test.ts`, `asidePanelRender.test.ts`).
 *
 * ## Why `retry` is part of the answer rather than each screen's guess
 *
 * "Is there anything a person can do about this" is a fact about the record,
 * not about the surface drawing it. A panel that decides for itself is how the
 * console ended up offering nothing for states the note screen has always
 * offered a Retry for.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. `meetingLanding`'s `notePath !== null` guard deleted, so a filed meeting
 *     gets a landing again — the shipped defect, written back in.
 *     → **2 fail**: `has no landing at all` and `even when a later write was
 *     refused`.
 *
 *     I predicted `asidePanelRender.test.ts`'s `a filed meeting keeps its door
 *     to the editor` would go with them, and it does not: the panel reaches
 *     `Stranded` on `noteEditorHref` rather than on this rule, so a filed
 *     meeting with a slug never asks the question. Worth recording, because it
 *     means the panel's own tests cannot stand in for this one — and it is
 *     what sent me looking for the case that *does* reach it, the filed
 *     meeting with no slug, which had no test at all.
 *  2. `empty` given `retry: "sync"` — a Retry over a session with nothing in
 *     it, which retries forever.
 *     → **2 fail**: `is never described as on its way` here, and `a session
 *     that captured nothing is offered no retry of nothing` in the panel.
 */

/* -------------------------------------------------------------------------- */

function record(over: Partial<MeetingRecord> = {}, session: Record<string, unknown> = {}): MeetingRecord {
  return {
    version: 1,
    workspaceId: "ws1",
    session: {
      id: "m1",
      title: "Jhon / Seyi",
      state: "complete",
      startedAt: "2026-09-21T13:25:00.000Z",
      recordedMs: 31 * 60_000,
      attendees: [],
      source: { kind: "unknown" },
      notes: "ship the panel fix",
      transcript: [],
      notePath: null,
      enhanced: null,
      log: [],
      ...session,
    },
    acked: emptyAck(),
    destination: null,
    runningSince: null,
    updatedAt: 0,
    attempts: 0,
    ...over,
  } as MeetingRecord;
}

describe("a meeting whose note is in the bucket", () => {
  test("has no landing at all — it is a file, and the file is the answer", () => {
    expect(meetingLanding(record({}, { notePath: "0-inbox/meetings/a.md" }))).toBeNull();
  });

  test("even when a later write was refused, because a refusal never un-says the path", () => {
    /*
      The defect `Landing`'s own header records: a note that had been in the
      bucket for ten minutes started reading "has not left the device" because
      one later transcript batch was refused. The path decides.
    */
    const stranded = meetingLanding(
      record(
        { rejection: { code: ERRORS.invalid, message: "nope", noticedAt: 0 } },
        { notePath: "0-inbox/meetings/a.md" },
      ),
    );
    expect(stranded).toBeNull();
  });
});

describe("a session that captured nothing", () => {
  test("is never described as on its way, because nothing will ever be sent", () => {
    const landing = meetingLanding(record({}, { state: "empty", emptyReason: "no audio reached the recorder.", notes: "", transcript: [] }));
    expect(landing?.kind).toBe("empty");
    expect(landing?.title).toContain("Nothing was captured");
    expect(landing?.title).toContain("no audio reached the recorder.");
    expect(landing?.retry).toBeNull();
  });

  test("and a refusal that says the same thing is drawn the same way", () => {
    // `NOTHING_CAPTURED` reaching the sync queue is the same fact arriving by
    // a different road — a Retry there is a retry of nothing, forever.
    const landing = meetingLanding(
      record({ rejection: { code: "NOTHING_CAPTURED", message: "There was nothing to write.", noticedAt: 0 } }),
    );
    expect(landing?.kind).toBe("nothing-captured");
    expect(landing?.title).toBe("There was nothing to write.");
    expect(landing?.retry).toBeNull();
  });
});

describe("a meeting the gateway refused", () => {
  test("is said in words a person can act on, never as a status code", () => {
    const landing = meetingLanding(
      record({ rejection: { code: ERRORS.forbidden, message: "gateway answered 403", noticedAt: 0 } }),
    );
    expect(landing?.kind).toBe("refused");
    expect(landing?.title).toBe("This meeting has not left the device");
    expect(landing?.detail).toContain("Connect it again from Settings");
    expect(landing?.detail).not.toContain("403");
  });

  test("and offers the retry that is the whole point of fixing the cause", () => {
    /*
      `retrySync` clears `rejection` on the way through precisely so a person
      who has just reconnected the machine can make the attempt again. Before
      this, the console panel offered them nothing at all.
    */
    const landing = meetingLanding(
      record({ rejection: { code: ERRORS.forbidden, message: "gateway answered 403", noticedAt: 0 } }),
    );
    expect(landing?.retry).toBe("sync");
  });
});

describe("a finalize that did not complete", () => {
  test("names the reason the badge carries and offers the retry the contract allows", () => {
    const landing = meetingLanding(record({}, { state: "failed", failureReason: "the upload timed out." }));
    expect(landing?.kind).toBe("failed");
    expect(landing?.title).toContain("Not filed");
    expect(landing?.title).toContain("the upload timed out.");
    expect(landing?.retry).toBe("finalize");
  });

  test("and still says something when the device recorded no reason", () => {
    const landing = meetingLanding(record({}, { state: "failed" }));
    expect(landing?.title).toContain("the finalize did not complete.");
    expect(landing?.retry).toBe("finalize");
  });
});

describe("a meeting still on its way", () => {
  test("is the only state that promises anything, and it promises sending", () => {
    const landing = meetingLanding(record({}, { state: "finalizing" }));
    expect(landing?.kind).toBe("pending");
    expect(landing?.title).toBe("Not in your bucket yet");
    expect(landing?.detail).toContain("kept on this device");
    expect(landing?.retry).toBeNull();
  });
});

describe("rejectionNotice", () => {
  test("quotes the gateway for a refusal this app has never seen", () => {
    expect(rejectionNotice({ code: "SOMETHING_NEW", message: "the bucket is full." })).toBe(
      "the bucket is full.",
    );
  });

  test("and turns a conflict into the thing to do about it", () => {
    expect(rejectionNotice({ code: ERRORS.conflict, message: "409" })).toContain("Try again");
  });
});

describe("which meetings a person is shouted at about", () => {
  /*
    The rule behind the bar. It is narrow deliberately: a bar that counted
    every meeting without a note would be up during the ordinary seconds after
    every meeting anybody records, and an alert that is always up is furniture.
  */
  test("one still on its way is not a problem — that is the queue working", () => {
    expect(meetingNeedsAttention(record({}, { state: "finalizing" }))).toBe(false);
  });

  test("one already in the bucket is not a problem either", () => {
    expect(meetingNeedsAttention(record({}, { notePath: "0-inbox/meetings/a.md" }))).toBe(false);
  });

  test("a session that captured nothing is not shouted about: nothing was lost", () => {
    expect(meetingNeedsAttention(record({}, { state: "empty", emptyReason: "no audio." }))).toBe(false);
  });

  test("a failed finalize is, because nothing will send it on its own", () => {
    expect(meetingNeedsAttention(record({}, { state: "failed" }))).toBe(true);
  });

  test("and so is a refusal, which is parked until somebody clears the cause", () => {
    const refused = record({
      rejection: { code: ERRORS.forbidden, message: "gateway answered 403", noticedAt: 0 },
    });
    expect(meetingNeedsAttention(refused)).toBe(true);
  });

  test("the list keeps the records' own order, newest first", () => {
    const one = record({}, { id: "m1", state: "failed" });
    const two = record({}, { id: "m2", state: "finalizing" });
    const three = record({}, { id: "m3", state: "failed" });
    expect(strandedMeetings([one, two, three]).map((r) => r.session.id)).toEqual(["m1", "m3"]);
  });
});
