/**
 * ONE FILE PER MEETING — `src/note.js`.
 *
 * The owner decided: one meeting is one Markdown file, and the transcript is a
 * `## Transcript` section appended to the end of it. No sibling
 * `.transcript.md`. Everything here follows from that.
 *
 * Which puts the whole weight on the parser, because the file now contains two
 * kinds of text with very different rules:
 *
 * - **Ours** — frontmatter, the summary, the transcript. We wrote it, we can
 *   read it back.
 * - **Theirs** — `## My notes`. The human typed it, it is never rewritten, and
 *   it can contain anything: `---`, `key: value`, a fenced code block, or the
 *   literal line `## Transcript` because they are taking notes about this very
 *   format. **A user pasting `## Transcript` into their own notes must not
 *   truncate their note.** That is the check this file exists for, and it is
 *   held up by two rules rather than one: fenced regions are skipped, and the
 *   real transcript boundary is the *last* `## Transcript`, not the first.
 *
 * The YAML checks are the same argument in the frontmatter: an attendee name is
 * a string somebody else chose, and `Q3: "review"` is three ways to break a
 * naive `key: value` line.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are FAIL lines across the
 * whole package suite.
 *
 *   the frontmatter closed on the last `---` rather than the first           11
 *   `yamlScalar` emitting every value bare                                   10
 *   `fencedLines` returning all-false                                         6
 *   the transcript section rendered above the notes                           6
 *   `isHeading` allowing leading whitespace                                   5
 *   `splitTranscript` leaving the transcript in the head                      4
 *   `indexSections` taking the FIRST `## Transcript` instead of the last      3
 *   `## Summary` resolved to its last occurrence instead of its first         3
 *   `sectionBody` trimming instead of dropping exactly one blank line         3
 *   the human's notes reflowed on render                                      3
 *   `## My notes` resolved to its last occurrence instead of its first        1
 *
 * Two of these found a real hole rather than confirming a guard, and both are
 * the same hole. `fencedLines` and `isHeading` each scored **zero** at first,
 * because with real turns below, "the last `## Transcript` wins" resolved
 * every decoy on its own and the fence and indent rules were never consulted.
 * They are only load-bearing when there is no transcript underneath — a
 * notes-only meeting, or a note somebody edited in their vault — and the
 * suite had no such fixture. Adding them exposed something worse: the renderer
 * used to omit the transcript section when there were no turns, so on exactly
 * those notes-only meetings a user's own `## Transcript` line WAS the last one
 * and their notes were truncated. `renderMeetingNote` now always writes the
 * section, with a placeholder body, so the heading we control is always last.
 */

import {
  FRONTMATTER_KEYS,
  NOTES_HEADING,
  SUMMARY_HEADING,
  SUMMARY_PLACEHOLDER,
  TRANSCRIPT_HEADING,
  TRANSCRIPT_PLACEHOLDER,
  formatDuration,
  parseMeetingNote,
  renderMeetingNote,
  splitTranscript,
  yamlFlowList,
  yamlScalar,
} from "../src/note.js";
import { applyLog, createSession } from "../src/session.js";
import { FIXTURE_ID, at, deepEqual, segment } from "./fixtures.mjs";

const NOW = "2026-03-04T09:40:00.000Z";

/** A finished meeting, rendered at a fixed clock so nothing here is flaky. */
function finished(overrides = {}) {
  const base = createSession({ id: FIXTURE_ID, title: "Weekly sync", startedAt: at(0) });
  const session = applyLog(base, [
    { type: "start", at: at(0) },
    { type: "attendee", attendee: { name: "Attendee One", email: "one@example.test" } },
    { type: "attendee", attendee: { name: "Attendee Two", email: "two@example.test" } },
    {
      type: "segments",
      segments: [
        segment({ id: "a", startMs: 0, endMs: 4000, text: "so the pricing page", speaker: "Attendee One" }),
        segment({ id: "b", startMs: 4200, endMs: 8000, text: "needs another pass", speaker: "Attendee One" }),
        segment({ id: "c", startMs: 65_000, endMs: 68_000, text: "agreed, I will take it", speaker: "Attendee Two" }),
      ],
    },
    { type: "notes", markdown: "- pricing page\n- who owns it?" },
    { type: "end", at: at(30) },
    { type: "enhanced", markdown: "### Decisions\n- redo the pricing page", templateId: "default" },
    { type: "written", notePath: "0-inbox/meetings/2026/03/2026-03-04-weekly-sync-8h9jkmnp.md" },
  ]);
  return { ...session, ...overrides };
}

