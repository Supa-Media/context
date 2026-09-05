import { describe, expect, test } from "@jest/globals";
import { PROTOCOL_VERSION } from "../features/meetings/protocol";
import {
  applyMeetingEvent,
  can,
  elapsedMs,
  isLive,
  projectLog,
  seedProjection,
  transcriptionFor,
} from "../features/meetings/session";
import { fakeSegment } from "../features/meetings/capture/fake";
import type { MeetingEvent, MeetingProjection } from "../features/meetings";

/**
 * The fold from a meeting's event log onto the session the screens render.
 *
 * Three of the protocol's own sentences are what this file checks, and each of
 * them is a property rather than a case:
 *
 *  - "Every one is idempotent or additive: replaying the log must land on the
 *    same session." Asserted as *replay equality* — the whole log folded twice
 *    lands on the same object — rather than by listing the events that happen
 *    to be idempotent today, because the list is what a new event type would
 *    quietly fall off.
 *  - "A client that cannot make its move here has a bug, and the reducer
 *    refuses rather than guessing." Every illegal move is driven, and the
 *    assertion is *identity* (`toBe`), which is stronger than deep equality: a
 *    refusal that rebuilt an equal object would still churn React and would
 *    still be the reducer having done something.
 *  - "`recordedMs`: audio actually captured, excluding pauses." Driven with
 *    real pause/resume spans, including the case a timer cannot survive — the
 *    app being killed and the log re-read.
 *
 * ## This file is also a countdown
 *
 * `features/meetings/session.ts` is a copy of a fold that belongs in
 * `@context/meetings` — `protocol.js` names `applyEvent` in `session.js` as the
 * canonical one. The last test in this file **fails the day that export
 * appears**, and says to delete the local copy. A duplicate with no alarm on it
 * is a duplicate that lives forever.
 *
 * ## The sabotage record
 *
 * Broken on purpose, the whole mobile suite run (3050 tests), and reverted:
 *
 *  - **`seedSession` dropping `transcription`**: 4 across two files, and
 *    `tsc --noEmit` refuses it outright — the contract makes the field required
 *    rather than optional precisely so that forgetting it is a compile error
 *    and not a note that quietly says nothing about where the audio went.
 *  - **`transcriptionFor` mapping `nowhere` to `on-device`**: 2, one here and
 *    one in `meetingsController.test.ts`. It is the mapping that cannot be
 *    caught by reading it: `nowhere` and `on-device` are both "no audio left
 *    this machine" to a careless eye, and only one of them is true of a meeting
 *    nobody recorded.
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

const at = (minutes: number) =>
  new Date(Date.parse(SEED.startedAt) + minutes * 60_000).toISOString();

function fold(events: MeetingEvent[]): MeetingProjection {
  return projectLog(seedProjection(SEED), events);
}

describe("a session starts idle and holds nothing invented", () => {
  test("the seed is the protocol's shape with every field present", () => {
    const { session } = seedProjection(SEED);
    expect(session.state).toBe("idle");
    expect(session.notes).toBe("");
    expect(session.transcript).toEqual([]);
    // `null`, not `undefined` and not a placeholder path: nothing has been
    // written, and the screen's whole job is to tell those apart.
    expect(session.enhanced).toBeNull();
    expect(session.notePath).toBeNull();
    expect(session.endedAt).toBeNull();
    expect(session.recordedMs).toBe(0);
    // How it was made, carried from the start rather than reconstructed at the
    // end: the note's frontmatter is written from this field, and a session
    // that never held it would produce a note that cannot say where the audio
    // went.
    expect(session.transcription).toBe("cloud");
  });

  test("a meeting nobody transcribed says so explicitly, rather than leaving it out", () => {
    const { session } = seedProjection({ ...SEED, transcription: null });
    expect(session.transcription).toBeNull();
    expect("transcription" in session).toBe(true);
  });
});

describe("the recorder's vocabulary becomes the contract's, in one place", () => {
  /*
    `transcribesAt` answers "where does this happen" and the frontmatter answers
    a reader's question about a meeting they are looking at, so the words differ
    on purpose: `device` there is `on-device` here. One function does the
    translation because the mapping that matters — `nowhere` meaning *no engine*
    — is the one a second copy gets wrong, and getting it wrong writes "your
    audio stayed on this machine" onto a meeting nothing ever recorded.
  */
  test("device transcription is the note's on-device", () => {
    expect(transcriptionFor("device")).toBe("on-device");
  });

  test("cloud transcription keeps its name, because that is the disclosure", () => {
    expect(transcriptionFor("cloud")).toBe("cloud");
  });

  test("a recorder that transcribes nowhere produces no engine at all", () => {
    expect(transcriptionFor("nowhere")).toBeNull();
  });
});

