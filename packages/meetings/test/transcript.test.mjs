/**
 * SEGMENTS AND TURNS — `src/transcript.js`.
 *
 * Two jobs, and both are about a client that re-sends.
 *
 * `mergeSegments` is keyed on the segment id and nothing else, so a phone that
 * buffered ten minutes offline and pushes them again produces the same
 * transcript rather than a stuttering duplicate of one. The ordering is total —
 * `startMs` then `endMs` then id — because two engines emit identical offsets
 * constantly, and an unstable sort would rewrite somebody's note on every save.
 *
 * `groupIntoTurns` is the difference between a note a person reads and a wall
 * of three-word fragments. It is the reason the appended transcript is worth
 * appending.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are FAIL lines across the
 * whole package suite.
 *
 *   `mergeSegments` keying on arrival order instead of the segment id         6
 *   `compareSegments` sorting on `startMs` alone, with no tie-break          2
 *   `normalizeSegment` accepting `endMs < startMs`                           1
 *   `groupIntoTurns` ignoring the speaker change                             4
 */

import {
  DEFAULT_TURN_GAP_MS,
  formatClock,
  MAX_SEGMENT_ID_CHARS,
  groupIntoTurns,
  mergeSegments,
  normalizeSegment,
  speakersIn,
  transcriptDuration,
} from "../src/transcript.js";
import { deepEqual, segment } from "./fixtures.mjs";

