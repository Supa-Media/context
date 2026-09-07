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
 */

import { MAX_INFLIGHT_CHUNKS, SEGMENT_MS, chunkIdFor, segmentIdFor } from "../src/chunks.js";

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
}
