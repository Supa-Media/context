/**
 * THE REDUCER — `src/session.js`.
 *
 * The property this suite exists for is replay. Every client keeps an
 * append-only log and hands the whole thing back when it reconnects, so
 * `applyLog(applyLog(s, log), log)` must deep-equal `applyLog(s, log)` — for a
 * clean meeting, for one that paused four times, and for one that failed
 * halfway and was restarted. If that ever stops holding, a phone that lost
 * signal corrupts the note it comes back to, and nothing else in this package
 * would notice.
 *
 * The rest is the two things that make replay safe: purity (the input is
 * deep-frozen, so a mutation throws rather than passing) and refusal (an
 * illegal transition throws a typed error instead of guessing).
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are FAIL lines across the
 * whole package suite.
 *
 *   `alreadyApplied` always returning false                                  7
 *   `transitionTo` returning the target without consulting the table         5
 *   `closeSpan` adding wall-clock time instead of the open span              5
 *   `withAttendee` mutating the list it was given                            3
 *   the `notes` event tidying the human's Markdown                           2
 *   `normalizeTranscription` coercing an unknown engine to null              3
 *
 * The last row is the one that is deliberately unlike its neighbours in the
 * source: `source.kind` and `device.platform` fall back, and this field
 * refuses. Coerced to `null`, a client with a typo in the word `cloud` gets a
 * note saying nothing was transcribed about a meeting that was streamed to a
 * service — which is why the sabotage is worth keeping in this list rather than
 * being read as "the reducer is strict about one more thing". Two of the three
 * checks it fails are `createSession`'s; the third is the normalizer's own.
 *
 * The first row is the finding, and it is about this file rather than the
 * source. On the first attempt it scored **zero** — because a reducer with no
 * replay guard *throws* on the second pass, the throw escaped the check that
 * was meant to catch it, and the process died with no FAIL line at all. Zero
 * FAILs read like a sabotage that did not land; it was a suite that could not
 * report. Every replay and every purity check now runs through `attempt`, so a
 * throw fails one check instead of taking the other 470 with it.
 */

import {
  DEFAULT_TITLE,
  MeetingEventError,
  MeetingTransitionError,
  applyEvent,
  applyLog,
  createSession,
  newMeetingId,
  normalizeTranscription,
  recordedMsAt,
} from "../src/session.js";
import {
  MEETING_ID_ALPHABET,
  MEETING_ID_LENGTH,
  MEETING_TRANSITIONS,
  PROTOCOL_VERSION,
  isMeetingId,
} from "../src/protocol.js";
import { FIXTURE_ID, at, attempt, countingRandom, deepEqual, deepFreeze, fixedRandom, segment } from "./fixtures.mjs";

/** The log of an ordinary meeting: start, one pause, end, enhance, write. */
const CLEAN_LOG = [
  { type: "start", at: at(0) },
  { type: "title", title: "Weekly sync" },
  { type: "attendee", attendee: { name: "Attendee One", email: "ONE@example.test" } },
  { type: "segment", segment: segment({ id: "a", startMs: 0, endMs: 4000, text: "first" }) },
  { type: "pause", at: at(10) },
  { type: "resume", at: at(12) },
  { type: "segments", segments: [segment({ id: "b", startMs: 8000, endMs: 9000, text: "second" })] },
  { type: "notes", markdown: "- pricing\n- timeline" },
  { type: "end", at: at(30) },
  { type: "enhanced", markdown: "### Decisions\n- ship", templateId: "default" },
  { type: "written", notePath: "0-inbox/meetings/2026/03/2026-03-04-weekly-sync-8h9jkmnp.md" },
];