export function runTranscriptChecks(check) {
  /* --------------------------- normalizeSegment ------------------------- */

  const clean = normalizeSegment(segment());
  check("a well-formed segment survives normalization", clean !== null && clean.id === "seg-1");
  check("...keeping every protocol field", deepEqual(Object.keys(clean).sort(), ["channel", "confidence", "endMs", "id", "speaker", "startMs", "text"]));

  check("a segment with no id is refused", normalizeSegment(segment({ id: "" })) === null);
  check("...and one whose id is only whitespace", normalizeSegment(segment({ id: "   " })) === null);

  /*
    An id is a merge key, not content, and nothing bounded its length. The
    gateway caps a segment's *text* at 4,000 characters and a request body at
    2 MB, and caps how many segments a session may hold — but a record's size is
    never checked, so an unbounded id let a `context:write` grant inflate one
    session far past what those caps imply. That record lives under
    `.meetings/`, which `isPlumbing` hides from every note surface at every
    tier including the owner's, so the growth is invisible to the person paying
    for it. Refused rather than truncated, because two ids that differ only past
    the cut would merge into one segment and silently drop a turn.
  */
  check(
    "an id longer than the cap is refused",
    normalizeSegment(segment({ id: "x".repeat(MAX_SEGMENT_ID_CHARS + 1) })) === null
  );
  check(
    "...while one exactly at the cap survives",
    normalizeSegment(segment({ id: "x".repeat(MAX_SEGMENT_ID_CHARS) }))?.id.length === MAX_SEGMENT_ID_CHARS
  );
  check("a negative startMs is refused", normalizeSegment(segment({ startMs: -1 })) === null);
  check("a negative endMs is refused", normalizeSegment(segment({ endMs: -5 })) === null);
  check("an end before its start is refused", normalizeSegment(segment({ startMs: 5000, endMs: 4000 })) === null);
  check("a zero-length segment is fine — engines emit them", normalizeSegment(segment({ startMs: 100, endMs: 100 })) !== null);
  check("empty text is refused", normalizeSegment(segment({ text: "" })) === null);
  check("...and text that is only whitespace", normalizeSegment(segment({ text: " \n\t " })) === null);
  check("NaN offsets are refused", normalizeSegment(segment({ startMs: Number.NaN })) === null);
  check("Infinity is refused", normalizeSegment(segment({ endMs: Number.POSITIVE_INFINITY })) === null);
  check("a string offset is refused rather than coerced", normalizeSegment(segment({ startMs: "0" })) === null);
  check("null is refused without throwing", normalizeSegment(null) === null);
  check("a bare string is refused without throwing", normalizeSegment("seg") === null);

  check("hard-wrapped engine output is collapsed into a paragraph", normalizeSegment(segment({ text: "we\nshould\n  ship" })).text === "we should ship");
  check("an unknown speaker normalizes to null, not to an empty string", normalizeSegment(segment({ speaker: "  " })).speaker === null);
  check("an unrecognised channel falls back to mixed", normalizeSegment(segment({ channel: "bluetooth" })).channel === "mixed");
  check("confidence is clamped into 0..1", normalizeSegment(segment({ confidence: 7 })).confidence === 1);
  check("...and a missing confidence stays null rather than becoming zero", normalizeSegment(segment({ confidence: undefined })).confidence === null);

  /* ---------------------------- mergeSegments --------------------------- */

  const first = mergeSegments([], [segment({ id: "b", startMs: 2000, endMs: 3000, text: "two" })]);
  const second = mergeSegments(first, [segment({ id: "a", startMs: 0, endMs: 1000, text: "one" })]);
  check("merge sorts by start time, not arrival", second.map((s) => s.text).join(",") === "one,two");

  const resent = mergeSegments(second, [segment({ id: "a", startMs: 0, endMs: 1000, text: "one" })]);
  check("re-sending an identical segment changes nothing", deepEqual(second, resent));
  const corrected = mergeSegments(second, [segment({ id: "a", startMs: 0, endMs: 1000, text: "one, corrected" })]);
  check("...but the same id with new text replaces it", corrected.length === 2 && corrected[0].text === "one, corrected");

  check("merge does not mutate either argument", second.length === 2 && first.length === 1);
  check("garbage in a batch is dropped, not fatal", mergeSegments([], [segment({ id: "ok" }), null, segment({ text: "" })]).length === 1);

  const tied = mergeSegments(
    [],
    [
      segment({ id: "z", startMs: 1000, endMs: 2000, text: "z" }),
      segment({ id: "a", startMs: 1000, endMs: 2000, text: "a" }),
    ]
  );
  const tiedOtherWay = mergeSegments(
    [],
    [
      segment({ id: "a", startMs: 1000, endMs: 2000, text: "a" }),
      segment({ id: "z", startMs: 1000, endMs: 2000, text: "z" }),
    ]
  );
  check("segments at the same offset get a total order", deepEqual(tied, tiedOtherWay));
  check("...broken by id, so it is stable across clients", tied[0].id === "a");

  // The property in one line: merging is a function of the set, not the order.
  const forwards = mergeSegments([], [segment({ id: "a", startMs: 0, endMs: 1 }), segment({ id: "b", startMs: 5, endMs: 6 })]);
  const backwards = mergeSegments([segment({ id: "b", startMs: 5, endMs: 6 })], [segment({ id: "a", startMs: 0, endMs: 1 })]);
  check("two clients merging the same set in different orders agree", deepEqual(forwards, backwards));

  /* --------------------------- summary helpers -------------------------- */

  check("an empty transcript has no duration", transcriptDuration([]) === 0);
  check(
    "duration is the furthest end, not the sum, because channels overlap",
    transcriptDuration([segment({ id: "a", startMs: 0, endMs: 9000 }), segment({ id: "b", startMs: 1000, endMs: 4000 })]) === 9000
  );
  check(
    "speakers come back in the order they first spoke",
    deepEqual(
      speakersIn([
        segment({ id: "c", startMs: 3000, endMs: 4000, speaker: "Speaker One" }),
        segment({ id: "b", startMs: 2000, endMs: 3000, speaker: "Speaker Two" }),
        segment({ id: "a", startMs: 1000, endMs: 2000, speaker: "Speaker One" }),
      ]),
      ["Speaker One", "Speaker Two"]
    )
  );
  check("an unattributed segment contributes no speaker", speakersIn([segment({ speaker: null })]).length === 0);

  /* ---------------------------- groupIntoTurns -------------------------- */

  const run = groupIntoTurns([
    segment({ id: "a", startMs: 0, endMs: 2000, text: "so the pricing", speaker: "Speaker One" }),
    segment({ id: "b", startMs: 2200, endMs: 4000, text: "page needs work", speaker: "Speaker One" }),
    segment({ id: "c", startMs: 4500, endMs: 6000, text: "agreed", speaker: "Speaker Two" }),
    segment({ id: "d", startMs: 6100, endMs: 7000, text: "very much so", speaker: "Speaker Two" }),
  ]);
  check("consecutive segments from one speaker become one turn", run.length === 2);
  check("...joined into readable text", run[0].text === "so the pricing page needs work");
  check("...spanning from the first start to the last end", run[0].startMs === 0 && run[0].endMs === 4000);
  check("...and remembering which segments it folded in", deepEqual(run[0].segmentIds, ["a", "b"]));
  check("a speaker change always breaks the turn", run[1].speaker === "Speaker Two");

  const gapped = groupIntoTurns([
    segment({ id: "a", startMs: 0, endMs: 1000, speaker: "Speaker One", text: "one" }),
    segment({ id: "b", startMs: 1000 + DEFAULT_TURN_GAP_MS + 1, endMs: 40000, speaker: "Speaker One", text: "two" }),
  ]);
  check("a long silence breaks a turn even for the same speaker", gapped.length === 2);
  const tight = groupIntoTurns(
    [
      segment({ id: "a", startMs: 0, endMs: 1000, speaker: "Speaker One", text: "one" }),
      segment({ id: "b", startMs: 3000, endMs: 4000, speaker: "Speaker One", text: "two" }),
    ],
    { maxGapMs: 500 }
  );
  check("...and the gap is tunable", tight.length === 2);
  check(
    "unattributed segments still group with each other",
    groupIntoTurns([segment({ id: "a", startMs: 0, endMs: 1, speaker: null, text: "one" }), segment({ id: "b", startMs: 100, endMs: 200, speaker: null, text: "two" })]).length === 1
  );
  check("an empty transcript has no turns", groupIntoTurns([]).length === 0);
  check("garbage never reaches a turn", groupIntoTurns([segment({ text: "" })]).length === 0);
  check("grouping is order-independent, because merging is", deepEqual(run, groupIntoTurns([...[
    segment({ id: "d", startMs: 6100, endMs: 7000, text: "very much so", speaker: "Speaker Two" }),
    segment({ id: "b", startMs: 2200, endMs: 4000, text: "page needs work", speaker: "Speaker One" }),
    segment({ id: "c", startMs: 4500, endMs: 6000, text: "agreed", speaker: "Speaker Two" }),
    segment({ id: "a", startMs: 0, endMs: 2000, text: "so the pricing", speaker: "Speaker One" }),
  ]])));

  /* ----------------------------- formatClock ---------------------------- */

  check("the clock starts at 00:00", formatClock(0) === "00:00");
  check("...pads seconds", formatClock(9000) === "00:09");
  check("...rolls into minutes", formatClock(65_000) === "01:05");
  check("...and grows an hours field only when it needs one", formatClock(3_725_000) === "1:02:05");
  check("a negative offset clamps rather than rendering a minus", formatClock(-5) === "00:00");
}
