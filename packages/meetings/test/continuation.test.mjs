/**
 * A MEETING PICKED BACK UP — `continueMeetingNote` and friends, in `src/note.js`.
 *
 * Somebody stops a meeting, its note lands, and the meeting starts again. The
 * second part is spliced into the note that is already in the bucket rather
 * than rendering the file again, so what these checks guard is mostly what the
 * splice must NOT touch: a summary somebody corrected, a line they added under
 * `## My notes`, a retitled heading. Then the two things it must do: put the
 * part's words after a seam with clocks that continue the meeting, and be a
 * no-op when a retry brings the same part back.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are FAIL lines across the
 * whole package suite.
 *
 *   `continuesMeetingNote` always answering false                            1
 *   the part's clocks not moved by `offsetMs`                                 2
 *   the part's notes inserted at the top of `## My notes`                     1
 *   `setFrontmatter` re-adding a key the person deleted                       1
 *   the caveat written again under a note that already carries it           1
 *   `meetingNoteFacts` reading `duration` and ignoring the last clock         1
 *
 * The first scores one, and the check it trips is the one the phone's writer
 * leans on: without it a retry after a lost answer adds the same part twice.
 */

import {
  NOTES_HEADING,
  RESUMED_PREFIX,
  TRANSCRIPT_CAVEAT,
  TRANSCRIPT_HEADING,
  TRANSCRIPT_PLACEHOLDER,
  continueMeetingNote,
  continuesMeetingNote,
  meetingNoteFacts,
  parseDuration,
  parseMeetingNote,
  renderMeetingNote,
  resumeSeam,
} from "../src/note.js";
import { applyLog, createSession } from "../src/session.js";
import { FIXTURE_ID, OTHER_ID, at, segment } from "./fixtures.mjs";

const NOW = "2026-03-04T10:00:00.000Z";

/** The first part: thirty minutes, landed as a note. */
function firstPart(overrides = {}) {
  const base = createSession({
    id: FIXTURE_ID,
    title: "Weekly sync",
    startedAt: at(0),
    transcription: "cloud",
    device: { platform: "ios", name: "Phone" },
  });
  const session = applyLog(base, [
    { type: "start", at: at(0) },
    {
      type: "segments",
      segments: [
        segment({ id: "a", startMs: 0, endMs: 4000, text: "so the pricing page", speaker: "Attendee One" }),
        segment({ id: "b", startMs: 29 * 60_000, endMs: 29 * 60_000 + 5000, text: "let us take five", speaker: "Attendee Two" }),
      ],
    },
    { type: "notes", markdown: "- pricing page" },
    { type: "end", at: at(30) },
    { type: "written", notePath: "0-inbox/meetings/2026-03-04-weekly-sync-8h9jkmnp.md" },
  ]);
  return { ...session, ...overrides };
}

/** The second part: its own id, its own clock from zero, started 18 minutes after the first stopped. */
function secondPart(overrides = {}) {
  const base = createSession({
    id: OTHER_ID,
    title: "Weekly sync",
    startedAt: at(48, 3),
    transcription: "cloud",
    device: { platform: "ios", name: "Phone" },
  });
  const session = applyLog(base, [
    { type: "start", at: at(48, 3) },
    {
      type: "segments",
      segments: [
        segment({ id: "c", startMs: 2000, endMs: 6000, text: "okay, the dates", speaker: "Attendee One" }),
      ],
    },
    { type: "notes", markdown: "- dates: 14th to 16th" },
    { type: "flag", at: 3000, label: "dates" },
    { type: "end", at: at(52, 3) },
  ]);
  return { ...session, ...overrides };
}

function part(session = secondPart(), offsetMs = 30 * 60_000, previousEndedAt = at(30)) {
  return { session, offsetMs, previousEndedAt };
}

