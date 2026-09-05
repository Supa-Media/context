/**
 * The two facts both recorders have to agree on, in a file neither of them owns.
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