export function runSessionChecks(check) {
  /* ------------------------------ ids ---------------------------------- */

  check("the id alphabet is exactly 32 characters", MEETING_ID_ALPHABET.length === 32);
  check(
    "...and it is the contract's, not this file's copy of it",
    // `newMeetingId` spells ids out of the alphabet protocol.js validates them
    // against, so an id built from every position of it must pass.
    MEETING_ID_ALPHABET.length === 32 && MEETING_ID_LENGTH === 20
  );
  check(
    "...with no duplicates",
    new Set(MEETING_ID_ALPHABET).size === MEETING_ID_ALPHABET.length
  );
  check(
    "...and no character protocol.js would reject",
    // Sweeps the whole alphabet: byte i maps to alphabet[i % 32], so 20 bytes
    // starting at 0, then at 20, then at 40 cover every position at least once.
    [0, 20, 40].every((offset) =>
      isMeetingId(newMeetingId((n) => Uint8Array.from({ length: n }, (_u, i) => offset + i)))
    )
  );
  check("newMeetingId is deterministic under an injected source", newMeetingId(fixedRandom(0)) === "mtg_00000000000000000000");
  check("...and a different source gives a different id", newMeetingId(countingRandom) === "mtg_0123456789abcdefghjk");
  check("newMeetingId satisfies isMeetingId with real randomness", isMeetingId(newMeetingId()));
  check(
    "a randomness source that under-delivers is refused, not padded",
    attempt(() => newMeetingId(() => new Uint8Array(4))).error instanceof MeetingEventError
  );

  /* --------------------------- createSession ---------------------------- */

  const fresh = createSession({ id: FIXTURE_ID, startedAt: at(0) });
  check("a new session is idle", fresh.state === "idle");
  check("...with nothing recorded", fresh.recordedMs === 0 && fresh.recordingSince === null);
  check("...stamped with the protocol version it was written against", fresh.version === PROTOCOL_VERSION);
  check("...an empty transcript, notes and attendee list", fresh.transcript.length === 0 && fresh.notes === "" && fresh.attendees.length === 0);
  check("...an unknown source until a detector says otherwise", fresh.source.kind === "unknown");
  check("...nothing written and nothing failed", fresh.notePath === null && fresh.failureReason === null && fresh.endedAt === null);
  check("...and a fallback title", fresh.title === DEFAULT_TITLE);
  check("startedAt is normalized to UTC with a Z", createSession({ id: FIXTURE_ID, startedAt: "2026-03-04T10:00:00+02:00" }).startedAt === "2026-03-04T08:00:00.000Z");
  check("a title's newlines are flattened, because it becomes an H1", createSession({ id: FIXTURE_ID, title: " Weekly\n sync " }).title === "Weekly sync");
  check(
    "an id that is not a meeting id is refused",
    attempt(() => createSession({ id: "workspace-42" })).error instanceof MeetingEventError
  );
  check(
    "an unparseable startedAt is refused rather than becoming Invalid Date",
    attempt(() => createSession({ id: FIXTURE_ID, startedAt: "last tuesday" })).threw
  );
  check("an unknown source kind falls back rather than being stored", createSession({ id: FIXTURE_ID, source: { kind: "hologram" } }).source.kind === "unknown");
  check("an unknown device platform falls back too", createSession({ id: FIXTURE_ID, device: { platform: "toaster" } }).device.platform === "web");

  /*
    ...but the transcription engine does NOT fall back, and that asymmetry is
    the point. `source.kind` and `device.platform` are evidence a detector
    offered, and a wrong guess costs a label. This field is the note's answer to
    "did my audio leave this machine", and every fallback available is a
    sentence the product would be making up about somebody's recording: `null`
    claims nothing was transcribed, an engine claims something was.
  */
  check("a session nobody transcribed carries null, explicitly", fresh.transcription === null);
  check(
    "...which is what an absent field means, because a notes-only meeting is ordinary",
    createSession({ id: FIXTURE_ID }).transcription === null
  );
  check(
    "an on-device engine is kept",
    createSession({ id: FIXTURE_ID, transcription: "on-device" }).transcription === "on-device"
  );
  check(
    "...and so is a cloud one, which is the disclosure that matters",
    createSession({ id: FIXTURE_ID, transcription: "cloud" }).transcription === "cloud"
  );
  check(
    "an engine this contract never heard of is refused rather than guessed",
    attempt(() => createSession({ id: FIXTURE_ID, transcription: "quantum" })).error instanceof MeetingEventError
  );
  check(
    "...and so is one that is not even a string",
    attempt(() => createSession({ id: FIXTURE_ID, transcription: 7 })).error instanceof MeetingEventError
  );
  check("normalizeTranscription reads an absent value as no engine", normalizeTranscription(undefined) === null);
  check("...and an explicit null the same way", normalizeTranscription(null) === null);
  check("...and refuses an empty string, which is not an answer", attempt(() => normalizeTranscription("")).threw);

  /* ------------------------------ purity -------------------------------- */

  // Deep-frozen input, and every application run through `attempt`: a reducer
  // that mutates throws in strict mode, and a throw that escaped would kill the
  // process rather than failing the check that is supposed to catch it.
  const frozen = deepFreeze(createSession({ id: FIXTURE_ID, startedAt: at(0) }));
  const startAttempt = attempt(() => applyEvent(frozen, { type: "start", at: at(0) }));
  check("applyEvent does not write to the session it was given", !startAttempt.threw);
  check("...returning a new object instead", startAttempt.value !== frozen);
  check("...and leaving the original alone", frozen.state === "idle" && frozen.recordingSince === null);

  const started = startAttempt.value;
  const segmentAttempt = attempt(() => applyEvent(deepFreeze(started), { type: "segment", segment: segment({ id: "a" }) }));
  check("a segment does not mutate the transcript array it was handed", !segmentAttempt.threw);
  check("...it builds a new one", started.transcript.length === 0 && segmentAttempt.value?.transcript.length === 1);

  const withSegment = segmentAttempt.value;
  const attendeeAttempt = attempt(() => applyEvent(deepFreeze(withSegment), { type: "attendee", attendee: { name: "Attendee One" } }));
  check("nor does an attendee mutate the attendee array", !attendeeAttempt.threw);
  check("...it builds a new one too", withSegment.attendees.length === 0 && attendeeAttempt.value?.attendees.length === 1);

  const notesAttempt = attempt(() => applyEvent(deepFreeze(withSegment), { type: "notes", markdown: "theirs" }));
  check("nor does replacing the notes write through the session", !notesAttempt.threw && withSegment.notes === "");

  const enhanceAttempt = attempt(() => applyEvent(deepFreeze(withSegment), { type: "enhanced", markdown: "### x", templateId: "default" }));
  check("nor does an enhancement", !enhanceAttempt.threw && withSegment.enhanced === null);

  /* --------------------------- the state machine ------------------------ */

  check("idle accepts start", applyEvent(fresh, { type: "start", at: at(0) }).state === "recording");
  const recording = applyEvent(fresh, { type: "start", at: at(0) });
  check("recording accepts pause", applyEvent(recording, { type: "pause", at: at(1) }).state === "paused");
  const paused = applyEvent(recording, { type: "pause", at: at(1) });
  check("paused accepts resume", applyEvent(paused, { type: "resume", at: at(2) }).state === "recording");
  check("paused accepts end", applyEvent(paused, { type: "end", at: at(2) }).state === "finalizing");
  const finalizing = applyEvent(recording, { type: "end", at: at(30) });
  check("finalizing accepts written, which completes it", applyEvent(finalizing, { type: "written", notePath: "a.md" }).state === "complete");

  const illegal = attempt(() => applyEvent(fresh, { type: "written", notePath: "a.md" }));
  check("idle refuses to be completed", illegal.error instanceof MeetingTransitionError);
  check("...with the transition named on the error", illegal.error?.from === "idle" && illegal.error?.to === "complete");
  check("...and a wire error code the gateway can return unchanged", illegal.error?.code === "meeting_invalid");
  check(
    "recording refuses to be completed without finalizing",
    attempt(() => applyEvent(recording, { type: "written", notePath: "a.md" })).error instanceof MeetingTransitionError
  );
  const complete = applyEvent(finalizing, { type: "written", notePath: "a.md" });
  check(
    "a complete meeting refuses to fail",
    attempt(() => applyEvent(complete, { type: "fail", at: at(40), reason: "storage_down" })).error instanceof MeetingTransitionError
  );
  check("complete is terminal in the protocol table", MEETING_TRANSITIONS.complete.length === 0);
  check(
    "a failed meeting can be restarted",
    applyEvent(applyEvent(recording, { type: "fail", at: at(4), reason: "mic_lost" }), { type: "start", at: at(5) }).state === "recording"
  );

  /*
    The three moves the transition table grew, each because a client was
    reaching for it. They are asserted through the reducer rather than only
    against the table, because a table that allows a move a reducer refuses is
    the same bug one layer down.
  */
  {
    // A meeting nobody recorded: typed notes and no audio. Their words are the
    // half that cannot be regenerated, so this must not need a forged `start`.
    const typedOnly = applyLog(fresh, [
      { type: "notes", markdown: "- they said yes" },
      { type: "end", at: at(12) },
    ]);
    check("a meeting nobody recorded still finalizes", typedOnly.state === "finalizing");
    check("...keeping the human's words", typedOnly.notes === "- they said yes");
    check("...and counting no audio at all", typedOnly.recordedMs === 0);
    check(
      "...and it writes out to one note like any other",
      applyEvent(typedOnly, { type: "written", notePath: "a.md" }).state === "complete"
    );
  }

  {
    // A finalize the gateway has not answered is not a finished meeting: the
    // person is still in the room. Before this the only way back was a `fail`
    // the client invented.
    const back = applyEvent(finalizing, { type: "start", at: at(31) });
    check("a finalize that has not landed can be taken back to recording", back.state === "recording");
    check(
      "...without moving the start of the meeting, which the note path is filed under",
      back.startedAt === finalizing.startedAt
    );
    check(
      "...and a session that already wrote its note still refuses",
      attempt(() => applyEvent(complete, { type: "start", at: at(40) })).error instanceof MeetingTransitionError
    );
  }

  {
    // A recording that failed mid-meeting holds a partial transcript, and a
    // partial transcript is somebody's meeting.
    const partial = applyLog(fresh, [
      { type: "start", at: at(0) },
      { type: "segment", segment: segment({ id: "p", startMs: 0, endMs: 4000, text: "half of it" }) },
      { type: "fail", at: at(4), reason: "microphone_lost" },
      { type: "end", at: at(5) },
    ]);
    check("a failed recording can be written out with what it captured", partial.state === "finalizing");
    check("...transcript and all", partial.transcript.length === 1);
  }
  check(
    "an unknown event type is refused rather than ignored",
    attempt(() => applyEvent(fresh, { type: "teleport" })).error instanceof MeetingEventError
  );
  check(
    "an event with no type at all is refused",
    attempt(() => applyEvent(fresh, {})).error instanceof MeetingEventError
  );
  check(
    "a start with no timestamp is refused",
    attempt(() => applyEvent(fresh, { type: "start" })).error instanceof MeetingEventError
  );
  check(
    "a written with an empty path is refused",
    attempt(() => applyEvent(finalizing, { type: "written", notePath: "" })).error instanceof MeetingEventError
  );

  /* -------------------------------- flags ------------------------------- */

  /*
    A wrist flag now has a path into a note: an event, a field, and a fold. It
    used to have a verb on the watch, a count in `WatchState`, and nowhere to go.
  */
  {
    const flagged = applyLog(fresh, [
      { type: "start", at: at(0) },
      { type: "flag", at: 61_000, label: "  ask   about   pricing  " },
      { type: "flag", at: 5_000 },
    ]);
    check("a flag lands on the session", flagged.flags.length === 2);
    check("...oldest first, whatever order they arrived in", flagged.flags[0].at === 5_000);
    check("...with the label collapsed to one line", flagged.flags[1].label === "ask about pricing");
    check("...and no state moved, because a flag is a mark and not an event in the meeting", flagged.state === "recording");
    check(
      "a label longer than the wrist's limit is cut, not refused",
      applyEvent(fresh, { type: "flag", at: 1, label: "x".repeat(200) }).flags[0].label.length === 40
    );
    check(
      "a flag with no label carries none rather than an empty one",
      applyEvent(fresh, { type: "flag", at: 1, label: "   " }).flags[0].label === undefined
    );
    check(
      "the same press folded twice is one flag",
      applyEvent(flagged, { type: "flag", at: 5_000 }).flags.length === 2
    );
    check(
      "...and a replay cannot rewrite the label of one already folded",
      applyEvent(flagged, { type: "flag", at: 5_000, label: "rewritten" }).flags.length === 2 &&
        applyEvent(flagged, { type: "flag", at: 5_000, label: "rewritten" }).flags[0].label === undefined
    );
    check(
      "an offset that is not milliseconds from the start is refused",
      attempt(() => applyEvent(fresh, { type: "flag", at: "01:05" })).error instanceof MeetingEventError &&
        attempt(() => applyEvent(fresh, { type: "flag", at: -1 })).error instanceof MeetingEventError
    );
    check(
      "a flag on a meeting nobody recorded is still a flag",
      applyEvent(fresh, { type: "flag", at: 0 }).flags.length === 1
    );
    const flagLog = [
      { type: "start", at: at(0) },
      { type: "flag", at: 5_000 },
      { type: "flag", at: 61_000, label: "pricing" },
      { type: "end", at: at(2) },
    ];
    const flagOnce = applyLog(fresh, flagLog);
    check(
      "a log with flags in it replays clean",
      attempt(() => deepEqual(applyLog(flagOnce, flagLog), flagOnce)).value === true
    );
    check(
      "a flag does not write through the session it was given",
      !attempt(() => applyEvent(deepFreeze(flagOnce), { type: "flag", at: 90_000 })).threw
    );
  }

  /* ------------------------------ recordedMs ---------------------------- */

  const paced = applyLog(fresh, [
    { type: "start", at: at(0) },
    { type: "pause", at: at(10) },
    { type: "resume", at: at(25) },
    { type: "end", at: at(35) },
  ]);
  check("recordedMs counts audio, not wall clock", paced.recordedMs === 20 * 60_000);
  check("...and the meeting still spans thirty-five minutes on the clock", Date.parse(paced.endedAt) - Date.parse(paced.startedAt) === 35 * 60_000);

  const twicePaused = applyLog(fresh, [
    { type: "start", at: at(0) },
    { type: "pause", at: at(5) },
    { type: "resume", at: at(20) },
    { type: "pause", at: at(25) },
    { type: "resume", at: at(40) },
    { type: "end", at: at(45) },
  ]);
  check("two pauses subtract twice", twicePaused.recordedMs === 15 * 60_000);
  check(
    "a pause that never resumes still closes its span at the end",
    applyLog(fresh, [{ type: "start", at: at(0) }, { type: "pause", at: at(3) }, { type: "end", at: at(30) }]).recordedMs === 3 * 60_000
  );
  check(
    "a client clock that jumps backwards counts zero, never negative",
    applyLog(fresh, [{ type: "start", at: at(10) }, { type: "end", at: at(2) }]).recordedMs === 0
  );
  check("recordedMsAt includes the span still open mid-meeting", recordedMsAt(applyEvent(fresh, { type: "start", at: at(0) }), at(7)) === 7 * 60_000);
  check("...and is just recordedMs once the span is closed", recordedMsAt(paced, at(99)) === paced.recordedMs);
  check(
    "a second start while already recording does not restart the span",
    applyLog(fresh, [{ type: "start", at: at(0) }, { type: "start", at: at(5) }, { type: "end", at: at(10) }]).recordedMs === 10 * 60_000
  );

  /* ------------------------------- replay ------------------------------- */

  // A replay that a broken reducer *throws* on has to fail these checks, not
  // kill the process — a crash takes every later check with it and reads as
  // zero failures if you count FAIL lines. So the second pass is always run
  // through `attempt`.
  const replay = (session, log) => {
    const result = attempt(() => applyLog(session, log));
    return { threw: result.threw, same: !result.threw && deepEqual(result.value, session) };
  };

  const once = applyLog(fresh, CLEAN_LOG);
  const replayedClean = replay(once, CLEAN_LOG);
  check("replaying a clean log does not throw", !replayedClean.threw);
  check("a clean log replayed twice lands on the same session", replayedClean.same);
  check("...having actually done something the first time", once.state === "complete" && once.recordedMs === 28 * 60_000);
  check("...with the transcript merged, not doubled", once.transcript.length === 2);
  check("...and the note path from the log", once.notePath.endsWith("-weekly-sync-8h9jkmnp.md"));

  const restartLog = [
    { type: "start", at: at(0) },
    { type: "fail", at: at(4), reason: "microphone_lost" },
    { type: "start", at: at(2) },
    { type: "segment", segment: segment({ id: "a" }) },
    { type: "end", at: at(20) },
    { type: "written", notePath: "note.md" },
  ];
  const restartedOnce = applyLog(fresh, restartLog);
  const replayedRestart = replay(restartedOnce, restartLog);
  check("replaying a log with a failure in it does not throw", !replayedRestart.threw);
  check("a log with a failure and a restart replays clean", replayedRestart.same);
  check("...ending complete, not failed", restartedOnce.state === "complete");
  check(
    "...counting the audio captured before the failure as well as after the restart",
    // Four minutes to the failure, eighteen from the restart to the end. The
    // span used to be dropped at the failure, which lost the first four.
    restartedOnce.recordedMs === 22 * 60_000
  );
  check("...keeping the original startedAt, because the note path is filed under it", restartedOnce.startedAt === at(0));
  check(
    "...and clearing the reason once it recovered, because a reason is what `failed` means",
    restartedOnce.failureReason === null
  );
  check(
    "a session that is still failed says why",
    applyEvent(recording, { type: "fail", at: at(4), reason: "microphone_lost" }).failureReason ===
      "microphone_lost"
  );
  check(
    "a fail with no timestamp is refused, like every other state-changing event",
    attempt(() => applyEvent(recording, { type: "fail", reason: "microphone_lost" })).error instanceof
      MeetingEventError
  );
  check(
    "replaying one failure twice does not re-fail a session that recovered",
    (() => {
      const failed = applyEvent(recording, { type: "fail", at: at(4), reason: "mic_lost" });
      const back = applyEvent(failed, { type: "start", at: at(5) });
      return applyEvent(back, { type: "fail", at: at(4), reason: "mic_lost" }) === back;
    })()
  );

  const pauseHeavy = [
    { type: "start", at: at(0) },
    { type: "pause", at: at(5) },
    { type: "resume", at: at(6) },
    { type: "pause", at: at(9) },
    { type: "resume", at: at(11) },
    { type: "end", at: at(20) },
  ];
  const paceOnce = applyLog(fresh, pauseHeavy);
  const replayedPaced = replay(paceOnce, pauseHeavy);
  check("replaying repeated pauses does not throw", !replayedPaced.threw);
  check("repeated pauses of the same type replay clean", replayedPaced.same);
  check("...and replay does not inflate recordedMs", attempt(() => applyLog(paceOnce, pauseHeavy)).value?.recordedMs === paceOnce.recordedMs);
  check(
    "a later pause than the one already applied is not treated as stale",
    applyLog(fresh, pauseHeavy).recordedMs === 17 * 60_000
  );
  check(
    "finalize on a session that already wrote its note is a no-op",
    deepEqual(once, attempt(() => applyEvent(once, { type: "end", at: at(99) })).value)
  );

  /* -------------------------- additive events --------------------------- */

  const twoSegments = applyLog(fresh, [
    { type: "segment", segment: segment({ id: "a", startMs: 5000, endMs: 6000, text: "later" }) },
    { type: "segment", segment: segment({ id: "b", startMs: 0, endMs: 1000, text: "earlier" }) },
    { type: "segment", segment: segment({ id: "a", startMs: 5000, endMs: 6000, text: "later, corrected" }) },
  ]);
  check("the same segment id replaces rather than duplicating", twoSegments.transcript.length === 2);
  check("...taking the newest text", twoSegments.transcript[1].text === "later, corrected");
  check("...and sorting by start time regardless of arrival order", twoSegments.transcript[0].text === "earlier");

  const attendees = applyLog(fresh, [
    { type: "attendee", attendee: { name: "Attendee One", email: "one@example.test", via: "calendar" } },
    { type: "attendee", attendee: { email: "ONE@example.test", via: "platform" } },
    { type: "attendee", attendee: { name: "Attendee Two" } },
  ]);
  check("the same person arriving twice is one attendee", attendees.attendees.length === 2);
  check("...matched on address, case-insensitively", attendees.attendees[0].email === "one@example.test");
  check("...keeping the display name the calendar gave", attendees.attendees[0].name === "Attendee One");
  check(
    "an attendee with neither name nor email is refused",
    attempt(() => applyEvent(fresh, { type: "attendee", attendee: { via: "manual" } })).error instanceof MeetingEventError
  );

  const notes = applyLog(fresh, [
    { type: "notes", markdown: "first" },
    { type: "notes", markdown: "  second\n\n---\n\nkey: value  " },
  ]);
  check("notes are last-write-wins", notes.notes.startsWith("  second"));
  check("...stored byte for byte, including the trailing spaces the human typed", notes.notes === "  second\n\n---\n\nkey: value  ");
  check(
    "a non-string title is refused, because the note path is derived from it",
    attempt(() => applyEvent(fresh, { type: "title", title: 42 })).error instanceof MeetingEventError
  );
  check(
    "a non-string notes payload is refused rather than stringified",
    attempt(() => applyEvent(fresh, { type: "notes", markdown: { toString: () => "gotcha" } })).error instanceof MeetingEventError
  );

  const enhanced = applyLog(once, [{ type: "enhanced", markdown: "### Take two", templateId: "standup" }]);
  check("a complete meeting can still be re-enhanced", enhanced.enhanced === "### Take two" && enhanced.templateId === "standup");
  check("...without moving its state", enhanced.state === "complete");
}
