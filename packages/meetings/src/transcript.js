// Transcript segments: the only mutable-looking thing in a meeting, and the one
// most likely to arrive twice.
//
// A phone that lost signal mid-meeting re-sends everything it buffered, and the
// desktop app re-sends the tail of its log on every reconnect. So the merge is
// keyed on the client-generated segment id and nothing else: the same id
// replaces, it never duplicates. Ordering is by `startMs` then id, so two
// clients that merge the same segments in different orders land on the same
// array — which is what makes the rendered note stable.

import { TRANSCRIPT_CHANNELS } from "./protocol.js";

/** @typedef {import("./protocol.js").TranscriptSegment} TranscriptSegment */

/**
 * Channels an engine is allowed to label a segment with — the contract's list,
 * as a `Set` for the membership check. It was spelled out again here, which is
 * one more place for the union in protocol.js to be right about and this file
 * to be wrong.
 */
const CHANNELS = new Set(TRANSCRIPT_CHANNELS);

/**
 * Consecutive segments from the same speaker closer together than this are one
 * turn. Eight seconds is long enough to survive a thinking pause and short
 * enough that a genuine hand-back reads as a new turn.
 */
export const DEFAULT_TURN_GAP_MS = 8000;

/** What a turn is labelled when diarization gave no speaker. */
export const UNKNOWN_SPEAKER = "Speaker";

/**
 * The longest a segment id may be.
 *
 * An id is a merge key, not content. The gateway caps a segment's *text* and
 * the size of one request, and caps how many segments a session may hold — but
 * nothing checks the size of the stored record, so an unbounded id let a
 * `context:write` grant inflate one session far past what those caps imply.
 * The record lives under `.meetings/`, which `isPlumbing` hides from every note
 * surface at every tier including the owner's, so that growth is invisible to
 * the person whose storage bill it lands on.
 *
 * **Why 200, and what it is coupled to.** The longest id any real client mints
 * is the transcription path's: `functions/meetings/transcribe.ts` builds
 * `` `${chunkId}-${index}` `` from a `chunkId` its own validator caps at
 * `MAX_CHUNK_ID_LENGTH` = 128, so ~133 characters. The recorders mint far
 * shorter ones (`<Date.now()>-<index>`, and the desktop's session id plus a
 * padded index, ~31). 200 leaves 67 characters of headroom over the longest
 * real scheme and is far below anything that matters in aggregate.
 *
 * **That coupling is not enforced by the type system and it is one edit from
 * biting.** Raise `MAX_CHUNK_ID_LENGTH` past 192 and every segment from the
 * transcription path starts being refused here — silently, from the user's
 * seat, because the ack reports `rejected` and no client reads that field yet.
 * A meeting would simply produce an empty transcript, which is the one outcome
 * `capture/audio.ts` says this feature exists to prevent. The two constants
 * live in different packages with separate test runners, so
 * `apps/convex/__tests__/meetingTranscribe.test.ts` asserts the relationship
 * between them; that assertion is the guard, not this paragraph.
 *
 * **Why a refusal is in the shared core at all**, when `state.js` says refusing
 * is the gateway's job and a phone folding its own log offline "has no business
 * refusing its owner's meeting": because this is not a policy about a caller,
 * it is the merge key's own grammar. A key too long to be a key is malformed in
 * the same way an empty one is, and the check sits beside that one. Every
 * *authorization* refusal stays where that comment puts it.
 *
 * **One edge, stated rather than glossed.** `mergeSegments` re-normalizes the
 * rows it already holds, so a record that somehow already contains an oversized
 * id loses that row on the next unrelated append, and `countUnusable` looks only
 * at the incoming batch — so nothing counts it. In-flight records are
 * short-lived and no shipped client mints such an id, so this is a caveat and
 * not a live loss; it is written down because it is the one case where this
 * guard does what its own rationale calls worse than the alternative.
 */
export const MAX_SEGMENT_ID_CHARS = 200;

/**
 * Coerce one segment into the shape the rest of the package may assume, or
 * return `null`.
 *
 * Returning null rather than throwing is deliberate: a batch of fifty segments
 * with one bad row should store forty-nine, not fail the meeting. The caller
 * that cares (the gateway) can count the difference and log it.
 *
 * @param {unknown} input
 * @returns {TranscriptSegment|null}
 */