export function runContinuationChecks(check) {
  const original = renderMeetingNote(firstPart(), { now: NOW });

  /* ------------------------ what is already there ----------------------- */

  // What a person does to their own note between the two parts.
  const edited = original
    .replace("# Weekly sync", "# Weekly sync with the vendor")
    .replace("_No summary yet._", "Pricing page needs another pass.")
    .replace("- pricing page", "- pricing page\n- added later, in the vault");
  const continued = continueMeetingNote(edited, part(), { now: NOW });
  const parsed = parseMeetingNote(continued);
  const before = parseMeetingNote(edited);

  check("resuming keeps the title the person gave the note", parsed.title === "Weekly sync with the vendor");
  check("resuming keeps a summary the person corrected", parsed.summary === before.summary);
  check(
    "resuming keeps every word already under My notes, and adds the part's after them",
    parsed.notes === `${before.notes}\n\n- dates: 14th to 16th`
  );
  check(
    "the first part's transcript is still there, unchanged, ahead of the seam",
    parsed.transcript !== null &&
      before.transcript !== null &&
      parsed.transcript.startsWith(before.transcript)
  );
  check(
    "the meeting keeps its own id — a part is added to a meeting, not a meeting of its own",
    parsed.frontmatter["meeting-id"] === FIXTURE_ID
  );
  check(
    "every frontmatter line but updated, ended and duration is exactly as it was",
    (() => {
      const lines = (text) => text.split("\n").slice(1, text.split("\n").indexOf("---", 1));
      const a = lines(edited);
      const b = lines(continued);
      return (
        a.length === b.length &&
        a.every((line, i) => /^(updated|ended|duration):/.test(line) || line === b[i])
      );
    })()
  );
  check("duration covers both parts", parsed.frontmatter.duration === "34m");
  check("ended is when the second part stopped", parsed.frontmatter.ended === at(52, 3));

  /* ------------------------------ the part ------------------------------ */

  const seam = resumeSeam(part());
  check("the seam says when it resumed, and how long the gap was", seam === `${RESUMED_PREFIX}2026-03-04 09:48:03 UTC, 18m after it stopped._`);
  check("the seam is in the transcript", parsed.transcript?.includes(seam) === true);
  check(
    "the part's clocks continue the meeting rather than starting again",
    continued.includes("**[30:02] Attendee One** — okay, the dates") && !continued.includes("**[00:02]")
  );
  check("the part's flags move with its clock", continued.includes("> [!flag] 30:03 — dates"));
  check("the caveat is not written twice", continued.split(TRANSCRIPT_CAVEAT).length === 2);
  check("the file still ends with exactly one newline", continued.endsWith("\n") && !continued.endsWith("\n\n"));

  /* ---------------------------- idempotency ----------------------------- */

  check("a note the part is in says so", continuesMeetingNote(continued, part()));
  check("a note it is not in does not", !continuesMeetingNote(edited, part()));
  check(
    "a different part — one second later — is not mistaken for it",
    !continuesMeetingNote(continued, part(secondPart({ startedAt: at(48, 4) })))
  );

  /* ----------------------------- odd notes ------------------------------ */

  const typedOnly = continueMeetingNote(
    original,
    part(secondPart({ transcript: [], flags: [] })),
    { now: NOW }
  );
  check(
    "a part with nothing transcribed still marks the seam, and says nothing was captured after it",
    typedOnly.includes(`${resumeSeam(part(secondPart({ transcript: [], flags: [] })))}\n\n${TRANSCRIPT_PLACEHOLDER}`)
  );

  const noNotesHeading = original.replace(`${NOTES_HEADING}\n\n- pricing page\n\n`, "");
  const restored = parseMeetingNote(continueMeetingNote(noNotesHeading, part(), { now: NOW }));
  check("a note whose My notes heading was tidied away gets it back rather than losing the part's notes", restored.notes === "- dates: 14th to 16th");

  const noTranscript = original.slice(0, original.indexOf(TRANSCRIPT_HEADING));
  const grown = continueMeetingNote(noTranscript, part(), { now: NOW });
  check("a note with no transcript heading gets one, with the part under it", parseMeetingNote(grown).transcript?.includes("okay, the dates") === true);

  const typedFirst = renderMeetingNote(firstPart({ transcript: [], transcription: null }), { now: NOW });
  check(
    "a note that had no machine transcript gets the caveat with the first one it does",
    continueMeetingNote(typedFirst, part(), { now: NOW }).includes(TRANSCRIPT_CAVEAT)
  );

  const noDuration = original.replace(/\nduration: [^\n]*/, "");
  check(
    "a frontmatter key the person deleted stays deleted",
    !/\nduration:/.test(continueMeetingNote(noDuration, part(), { now: NOW }))
  );

  /* ------------------------- reading a note back ------------------------ */

  const facts = meetingNoteFacts(original);
  check("a meeting note says which meeting it is", facts?.meetingId === FIXTURE_ID);
  check("...and when it stopped", facts?.endedAt === at(30));
  check("...and that it has one part", facts?.parts === 1);
  check("...and how much was recorded", facts?.recordedMs === 30 * 60_000);
  check("a continued note counts its parts", meetingNoteFacts(continued)?.parts === 2);
  check(
    "the recorded length is at least the last clock in the transcript, not only the rounded duration",
    meetingNoteFacts(original.replace(/\nduration: [^\n]*/, "\nduration: 5m"))?.recordedMs === 29 * 60_000
  );
  check("a note that is not a meeting is not offered as one", meetingNoteFacts("# Groceries\n\n- eggs\n") === null);
  check(
    "a note that says it is a meeting but names none is not offered either",
    meetingNoteFacts(original.replace(/\nmeeting-id: [^\n]*/, "")) === null
  );

  check("durations read back the way they are written", parseDuration("45s") === 45_000 && parseDuration("31m") === 31 * 60_000 && parseDuration("1h 05m") === 65 * 60_000);
  check("a duration this file did not write is zero rather than a guess", parseDuration("about an hour") === 0 && parseDuration(undefined) === 0);
}
