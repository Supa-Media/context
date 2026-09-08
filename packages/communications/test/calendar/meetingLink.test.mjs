// The link-from-meeting half: given a captured meeting and the calendar
// event(s) around it, decide which one it is. The other half — the desktop
// noticing a meeting is starting by consulting a day note — is out of scope
// here; see the header comment in `../../src/calendar/meetingLink.js`.

import {
  attachEventLink,
  calendarEventLink,
  candidatesFromDay,
  matchMeetingToEvent,
  readEventLink,
  titleSimilarity,
  windowsOverlap,
} from "../../src/calendar/meetingLink.js";
import { eventAnchor } from "../../src/calendar/anchors.js";
import { parseMeetingNote, renderMeetingNote } from "../../../meetings/src/note.js";

function candidate(overrides = {}) {
  return {
    anchor: "evt-0000000000000001",
    title: "Quarterly review",
    start: "2026-09-07T14:00:00.000Z",
    end: "2026-09-07T15:00:00.000Z",
    path: "0-inbox/calendar/2026-09-07.md",
    ...overrides,
  };
}

export function runCalendarMeetingLinkChecks(check) {
  check("identical titles are maximally similar", titleSimilarity("Quarterly review", "Quarterly review") === 1);
  check("completely different titles share nothing", titleSimilarity("Quarterly review", "Dentist") === 0);
  check("a superset title still overlaps substantially", titleSimilarity("Quarterly review", "Quarterly review with Adam") > 0.4);
  check("case and punctuation do not matter", titleSimilarity("Q3: Review!", "q3 review") > 0.5);
  check("an empty title is never similar to anything, including itself", titleSimilarity("", "") === 0 && titleSimilarity("", "Standup") === 0);

  check("overlapping windows match", windowsOverlap("2026-09-07T14:00:00Z", "2026-09-07T15:00:00Z", "2026-09-07T14:10:00Z", "2026-09-07T14:40:00Z"));
  check("disjoint windows do not, past the tolerance", !windowsOverlap("2026-09-07T14:00:00Z", "2026-09-07T15:00:00Z", "2026-09-07T16:00:00Z", "2026-09-07T17:00:00Z"));
  check(
    "a meeting started a few minutes after its calendar event still overlaps within tolerance",
    windowsOverlap("2026-09-07T14:00:00Z", "2026-09-07T14:30:00Z", "2026-09-07T14:12:00Z", "2026-09-07T15:00:00Z", 15 * 60 * 1000)
  );
  check("an unparseable time never overlaps", !windowsOverlap("nope", "2026-09-07T15:00:00Z", "2026-09-07T14:00:00Z", "2026-09-07T15:00:00Z"));

  // -- matchMeetingToEvent ---------------------------------------------------
  const single = matchMeetingToEvent({ title: "Totally different words", startedAt: "2026-09-07T14:05:00.000Z", endedAt: "2026-09-07T14:50:00.000Z" }, [candidate()]);
  check("a single overlapping candidate matches on the time window alone, whatever either was titled", single?.anchor === candidate().anchor);

  const twoCandidates = [
    candidate({ anchor: "evt-1111111111111111", title: "Quarterly review", start: "2026-09-07T14:00:00.000Z", end: "2026-09-07T14:30:00.000Z" }),
    candidate({ anchor: "evt-2222222222222222", title: "1:1 with Priya", start: "2026-09-07T14:15:00.000Z", end: "2026-09-07T14:45:00.000Z" }),
  ];
  const disambiguated = matchMeetingToEvent({ title: "Quarterly review", startedAt: "2026-09-07T14:02:00.000Z", endedAt: "2026-09-07T14:28:00.000Z" }, twoCandidates);
  check("with two overlapping candidates, title similarity breaks the tie", disambiguated?.anchor === "evt-1111111111111111");

  const noOverlap = matchMeetingToEvent({ title: "Quarterly review", startedAt: "2026-09-08T14:00:00.000Z" }, [candidate()]);
  check("no time overlap at all is no match, regardless of title", noOverlap === null);

  const lowSimilarityAmongMany = matchMeetingToEvent(
    { title: "Totally unrelated words", startedAt: "2026-09-07T14:20:00.000Z" },
    twoCandidates
  );
  check(
    "with a genuine choice to make and no title resemblance to either, there is no match rather than a guess",
    lowSimilarityAmongMany === null
  );

  check("no meeting or no candidates is handled without throwing", matchMeetingToEvent(null, [candidate()]) === null && matchMeetingToEvent({ startedAt: "x" }, null) === null);

  // -- calendarEventLink ------------------------------------------------
  check(
    "the link is an ordinary [[path#anchor]] wikilink, extension stripped",
    calendarEventLink("0-inbox/calendar/2026-09-07.md", "evt-0000000000000001") === "[[0-inbox/calendar/2026-09-07#evt-0000000000000001]]"
  );

  // -- candidatesFromDay ------------------------------------------------
  const day = {
    date: "2026-09-07",
    events: [
      { account: "a", calendarId: "primary", eventId: "e1", title: "Standup", status: "confirmed", start: { dateTime: "2026-09-07T13:00:00.000Z" }, end: { dateTime: "2026-09-07T13:15:00.000Z" } },
      { account: "a", calendarId: "primary", eventId: "e2", title: "Cancelled thing", status: "cancelled", start: { dateTime: "2026-09-07T13:30:00.000Z" }, end: { dateTime: "2026-09-07T14:00:00.000Z" } },
    ],
  };
  const candidates = candidatesFromDay(day);
  check("cancelled instances are never offered as a match candidate", candidates.length === 1 && candidates[0].title === "Standup");
  check("the candidate's anchor is the real eventAnchor, so a match points at a real heading", candidates[0].anchor === eventAnchor(day.events[0]));
  check("the candidate's path is the real calendar day path", candidates[0].path === "0-inbox/calendar/2026-09-07.md");
  check("an empty or malformed day produces no candidates rather than throwing", candidatesFromDay(null).length === 0 && candidatesFromDay({}).length === 0);

  // -- attachEventLink / readEventLink: the patch that actually lands the link
  const LINK = "[[0-inbox/calendar/2026-03-04#evt-0123456789abcdef]]";
  const MEETING_ID = "01234567-89ab-cdef-0123-456789abcdef";
  const meetingNote = renderMeetingNote(
    {
      id: MEETING_ID,
      title: "Weekly sync",
      state: "finished",
      startedAt: "2026-03-04T14:00:00.000Z",
      endedAt: "2026-03-04T14:30:00.000Z",
      recordedMs: 1_800_000,
      source: { kind: "zoom" },
      attendees: [],
      notes: "",
      transcript: [],
      flags: [],
      enhanced: null,
      templateId: null,
      device: { platform: "macos" },
      transcription: null,
      notePath: null,
      failureReason: null,
    },
    { now: "2026-03-04T15:00:00.000Z" }
  );

  check("a freshly rendered meeting note has no event link yet", readEventLink(meetingNote) === null);
  const withLink = attachEventLink(meetingNote, LINK);
  check("attachEventLink adds the key without disturbing anything else", withLink !== meetingNote && withLink.includes(`event: ${JSON.stringify(LINK)}`));
  check("readEventLink reads back exactly what was attached", readEventLink(withLink) === LINK);
  check(
    "every other frontmatter value, the title, the summary and the transcript are untouched",
    (() => {
      const before = meetingNote.split("\n");
      const after = withLink.split("\n");
      if (before.length !== after.length) return false;
      return before.every((line, i) => line.startsWith("event:") ? after[i].startsWith("event:") : line === after[i]);
    })() && parseMeetingNote(withLink).title === "Weekly sync"
  );
  check("attaching the same link again is idempotent — the result is byte-identical", attachEventLink(withLink, LINK) === withLink);

  const relinked = attachEventLink(withLink, "[[0-inbox/calendar/2026-03-05#evt-fedcba9876543210]]");
  check("attaching a different link replaces the old one rather than appending a second key", readEventLink(relinked) === "[[0-inbox/calendar/2026-03-05#evt-fedcba9876543210]]");
  check("...and there is still exactly one event: line", relinked.split("\n").filter((line) => line.startsWith("event:")).length === 1);

  check("a note with no frontmatter is returned completely unchanged, not guessed at", attachEventLink("# just a heading\n\nsome text", LINK) === "# just a heading\n\nsome text");
  check("readEventLink on such a note is null, not a thrown error", readEventLink("# just a heading\n\nsome text") === null);
  check("attachEventLink and readEventLink never throw on empty or missing input", attachEventLink("", LINK) === "" && readEventLink(undefined) === null);

  // A hand-written note using the same frontmatter convention (as mobile's
  // and desktop's own renderers do, independently of packages/meetings) is
  // patched exactly the same way — this function knows the YAML convention,
  // not any particular client's renderer.
  const foreignNote = '---\nupdated: "2026-03-04T15:00:00.000Z"\ntype: "meeting"\nstatus: "finished"\n---\n\n# Title\n';
  const foreignPatched = attachEventLink(foreignNote, LINK);
  check("a note this package did not render is patched the same way", readEventLink(foreignPatched) === LINK && foreignPatched.includes('status: "finished"'));
  check(
    "with no existing event: key, exactly one line is inserted — never a rewrite of the block",
    foreignPatched.split("\n").length === foreignNote.split("\n").length + 1 &&
      foreignPatched.split("\n").filter((line) => line.startsWith("event:")).length === 1
  );

  // -- sabotage record --------------------------------------------------
  //
  // Dropped the `overlapping.length > 1` guard so the title threshold applied
  // even to a single candidate — 1 check failed: a meeting whose recorder
  // title never matches an invite ("Totally different words") stopped
  // matching its own, only, overlapping calendar event.
}
