// How a recorder cuts audio into pieces, in the one file every recorder reads.
//
// Three surfaces now capture a meeting — the phone, the web app and the desktop
// app — and all three have the same problem in the same shape: a `MediaRecorder`
// or an `expo-audio` recording produces a stream, a transcription engine takes
// **complete, self-contained files**, and something has to decide where one
// stops and the next begins. That decision is arithmetic (an offset is the sum
// of the durations before it) and identity (a chunk keeps its id across a
// re-send), and neither is platform-specific.
//
// It lived in `apps/mobile/features/meetings/capture/segments.ts`, which was
// exactly right while the only two readers were that app's two recorders. The
// desktop is a third, in a different app, in a different runtime, and a copy of
// `SEGMENT_MS` on the desktop is how a transcript recorded on a laptop and one
// recorded on a phone quietly stop agreeing about what `startMs` means.
//
// Plain ESM with JSDoc, like the rest of this package: Metro, esbuild and the
// Workers bundler all take it as-is, and the mobile module is now a re-export
// so nothing there had to change.

/**
 * How long one chunk of audio is.
 *
 * A fixed wall clock, so `startMs`/`endMs` come out of arithmetic rather than a
 * guess: chunk *n* begins at the sum of the durations before it, and a full
 * rotation contributes exactly this.
 *
 * Twenty seconds is a compromise with two named sides. Longer chunks transcribe
 * better — the model sees more context, and fewer words are cut in half at a
 * boundary — and cost fewer requests. Shorter chunks put words on the screen
 * sooner and lose less when one fails. (A failed chunk used to be gone for
 * good — no retry, because retrying meant keeping the audio. Since 2026-09-18
 * the phone keeps it and retries; `docs/decisions/meetings.md`, *Audio nobody
 * has transcribed yet is kept on the device*.)
 */
export const SEGMENT_MS = 20_000;

/**
 * How many chunks may be on their way to a transcriber at once.
 *
 * The send is deliberately off the device's critical path — a rotation closes a
 * file, reopens the microphone *immediately*, and hands the bytes to a
 * transcriber that answers whenever it answers — because waiting for the answer
 * meant seconds of every twenty were never recorded, cut mid-word, while the
 * offsets went on claiming the chunks were contiguous. The cost of detaching it
 * is that a link slower than `SEGMENT_MS` would grow a backlog with no ceiling,
 * on a device that is also recording.
 *
 * **It is a bound on concurrency, not on what is kept.** It used to be the point
 * at which a chunk was *dropped*, with an honest error, on the argument that
 * queueing meant holding somebody's audio past the moment it would otherwise
 * have been deleted. That was reversed on 2026-09-18 for the phone: a chunk
 * past the bound waits in the device's spool and is sent later
 * (`docs/decisions/meetings.md`, *Audio nobody has transcribed yet is kept on
 * the device*). A recorder with nowhere to keep audio — a browser, a phone
 * whose disk is full — still drops at the bound and says so. Three is a minute
 * of latency, which is well past the point where a live transcript is still
 * arriving usefully.
 */
export const MAX_INFLIGHT_CHUNKS = 3;

/**
 * The id a chunk keeps forever.
 *
 * Deterministic in both arguments, and neither of them is read at send time.
 * `Math.random()` or a timestamp taken when the request goes out would give the
 * same audio two different ids on a re-send, which is exactly the duplicate the
 * protocol's "the same segment id replaces" rule exists to prevent — and a
 * client that loses signal mid-meeting re-sends as a matter of course.
 *
 * @param {string} sessionKey Identity of this capture session.
 * @param {number} index      Zero-based chunk number within the session.
 * @returns {string}
 */
export function chunkIdFor(sessionKey, index) {
  return `${sessionKey}-${index}`;
}

/**
 * The id one transcript segment keeps forever.
 *
 * A chunk yields several segments and the protocol merges by segment id, so the
 * id has to be stable in *both* coordinates: which chunk it came from, and
 * where in that chunk it sat. Derived from `chunkIdFor` rather than minted,
 * for the same reason — re-transcribing the same audio must land on the same
 * rows rather than doubling the transcript.
 *
 * @param {string} chunkId From `chunkIdFor`.
 * @param {number} index   Zero-based segment number within the chunk.
 * @returns {string}
 */
export function segmentIdFor(chunkId, index) {
  return `${chunkId}-s${String(index).padStart(3, "0")}`;
}