export function runNoteChecks(check) {
  const note = renderMeetingNote(finished(), { now: NOW });
  const parsed = parseMeetingNote(note);

  /* ------------------------------ structure ----------------------------- */

  const lines = note.split("\n");
  check("the note opens with frontmatter", lines[0] === "---");
  const writtenKeys = lines.slice(1, lines.indexOf("---", 1)).map((line) => line.slice(0, line.indexOf(":")));
  check("frontmatter keys are in the documented order", deepEqual(
    writtenKeys,
    ["updated", "type", "meeting-id", "started", "ended", "duration", "source", "attendees", "status"]
  ));
  check("...which is exactly what FRONTMATTER_KEYS says it is", deepEqual(writtenKeys, [...FRONTMATTER_KEYS]));
  check("the title is an H1", note.includes("\n# Weekly sync\n"));
  check("the sections appear in order", note.indexOf(SUMMARY_HEADING) < note.indexOf(NOTES_HEADING));
  check("...with the transcript last", note.indexOf(NOTES_HEADING) < note.indexOf(TRANSCRIPT_HEADING));
  check("there is exactly one transcript heading", note.split(`\n${TRANSCRIPT_HEADING}\n`).length === 2);
  check("the note ends with a newline", note.endsWith("\n"));

  /* ---------------------------- the transcript -------------------------- */

  check("turns are timestamped and attributed", note.includes("**[00:00] Attendee One** — so the pricing page needs another pass"));
  check("...and a later speaker gets their own turn at their own offset", note.includes("**[01:05] Attendee Two** — agreed, I will take it"));
  check(
    "a meeting with no transcript still gets the section, with a placeholder",
    parseMeetingNote(renderMeetingNote(finished({ transcript: [] }), { now: NOW })).transcript === TRANSCRIPT_PLACEHOLDER
  );
  check(
    "...because the heading being last, always, is what protects the notes above it",
    renderMeetingNote(finished({ transcript: [] }), { now: NOW }).trimEnd().endsWith(TRANSCRIPT_PLACEHOLDER)
  );
  check(
    "a hand-written note that simply has no transcript section parses as null",
    parseMeetingNote("# hello\n\n## My notes\n\nmine\n").transcript === null
  );
  check(
    "an unattributed turn still renders",
    renderMeetingNote(finished({ transcript: [segment({ id: "a", speaker: null, text: "someone said this" })] }), { now: NOW }).includes("**[00:00] Speaker** — someone said this")
  );

  /* ------------------------------- summary ------------------------------ */

  check("the generated note lands under Summary", parsed.summary === "### Decisions\n- redo the pricing page");
  check(
    "a meeting nobody enhanced still has a Summary section",
    parseMeetingNote(renderMeetingNote(finished({ enhanced: null }), { now: NOW })).summary === SUMMARY_PLACEHOLDER
  );

  /* ----------------------------- frontmatter ---------------------------- */

  check("updated is the clock we were given, not the wall clock", parsed.frontmatter.updated === NOW);
  check("type says what this file is", parsed.frontmatter.type === "meeting");
  check("the session id is recoverable from the file alone", parsed.frontmatter["meeting-id"] === FIXTURE_ID);
  check("started and ended round-trip", parsed.frontmatter.started === at(0) && parsed.frontmatter.ended === at(30));
  check("duration is the audio, in words", parsed.frontmatter.duration === "30m");
  check("source is the detected kind", parsed.frontmatter.source === "unknown");
  check("status is the session state", parsed.frontmatter.status === "complete");
  check("attendees come back as a list", deepEqual(parsed.frontmatter.attendees, ["Attendee One", "Attendee Two"]));
  check("...and an empty list stays a list", deepEqual(parseMeetingNote(renderMeetingNote(finished({ attendees: [] }), { now: NOW })).frontmatter.attendees, []));
  check("a meeting that never ended writes an empty ended", parseMeetingNote(renderMeetingNote(finished({ endedAt: null }), { now: NOW })).frontmatter.ended === "");

  check("formatDuration counts seconds under a minute", formatDuration(42_000) === "42s");
  check("...minutes under an hour", formatDuration(31 * 60_000) === "31m");
  check("...and hours past one", formatDuration(3_900_000) === "1h 05m");
  check("...and does not render a negative", formatDuration(-1) === "0s");

  /* ------------------------------ YAML safety --------------------------- */

  check("a plain word is left bare", yamlScalar("meeting") === "meeting");
  check("a value with a colon is quoted", yamlScalar("Q3: review") === '"Q3: review"');
  check("a value with a quote is escaped", yamlScalar('say "hi"') === '"say \\"hi\\""');
  check("a backslash is escaped before the quotes are", yamlScalar('a\\"b') === '"a\\\\\\"b"');
  check("a newline never breaks out of the scalar", !yamlScalar("a\nb").includes("\n"));
  check("a leading # is quoted, or it would read as a comment", yamlScalar("#1") === '"#1"');
  check("a leading dash is quoted, or it would read as a list item", yamlScalar("- item") === '"- item"');
  check("`no` is quoted, or a YAML 1.1 reader makes it false", yamlScalar("no") === '"no"');
  check("an empty value is quoted rather than omitted", yamlScalar("") === '""');
  check("a flow list quotes each item", yamlFlowList(['a, b', 'c "d"']) === '["a, b", "c \\"d\\""]');
  check("an empty flow list is []", yamlFlowList([]) === "[]");

  // The one the brief names: a title with a colon, quotes, an em dash and a
  // hash, plus attendees carrying the same characters.
  const hostile = finished({
    title: 'Q3: "review" — #1',
    attendees: [
      { name: 'Attendee, "One"', email: "one@example.test" },
      { name: "- Attendee: Two #2", email: "two@example.test" },
    ],
  });
  const hostileNote = renderMeetingNote(hostile, { now: NOW });
  const hostileParsed = parseMeetingNote(hostileNote);
  check("a hostile title does not break the frontmatter", hostileParsed.frontmatter["meeting-id"] === FIXTURE_ID);
  check("...the frontmatter still closes where it should", hostileNote.split("\n").indexOf("---", 1) === 10);
  check("...the title survives as the H1, verbatim", hostileParsed.title === 'Q3: "review" — #1');
  check("...and hostile attendee names round-trip exactly", deepEqual(hostileParsed.frontmatter.attendees, ['Attendee, "One"', "- Attendee: Two #2"]));
  check("...with every frontmatter key still readable", deepEqual(Object.keys(hostileParsed.frontmatter).length, 9));

  /* --------------------- the human's notes are theirs ------------------- */

  const NASTY_NOTES = [
    "- they want it by Q3",
    "",
    "---",
    "",
    "updated: not really",
    "status: definitely not",
    "",
    "```yaml",
    "---",
    "type: meeting",
    "---",
    "```",
    "",
    "```",
    "## Transcript",
    "",
    "**[00:00] Nobody** — this is pasted, not recorded",
    "```",
    "",
    "## Summary",
    "",
    "and a heading of my own",
  ].join("\n");

  const nasty = renderMeetingNote(finished({ notes: NASTY_NOTES }), { now: NOW });
  const nastyParsed = parseMeetingNote(nasty);
  check("notes containing --- round-trip exactly", nastyParsed.notes === NASTY_NOTES);
  check("...including a fenced `## Transcript`", nastyParsed.notes.includes("```\n## Transcript\n"));
  check("...and their own `## Summary` heading", nastyParsed.notes.includes("## Summary\n\nand a heading of my own"));
  check("the real transcript is still found", nastyParsed.transcript?.startsWith("**[00:00] Attendee One**") === true);
  check("...and their pasted turn is not in it", nastyParsed.transcript?.includes("**[00:00] Nobody**") === false);
  check("...and is not the pasted one", nastyParsed.transcript?.includes("this is pasted") === false);
  check("the real summary is still the generated one", nastyParsed.summary === "### Decisions\n- redo the pricing page");
  check("the frontmatter is not the one in their code fence", nastyParsed.frontmatter.status === "complete");

  // Unfenced, which is the harder case: the boundary rule is "the last one",
  // and the renderer always writes ours after theirs.
  const UNFENCED = "I keep notes about this format:\n\n## Transcript\n\nthat heading above is mine, not the recorder's";
  const unfencedNote = renderMeetingNote(finished({ notes: UNFENCED }), { now: NOW });
  const unfenced = parseMeetingNote(unfencedNote);
  check("an unfenced `## Transcript` in someone's notes does not truncate them", unfenced.notes === UNFENCED);
  check("...and the real transcript is still the one below it", unfenced.transcript?.includes("Attendee One") === true);
  check("...and does not swallow their sentence into the transcript", unfenced.transcript?.includes("that heading above is mine") === false);
  check(
    "...nor does splitTranscript drop their sentence from the head",
    splitTranscript(unfencedNote).head.includes("that heading above is mine")
  );
  check(
    "...while still leaving the recorded turns behind",
    splitTranscript(unfencedNote).head.includes("**[00:00] Attendee One**") === false
  );

  const NOTES_HEADING_IN_NOTES = "## My notes\n\nyes, I wrote that heading myself";
  const doubled = parseMeetingNote(renderMeetingNote(finished({ notes: NOTES_HEADING_IN_NOTES }), { now: NOW }));
  check("their own `## My notes` heading survives too", doubled.notes === NOTES_HEADING_IN_NOTES);

  check("empty notes round-trip as empty", parseMeetingNote(renderMeetingNote(finished({ notes: "" }), { now: NOW })).notes === "");
  check(
    "notes that end in blank lines keep them, exactly",
    parseMeetingNote(renderMeetingNote(finished({ notes: "a\n\n" }), { now: NOW })).notes === "a\n\n"
  );
  check(
    "notes that are only whitespace are not tidied away",
    parseMeetingNote(renderMeetingNote(finished({ notes: "   " }), { now: NOW })).notes === "   "
  );
  // The decoys below run against a meeting whose own transcript is EMPTY. That
  // is the shape where the fence and indent rules carry the whole weight: with
  // real turns below, "the last heading wins" would resolve it anyway, and a
  // broken fence scanner would sail through.
  const decoy = (text) => parseMeetingNote(renderMeetingNote(finished({ transcript: [], notes: text }), { now: NOW }));
  const FENCED = "```\n## Transcript\n```";
  const TILDE_FENCED = "~~~\n## Transcript\n~~~";
  const INDENTED = "    ## Transcript\n    still mine";
  check("a backtick fence hides a heading, even with no real transcript below", decoy(FENCED).notes === FENCED);
  check("...and no transcript is invented out of it", decoy(FENCED).transcript === TRANSCRIPT_PLACEHOLDER);
  check("a tilde fence hides one too", decoy(TILDE_FENCED).notes === TILDE_FENCED);
  check("an indented code block is not a section break either", decoy(INDENTED).notes === INDENTED);
  check("...nor is it one to splitTranscript", splitTranscript(renderMeetingNote(finished({ transcript: [], notes: INDENTED }), { now: NOW })).head.includes("still mine"));
  check("a fenced `## My notes` in the notes is not a boundary", decoy("```\n## My notes\n```").notes === "```\n## My notes\n```");

  // And the same rule on the other side of the file: a generated summary that
  // talks about this format must not eat the section below it.
  const chatty = parseMeetingNote(renderMeetingNote(finished({ enhanced: "### Format\n\n```\n## My notes\n## Transcript\n---\n```" }), { now: NOW }));
  check("a fenced heading inside the generated summary is not a boundary", chatty.summary.includes("## My notes"));
  check("...and the human's notes are still found below it", chatty.notes === "- pricing page\n- who owns it?");

  /* ---------------------------- splitTranscript ------------------------- */

  const split = splitTranscript(note);
  check("splitTranscript returns the note without its transcript", !split.head.includes(TRANSCRIPT_HEADING));
  check("...keeping the frontmatter, summary and notes", split.head.includes(SUMMARY_HEADING) && split.head.includes(NOTES_HEADING));
  check("...and the transcript separately", split.transcript?.includes("Attendee Two") === true);
  check("...which is what the caller saves by not sending", split.head.length < note.length);
  check("head ends with a newline, so it is a whole document", split.head.endsWith("\n"));
  check(
    "a hand-written note with no transcript section comes back whole and unsplit",
    (() => {
      const plain = "# hello\n\n## My notes\n\nmine\n";
      const result = splitTranscript(plain);
      return result.transcript === null && result.head === plain;
    })()
  );
  check(
    "splitTranscript honours the fence rule as well",
    splitTranscript(nasty).head.includes("**[00:00] Attendee One**") === false
  );
  check(
    "...keeping the fenced text that only looks like a transcript",
    splitTranscript(nasty).head.includes("this is pasted, not recorded")
  );
  check(
    "the split head and the transcript together still hold everything",
    splitTranscript(note).head.length + (splitTranscript(note).transcript?.length ?? 0) > note.length - 40
  );
  check("splitting is stable: doing it twice changes nothing", splitTranscript(splitTranscript(note).head).head === splitTranscript(note).head);
  check("an empty document does not throw", deepEqual(splitTranscript(""), { head: "", transcript: null }));
  check("a non-string does not throw", splitTranscript(undefined).transcript === null);

  /* ------------------------------ round trip ---------------------------- */

  const reparsed = parseMeetingNote(renderMeetingNote(finished(), { now: NOW }));
  check("frontmatter round-trips key for key", deepEqual(reparsed.frontmatter, parsed.frontmatter));
  check("notes round-trip byte for byte", reparsed.notes === finished().notes);
  check("rendering is deterministic given the same clock", renderMeetingNote(finished(), { now: NOW }) === note);
  // Notes come back out of a bucket the customer owns and edits in Obsidian, so
  // the parser has to survive documents this package did not render — including
  // one where somebody deleted the transcript section but kept a lookalike in
  // their own prose.
  const HAND_WRITTEN = [
    "# Weekly sync",
    "",
    "## My notes",
    "",
    "reminder of the format:",
    "",
    "    ## Transcript",
    "    (indented, so it is mine)",
    "",
    "```",
    "## Transcript",
    "```",
    "",
    "and that is the end of my notes",
    "",
  ].join("\n");
  const handParsed = parseMeetingNote(HAND_WRITTEN);
  check("a hand-edited note with no transcript section keeps every line of the notes", handParsed.notes.includes("and that is the end of my notes"));
  check("...including the indented lookalike", handParsed.notes.includes("    ## Transcript"));
  check("...and the fenced one", handParsed.notes.includes("```\n## Transcript\n```"));
  check("...and reports no transcript at all", handParsed.transcript === null);
  check("splitTranscript leaves such a note whole", splitTranscript(HAND_WRITTEN).head === HAND_WRITTEN);

  check("parsing a hand-written note without frontmatter does not throw", deepEqual(parseMeetingNote("# hello\n").frontmatter, {}));
  check("...and still finds the title", parseMeetingNote("# hello\n").title === "hello");
  check("parsing an empty string does not throw", parseMeetingNote("").notes === "");
}
