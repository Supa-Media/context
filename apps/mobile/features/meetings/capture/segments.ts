/**
 * The facts both recorders have to agree on — now three recorders, and so no
 * longer this app's to own.
 *
 * `audio.ts` and `audio.web.ts` are a platform split, and a platform split
 * cannot import from its own other half: Metro resolves `./audio` to
 * `audio.web.ts` inside a web bundle, so a web module reaching for the phone's
 * constant would import *itself*. That is why these lived in a third file, and
 * it is still why nothing imports them from a sibling recorder.
 *
 * The desktop app is the third recorder, in a different app and a different
 * runtime, and it needs exactly the same rotation clock and the same id scheme.
 * So the values moved to `@context/meetings/chunks`, beside the protocol they
 * serve, and this file re-exports them: every import in this app keeps working,
 * and there is one copy of `SEGMENT_MS` in the repository rather than two that
 * agree until somebody tunes one.
 */

export { MAX_INFLIGHT_CHUNKS, SEGMENT_MS, chunkIdFor, segmentIdFor } from "@context/meetings/chunks";