describe("replaying the log lands on the same session", () => {
  const log: MeetingEvent[] = [
    { type: "start", at: at(0) },
    { type: "notes", markdown: "first line" },
    { type: "segment", segment: fakeSegment("s1", 0, "hello") },
    { type: "pause", at: at(10) },
    { type: "resume", at: at(12) },
    { type: "segments", segments: [fakeSegment("s2", 720_000, "and then")] },
    { type: "attendee", attendee: { name: "Ada", email: "ada@example.invalid" } },
    { type: "title", title: "Design review — Portal" },
    { type: "notes", markdown: "first line\nsecond line" },
    { type: "end", at: at(41) },
    { type: "enhanced", markdown: "## Summary\n\n…", templateId: "default" },
    { type: "written", notePath: "0-inbox/meetings/2026/09/design-review.md" },
  ];

  test("folding it twice is folding it once", () => {
    // The property an offline client depends on: it replays its log on
    // reconnect, and a phone that was killed re-reads and re-folds from disk.
    expect(fold([...log, ...log]).session).toEqual(fold(log).session);
  });

  test("the same segment id replaces rather than appends", () => {
    const once = fold([{ type: "start", at: at(0) }, { type: "segment", segment: fakeSegment("s1", 0, "draft") }]);
    const corrected = applyMeetingEvent(once, {
      type: "segment",
      segment: fakeSegment("s1", 0, "corrected"),
    });
    expect(corrected.session.transcript).toHaveLength(1);
    expect(corrected.session.transcript[0].text).toBe("corrected");
  });

  test("segments come out in time order however they arrived", () => {
    // A cloud batch landing while an on-device pass is still emitting is the
    // ordinary case, and a transcript that reads out of order is one nobody
    // trusts.
    const projection = fold([
      { type: "start", at: at(0) },
      { type: "segment", segment: fakeSegment("late", 60_000, "third") },
      { type: "segment", segment: fakeSegment("early", 0, "first") },
      { type: "segments", segments: [fakeSegment("mid", 30_000, "second")] },
    ]);
    expect(projection.session.transcript.map((s) => s.text)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  test("the same person reported twice is one attendee", () => {
    // The calendar and the platform both name the same people. Two rows for one
    // person is what a replay produces without this.
    const projection = fold([
      { type: "attendee", attendee: { name: "Ada L", email: "ada@example.invalid", via: "calendar" } },
      { type: "attendee", attendee: { name: "Ada", email: "ADA@example.invalid", via: "platform" } },
    ]);
    expect(projection.session.attendees).toHaveLength(1);
  });

  test("a `written` on an already-complete session does not write a second time", () => {
    const done = fold([
      { type: "start", at: at(0) },
      { type: "end", at: at(5) },
      { type: "written", notePath: "0-inbox/a.md" },
    ]);
    const again = applyMeetingEvent(done, { type: "written", notePath: "0-inbox/a.md" });
    expect(again.session.state).toBe("complete");
    expect(again.session.notePath).toBe("0-inbox/a.md");
  });
});

describe("the reducer refuses rather than guessing", () => {
  /**
   * Identity, not equality.
   *
   * A refusal that returned a *new* equal object would re-render every screen
   * watching the session and would make `controller.apply`'s "did anything
   * happen" check meaningless. The controller compares by identity for exactly
   * this reason, so this is the assertion that keeps that true.
   */
  function refuses(projection: MeetingProjection, event: MeetingEvent): void {
    expect(applyMeetingEvent(projection, event)).toBe(projection);
  }

  test("you cannot pause something that is not recording", () => {
    refuses(seedProjection(SEED), { type: "pause", at: at(1) });
  });

  /*
    Not a refusal any more, and the reason is worth keeping here rather than
    only in the contract: a meeting nobody recorded is still a meeting. Somebody
    who said no to the microphone and typed for forty minutes has notes that
    nothing can regenerate, and refusing to finalize until a `start` had been
    forged was the app inventing a recording to be allowed to save the words.
    `MEETING_TRANSITIONS.idle` now lists `finalizing`.
  */
  test("a session that never started ends anyway, carrying what was typed", () => {
    const typed = applyMeetingEvent(seedProjection(SEED), {
      type: "notes",
      markdown: "- they said yes",
    });
    const ended = applyMeetingEvent(typed, { type: "end", at: at(1) });
    expect(ended.session.state).toBe("finalizing");
    expect(ended.session.notes).toBe("- they said yes");
    expect(ended.session.recordedMs).toBe(0);
  });

  test("a complete session is terminal in every direction", () => {
    const done = fold([
      { type: "start", at: at(0) },
      { type: "end", at: at(5) },
      { type: "written", notePath: "0-inbox/a.md" },
    ]);
    refuses(done, { type: "start", at: at(6) });
    refuses(done, { type: "pause", at: at(6) });
    refuses(done, { type: "end", at: at(6) });
    refuses(done, { type: "fail", at: at(6), reason: "no" });
  });

  test("resuming something already recording changes nothing about it", () => {
    const running = fold([{ type: "start", at: at(0) }]);
    const again = applyMeetingEvent(running, { type: "resume", at: at(3) });
    // Legal — `recording -> recording` is not in the table, so it is refused —
    // and the running interval is untouched, which is what stops a stray resume
    // from erasing three minutes of elapsed time.
    expect(again).toBe(running);
  });

  test("an event from a newer build is ignored rather than thrown", () => {
    const running = fold([{ type: "start", at: at(0) }]);
    const unknown = { type: "flagged", at: at(1) } as unknown as MeetingEvent;
    expect(applyMeetingEvent(running, unknown)).toBe(running);
  });

  test("`can` is the table, and it is what the UI draws its controls from", () => {
    expect(can("recording", "paused")).toBe(true);
    expect(can("paused", "recording")).toBe(true);
    expect(can("complete", "recording")).toBe(false);
    expect(can("failed", "recording")).toBe(true);
  });
});

describe("recordedMs excludes pauses, and survives the app being killed", () => {
  test("a pause stops the clock and a resume starts it again", () => {
    const projection = fold([
      { type: "start", at: at(0) },
      { type: "pause", at: at(10) },
      { type: "resume", at: at(25) },
      { type: "end", at: at(30) },
    ]);
    // Ten minutes plus five, not thirty: the fifteen minutes of pause are not
    // audio anybody captured.
    expect(projection.session.recordedMs).toBe(15 * 60_000);
  });

  test("elapsed time counts the open interval, from the log rather than a timer", () => {
    /*
      This is the case a `setInterval` cannot survive: the app is killed at
      minute 10 and relaunched at minute 30, and the log is all there is. The
      counter has to read 30 minutes, not zero and not 10.
    */
    const restored = fold([{ type: "start", at: at(0) }]);
    expect(elapsedMs(restored, Date.parse(at(30)))).toBe(30 * 60_000);
  });

  test("a paused session's clock does not run", () => {
    const paused = fold([
      { type: "start", at: at(0) },
      { type: "pause", at: at(10) },
    ]);
    expect(elapsedMs(paused, Date.parse(at(45)))).toBe(10 * 60_000);
  });

  test("a clock that went backwards does not run the counter backwards", () => {
    // An NTP correction mid-meeting, or a device whose time was wrong until it
    // found a network. It costs the seconds it corrected by; it does not put a
    // minus sign in front of somebody.
    const running = fold([{ type: "start", at: at(10) }]);
    expect(elapsedMs(running, Date.parse(at(5)))).toBe(0);
  });

  test("a failure closes the interval at the moment it failed, and not after", () => {
    /*
      The clock stops where the recorder died. This test asserted the opposite
      until `fail` carried an `at`: with no timestamp the interval had to be
      left open, so a phone that failed at minute 4 and was picked up at minute
      30 counted twenty-six minutes of silence as recorded audio. `failed ->
      recording` is still how a dropped recorder is retried, and the retry opens
      a new interval.
    */
    const failed = fold([
      { type: "start", at: at(0) },
      { type: "fail", at: at(4), reason: "the microphone was taken" },
    ]);
    expect(failed.session.state).toBe("failed");
    expect(failed.session.failureReason).toBe("the microphone was taken");
    expect(elapsedMs(failed, Date.parse(at(10)))).toBe(4 * 60_000);

    const retried = applyMeetingEvent(failed, { type: "start", at: at(10) });
    expect(retried.session.state).toBe("recording");
    // The reason describes the `failed` state and nothing else, so leaving it
    // is leaving a session that says it failed while it is recording.
    expect(retried.session.failureReason).toBeNull();
    expect(elapsedMs(retried, Date.parse(at(15)))).toBe(9 * 60_000);
  });
});

describe("the human's notes are theirs", () => {
  test("nothing but a `notes` event ever changes them", () => {
    const projection = fold([
      { type: "start", at: at(0) },
      { type: "notes", markdown: "what I typed" },
      { type: "segment", segment: fakeSegment("s1", 0, "what somebody said") },
      { type: "enhanced", markdown: "## Summary\n\nwhat a model wrote", templateId: "default" },
      { type: "end", at: at(5) },
      { type: "written", notePath: "0-inbox/a.md" },
    ]);
    expect(projection.session.notes).toBe("what I typed");
  });

  test("`enhanced` does not move the state — only `written` does", () => {
    // The gateway can have written a summary and not yet have put a note in the
    // customer's bucket. Drawing the second from the first is the "saved" claim
    // this product may not make early.
    const projection = fold([
      { type: "start", at: at(0) },
      { type: "end", at: at(5) },
      { type: "enhanced", markdown: "## Summary", templateId: "default" },
    ]);
    expect(projection.session.state).toBe("finalizing");
    expect(projection.session.notePath).toBeNull();
  });
});

describe("a flagged moment", () => {
  /*
    The wrist's verb, and the only one that exists because of the wrist. It
    marks a moment mid-sentence, so the offset is milliseconds from the start of
    the session computed where the button was pressed — a watch drains a queued
    command late, and a flag stamped on arrival marks the wrong sentence.
  */
  test("lands on the session, oldest first, without moving the state", () => {
    const projection = fold([
      { type: "start", at: at(0) },
      { type: "flag", at: 61_000, label: "  ask   about pricing " },
      { type: "flag", at: 5_000 },
    ]);
    expect(projection.session.state).toBe("recording");
    expect(projection.session.flags).toEqual([
      { at: 5_000 },
      { at: 61_000, label: "ask about pricing" },
    ]);
  });

  test("the same press folded twice is one flag", () => {
    const once = fold([
      { type: "start", at: at(0) },
      { type: "flag", at: 5_000, label: "here" },
    ]);
    const twice = applyMeetingEvent(once, { type: "flag", at: 5_000, label: "here" });
    expect(twice).toBe(once);
    expect(twice.session.flags).toHaveLength(1);
  });
});

describe("what counts as live", () => {
  test("recording and paused, and nothing else", () => {
    expect(isLive("recording")).toBe(true);
    expect(isLive("paused")).toBe(true);
    // A finalizing meeting is over — the persistent bar must come down when
    // somebody presses End, not when the gateway answers.
    expect(isLive("finalizing")).toBe(false);
    expect(isLive("idle")).toBe(false);
    expect(isLive("complete")).toBe(false);
    expect(isLive("failed")).toBe(false);
  });
});

describe("this local reducer is on a countdown", () => {
  test("delete `features/meetings/session.ts` when the package exports `applyEvent`", async () => {
    /*
      `protocol.js` names `applyEvent` in `session.js` as the canonical fold.
      This app carries a copy only because the package ships `protocol.js` and
      nothing else yet, and a copy with no alarm on it is a copy that lives
      forever and drifts.

      When this fails: import `applyEvent` from `@context/meetings`, delete
      `features/meetings/session.ts` down to the helpers this app genuinely owns
      (`elapsedMs`, `isLive`), and delete this test.
    */
    let exports: Record<string, unknown> = {};
    try {
      exports = (await import("@context/meetings")) as Record<string, unknown>;
    } catch {
      // The package has no entry point yet. That is the state this pin is for.
    }
    expect(typeof exports.applyEvent).not.toBe("function");
  });
});
