/**
 * The facts both recorders have to agree on, in a file neither of them owns.
 *
 * `audio.ts` and `audio.web.ts` are a platform split, and a platform split
 * cannot import from its own other half: Metro resolves `./audio` to
 * `audio.web.ts` inside a web bundle, so a web module reaching for the phone's
 * constant would import *itself*. Putting these here is what keeps "the same
 * wall clock and the same id scheme on every platform" a shared line rather
 * than two copies that drift.
 */

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
 * sooner and lose less when one fails, and a chunk that fails is gone: this is
 * the one place in the feature with no retry, by design, because retrying would
 * mean keeping the audio.
 */
export const SEGMENT_MS = 20_000;

/**
 * How many chunks may be on their way to a transcriber at once.
 *
 * The send is deliberately off the device's critical path — a rotation closes a
 * file, reopens the microphone *immediately*, and hands the bytes to a
 * transcriber that answers whenever it answers — because waiting for the answer
 * meant 1.5–4s of every twenty was never recorded, cut mid-word, while the
 * offsets went on claiming the chunks were contiguous. The cost of detaching it
 * is that a link slower than `SEGMENT_MS` would grow a backlog with no ceiling,
 * on a device that is also recording.
 *
 * **At the bound a chunk is dropped, with an honest error, rather than queued.**
 * That is a decision rather than an omission. Queueing means holding somebody's
 * audio past the moment it would otherwise have been deleted — on the phone,
 * keeping the `.m4a` in the cache — and "the file dies before the request that
 * carries its contents" is what makes *audio is transient* a property of the
 * code rather than a line in a document. A bounded queue also only moves the
 * same decision `MAX_INFLIGHT_CHUNKS` chunks later, by which point the backlog
 * is minutes rather than seconds and nobody has been told anything. Three is a
 * minute of latency before the first drop, which is well past the point where a
 * transcript is still arriving usefully.
 */
export const MAX_INFLIGHT_CHUNKS = 3;

/**
 * The id a chunk keeps forever.
 *
 * Deterministic in both arguments, and neither of them is read at send time.
 * `Math.random()` or a timestamp taken when the request goes out would give the
 * same audio two different ids on a re-send, which is exactly the duplicate the
 * protocol's "the same segment id replaces" rule exists to prevent — and a
 * phone that loses signal mid-meeting re-sends as a matter of course.
 */
export function chunkIdFor(sessionKey: string, index: number): string {
  return `${sessionKey}-${index}`;
}
