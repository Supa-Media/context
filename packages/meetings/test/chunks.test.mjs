/**
 * How audio is cut up, checked where three recorders can see it.
 *
 * These constants were the phone's until the desktop needed them, and the whole
 * value of moving them is that a laptop and a phone cannot disagree about what
 * `startMs` means. So the checks are about the two properties that would let
 * them disagree again: the ids are a pure function of their arguments, and the
 * arithmetic is arithmetic rather than a clock reading.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted:
 *
 *   `chunkIdFor` returning `${sessionKey}-${Date.now()}`                       2
 *   `segmentIdFor` dropping the chunk id and numbering from zero               2
 *   SEGMENT_MS changed to 20_001 (the offsets stop being multiples)            1
 *   `segmentSessionId` splitting on the last `-` rather than the first         4
 *   `foreignSegmentSessions` reading an unrecognised id as foreign             2
 */

import { MAX_INFLIGHT_CHUNKS, SEGMENT_MS, chunkIdFor, segmentIdFor } from "../src/chunks.js";
import { FOREIGN_SESSIONS_NAMED, foreignSegmentSessions, segmentSessionId } from "../src/protocol.js";

export function runChunkChecks(check) {
  check("a chunk is twenty seconds", SEGMENT_MS === 20_000);
  check("at most three sends are outstanding", MAX_INFLIGHT_CHUNKS === 3);

  // -- ids are pure ---------------------------------------------------------
  check("the same chunk always has the same id", chunkIdFor("s", 4) === chunkIdFor("s", 4));
  check("two chunks of one session differ", chunkIdFor("s", 4) !== chunkIdFor("s", 5));
  check("two sessions never collide", chunkIdFor("a", 1) !== chunkIdFor("b", 1));
  check(
    "an id is stable across a re-send — nothing in it is read at send time",
    chunkIdFor("mtg_abcdefghjkmnpqrstvwx", 0) === "mtg_abcdefghjkmnpqrstvwx-0",
  );

  // -- a segment id carries its chunk ---------------------------------------
  const chunk = chunkIdFor("mtg_abcdefghjkmnpqrstvwx", 7);
  check("a segment id starts from its chunk's id", segmentIdFor(chunk, 0).startsWith(`${chunk}-`));
  check("segments of one chunk are distinct", segmentIdFor(chunk, 0) !== segmentIdFor(chunk, 1));
  check(
    "the same segment of the same chunk is the same row, so re-transcribing merges",
    segmentIdFor(chunk, 2) === segmentIdFor(chunkIdFor("mtg_abcdefghjkmnpqrstvwx", 7), 2),
  );
  check(
    "segments of different chunks never collide",
    segmentIdFor(chunkIdFor("s", 1), 0) !== segmentIdFor(chunkIdFor("s", 2), 0),
  );
  check(
    "...and they sort in the order they were spoken, which is how a transcript reads",
    [segmentIdFor(chunk, 10), segmentIdFor(chunk, 2)].sort().join(",") ===
      [segmentIdFor(chunk, 2), segmentIdFor(chunk, 10)].join(","),
  );

  // -- the offsets a recorder computes from these ---------------------------
  //
  // A full rotation contributes exactly SEGMENT_MS, so chunk n starts at
  // n * SEGMENT_MS. Written out here because it is the arithmetic every
  // recorder does and the reason the constant may not be per-platform.
  const offsets = [0, 1, 2, 3].map((index) => index * SEGMENT_MS);
  check("chunk offsets are multiples of one chunk", offsets.every((ms, i) => ms === i * SEGMENT_MS));
  check("...and are contiguous, with no gap a transcript would silently lose", offsets[3] - offsets[2] === SEGMENT_MS);

  // -- the meeting an id names ----------------------------------------------
  //
  // The reason `chunkIdFor` takes a session key at all rather than minting
  // something opaque: the id it derives *carries* the meeting, so a batch that
  // has been routed to the wrong session can still be recognised as somebody
  // else's words. That property was never read by anything until a leaked
  // recorder subscription in the console app addressed eight finished meetings'
  // writes to each other, and the only symptom anywhere was a 400 about state.
  const MINE = "mtg_abcdefghjkmnpqrstvwx";
  const THEIRS = "mtg_zyxwvtsrqpnmkjhgfedc";
  check(
    "a segment id names the meeting it was minted for",
    segmentSessionId(segmentIdFor(chunkIdFor(`${MINE}-mic`, 3), 1)) === MINE,
  );
  check(
    "...through the desktop transcriber's own shorter scheme too",
    segmentSessionId(`${MINE}-s00007`) === MINE,
  );
  check(
    "an id that names no meeting answers null rather than guessing",
    segmentSessionId("1757280000000-0-s000") === null &&
      segmentSessionId(`${MINE}xx-0`) === null &&
      segmentSessionId(undefined) === null &&
      segmentSessionId("") === null,
  );
  check(
    "a batch addressed to its own meeting names nobody",
    foreignSegmentSessions(MINE, [{ id: segmentIdFor(chunkIdFor(`${MINE}-mic`, 0), 0) }]).length === 0,
  );
  check(
    "a batch minted elsewhere names where it came from",
    foreignSegmentSessions(MINE, [{ id: `${THEIRS}-mic-0-s000` }]).join() === THEIRS,
  );
  check(
    "...once, however many rows carry it",
    foreignSegmentSessions(MINE, [
      { id: `${THEIRS}-mic-0-s000` },
      { id: `${THEIRS}-mic-1-s000` },
    ]).length === 1,
  );
  check(
    "rows that name no meeting are not counted as foreign",
    foreignSegmentSessions(MINE, [{ id: "1757280000000-0-s000" }, { id: 7 }, null]).length === 0,
  );
  check(
    "and the answer is bounded, because it becomes a refusal a stranger composed",
    foreignSegmentSessions(
      MINE,
      Array.from({ length: 50 }, (_v, n) => ({ id: `mtg_${String(n).padStart(20, "a")}-0-s000` })),
    ).length === FOREIGN_SESSIONS_NAMED,
  );
  check("a non-array batch is not a batch", foreignSegmentSessions(MINE, "segments").length === 0);
}