export function normalizeSegment(input) {
  if (!input || typeof input !== "object") return null;
  const raw = /** @type {Record<string, unknown>} */ (input);

  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id) return null;
  // Refused, never truncated: two ids differing only past the cut would merge
  // into one segment, and losing a turn is worse than losing the batch row.
  if (id.length > MAX_SEGMENT_ID_CHARS) return null;

  const startMs = toMs(raw.startMs);
  const endMs = toMs(raw.endMs);
  if (startMs === null || endMs === null) return null;
  // A segment that ends before it starts is a clock bug on the client, not a
  // recoverable rounding error. Refuse it rather than sorting it into the note.
  if (endMs < startMs) return null;

  // Whitespace is collapsed, not just trimmed: engines emit hard-wrapped text
  // and a turn built out of it has to read as a paragraph.
  const text = String(raw.text ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;

  const speaker = typeof raw.speaker === "string" && raw.speaker.trim() ? raw.speaker.trim() : null;
  const channel = typeof raw.channel === "string" && CHANNELS.has(raw.channel) ? raw.channel : "mixed";

  let confidence = null;
  if (typeof raw.confidence === "number" && Number.isFinite(raw.confidence)) {
    confidence = Math.min(1, Math.max(0, raw.confidence));
  }

  return { id, startMs, endMs, text, speaker, channel, confidence };
}

/**
 * @param {unknown} value
 * @returns {number|null} A non-negative integer millisecond offset, or null.
 */
function toMs(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0) return null;
  return Math.round(value);
}

/**
 * Merge `incoming` into `existing`, keyed by segment id.
 *
 * Neither argument is mutated. Same id replaces; the result is sorted by
 * `startMs` then id so it is a pure function of the *set* of segments, not of
 * the order they arrived in.
 *
 * @param {TranscriptSegment[]} existing
 * @param {unknown[]} incoming
 * @returns {TranscriptSegment[]}
 */
export function mergeSegments(existing, incoming) {
  /** @type {Map<string, TranscriptSegment>} */
  const byId = new Map();
  for (const segment of existing ?? []) {
    const normalized = normalizeSegment(segment);
    if (normalized) byId.set(normalized.id, normalized);
  }
  for (const segment of incoming ?? []) {
    const normalized = normalizeSegment(segment);
    if (normalized) byId.set(normalized.id, normalized);
  }
  return [...byId.values()].sort(compareSegments);
}

/**
 * Total ordering. Sorting on `startMs` alone is not total — two engines emit
 * the same offset constantly — and an unstable order would rewrite the note on
 * every save.
 *
 * @param {TranscriptSegment} a
 * @param {TranscriptSegment} b
 */
function compareSegments(a, b) {
  if (a.startMs !== b.startMs) return a.startMs - b.startMs;
  if (a.endMs !== b.endMs) return a.endMs - b.endMs;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * How much of the meeting the transcript actually covers, in milliseconds.
 *
 * The furthest `endMs`, not the sum: segments overlap when two channels are
 * transcribed separately.
 *
 * @param {TranscriptSegment[]} segments
 * @returns {number}
 */
export function transcriptDuration(segments) {
  let end = 0;
  for (const segment of segments ?? []) {
    if (segment && typeof segment.endMs === "number" && segment.endMs > end) end = segment.endMs;
  }
  return end;
}

/**
 * Distinct speakers, in the order they first spoke. First-appearance order
 * rather than alphabetical, because the note reads chronologically.
 *
 * @param {TranscriptSegment[]} segments
 * @returns {string[]}
 */
export function speakersIn(segments) {
  const seen = [];
  for (const segment of mergeSegments(segments ?? [], [])) {
    if (segment.speaker && !seen.includes(segment.speaker)) seen.push(segment.speaker);
  }
  return seen;
}

/**
 * @typedef {Object} TranscriptTurn
 * @property {string|null} speaker
 * @property {number} startMs
 * @property {number} endMs
 * @property {string} text
 * @property {string[]} segmentIds  The segments folded in, for traceability.
 */

/**
 * Collapse consecutive same-speaker segments into readable turns.
 *
 * This is the difference between a note somebody reads and a wall of
 * three-word fragments. A speaker change always breaks a turn; a gap longer
 * than `maxGapMs` breaks it too, because a long silence is a hand-back even
 * when the same person resumes.
 *
 * @param {TranscriptSegment[]} segments
 * @param {{maxGapMs?: number}} [options]
 * @returns {TranscriptTurn[]}
 */
export function groupIntoTurns(segments, options = {}) {
  const maxGapMs =
    typeof options.maxGapMs === "number" && Number.isFinite(options.maxGapMs) && options.maxGapMs >= 0
      ? options.maxGapMs
      : DEFAULT_TURN_GAP_MS;

  /** @type {TranscriptTurn[]} */
  const turns = [];
  for (const segment of mergeSegments(segments ?? [], [])) {
    const open = turns[turns.length - 1];
    const continues =
      open !== undefined && open.speaker === segment.speaker && segment.startMs - open.endMs <= maxGapMs;
    if (continues) {
      open.text = `${open.text} ${segment.text}`;
      open.endMs = Math.max(open.endMs, segment.endMs);
      open.segmentIds.push(segment.id);
      continue;
    }
    turns.push({
      speaker: segment.speaker,
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: segment.text,
      segmentIds: [segment.id],
    });
  }
  return turns;
}

/**
 * `mm:ss`, or `h:mm:ss` once a meeting runs past the hour. Used by the note
 * renderer and by the enhancement prompt, so it lives with the transcript.
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatClock(ms) {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}
