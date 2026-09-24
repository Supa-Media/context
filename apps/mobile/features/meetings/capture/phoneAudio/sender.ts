import type { TranscriptSegment } from "../../protocol";
import type { RecorderError } from "../index";
import { MAX_INFLIGHT_CHUNKS } from "../segments";
import { resolveTranscriber } from "../transcriber";
import { captureOffline } from "../connectivity";
import {
  audioSpool,
  claimChunk,
  releaseChunk,
  spoolChanged,
  type SpoolSource,
  type SpooledChunk,
} from "../spool";
import type { RecorderInternals } from "./internals";
import { CHUNK_FAILED, CHUNK_KEPT, NO_SPEECH } from "./messages";
import { CHUNK_MIME, type Payload } from "./recordingFormat";
import { discard } from "./recordingFiles";

/**
 * The send half of the phone recorder: into the spool, out to the transcriber,
 * and back to whoever is listening. Every function here is the one that used
 * to sit in `audio.ts`'s closure; the state it reads is the recorder's own,
 * reached through `rec`, which never leaves `capture/`.
 */
export function createSender(
  rec: RecorderInternals,
  deps: { report(error: RecorderError): void },
) {
  const { report } = deps;

  function emit(segment: TranscriptSegment): void {
    for (const listener of rec.segmentListeners) listener(segment);
  }

  /**
   * Whether a chunk may go out now, or should wait in the spool.
   *
   * Offline is `connectivity.ts`'s answer, pushed in from the reachability
   * hook. The bound is `MAX_INFLIGHT_CHUNKS`, which is about *network
   * concurrency* and nothing else now: a chunk past it is not dropped, it is
   * kept, and the drain sends it when the recorder is not already three deep.
   */
  function canSendNow(): boolean {
    return !captureOffline() && rec.inFlight.size < MAX_INFLIGHT_CHUNKS;
  }

  /** Put a chunk in the spool, or answer `null` if this build or disk cannot. */
  function keep(
    placement: { meetingId: string; index: number; offsetMs: number; durationMs: number },
    source: SpoolSource,
  ): SpooledChunk | null {
    const spool = audioSpool();
    if (spool === null) return null;
    try {
      return spool.keep(placement, source, rec.epoch);
    } catch {
      return null;
    }
  }

  /**
   * Start a send and forget about it.
   *
   * This is the line that keeps the microphone off the network's critical path:
   * the caller has already reopened recording by the time anything here has
   * been awaited. Out-of-order arrival is fine — a segment carries its own id
   * and `startMs` — and a failure is one chip rather than a gap in the audio.
   */
  function dispatch(
    audio: Payload,
    chunkId: string,
    offsetMs: number,
    durationMs: number,
  ): void {
    /*
      Only a rotated chunk owns a file. A slice out of a continuous recording
      owns nothing — its bytes are already in memory and the file it came from
      belongs to the meeting, not to this request — so there is no uri to guard
      from `releaseDevice` and nothing for `send` to delete.
    */
    const owned = "uri" in audio ? audio.uri : null;
    const spooled = "spooled" in audio ? audio.spooled : null;
    /*
      A spooled chunk the drain already holds is the drain's to send. It cannot
      happen from the ticks — a chunk is dispatched in the same breath it is
      kept — but it is the one guard between two senders and one budget.
    */
    if (spooled !== null && !claimChunk(spooled)) return;
    if (owned !== null) rec.inFlightUris.add(owned);
    const run = send(audio, chunkId, offsetMs, durationMs)
      .catch(() => {
        /*
          A spooled chunk is still on the device, so this is a delay rather
          than a loss — and offline it is not even news: the screen already
          says the recording is being kept. Only a chunk that was never kept is
          a gap, and only that one gets the sentence that says so.
        */
        if (spooled === null) report({ recoverable: true, message: CHUNK_FAILED });
        else if (!captureOffline()) report({ recoverable: true, message: CHUNK_KEPT });
      })
      .finally(() => {
        rec.inFlight.delete(run);
        if (owned !== null) rec.inFlightUris.delete(owned);
        if (spooled !== null) {
          releaseChunk(spooled);
          // Confirmed or not, the drain may now want to look again.
          spoolChanged();
        }
      });
    rec.inFlight.add(run);
  }

  /** Wait for what is already out. Only ever called with the device released. */
  async function drainSends(): Promise<void> {
    await Promise.allSettled([...rec.inFlight]);
  }

  async function send(
    audio: Payload,
    chunkId: string,
    offsetMs: number,
    durationMs: number,
  ): Promise<void> {
    if ("spooled" in audio) {
      await sendSpooled(audio.spooled, audio.base64);
      return;
    }
    let audioBase64 = "";
    if ("uri" in audio) {
      try {
        audioBase64 = await audio.base64();
      } finally {
        /*
          THE FALLBACK ONLY: a chunk the spool could not take (point 5).

          The file dies here — before the request that carries its contents, not
          after it. Its bytes are already in a local that goes out of scope with
          this call, so nothing is lost by deleting early, and a crash, a kill or
          a failed request cannot leave a recording of somebody's meeting sitting
          in the app's cache directory.

          A continuous slice has no branch here and needs none: it never had a
          file of its own, and the recording it was cut from is deleted by
          `releaseDevice` when the meeting ends — which is the same promise one
          layer out, kept once instead of once per twenty seconds.
        */
        discard(audio.uri);
      }
    } else {
      audioBase64 = audio.base64;
    }
    if (audioBase64.length === 0) return;

    const transcriber = resolveTranscriber();
    if (transcriber === null) return;

    const { segments, refusedSegments } = await transcriber.transcribe({
      audioBase64,
      mimeType: "uri" in audio ? CHUNK_MIME : audio.mimeType,
      chunkId,
      offsetMs,
      durationMs,
    });
    if (segments.length === 0 && refusedSegments > 0) {
      report({ recoverable: true, message: NO_SPEECH });
      return;
    }
    for (const segment of segments) emit(segment);
  }

  /**
   * One kept chunk, out and back. Its file is deleted only after its words
   * have been handed to somebody listening for its meeting.
   *
   * "Somebody listening for its meeting" is the load-bearing condition, and it
   * is two checks. The controller stops listening once a meeting has ended and
   * its wait is over, and it starts listening for the *next* meeting before
   * this recorder learns its id — so a send that outlived its meeting would
   * otherwise emit into nothing, or into a meeting whose guard refuses foreign
   * words, and then delete the only copy of them. Such a chunk is left in the
   * spool instead, and `spoolDrain.ts` delivers it by the id it carries.
   */
  async function sendSpooled(chunk: SpooledChunk, inMemory: string | null): Promise<void> {
    const spool = audioSpool();
    if (spool === null) return;
    const audioBase64 = inMemory ?? (await spool.read(chunk));
    if (audioBase64.length === 0) return;

    const transcriber = resolveTranscriber();
    if (transcriber === null) return;

    const { segments, refusedSegments } = await transcriber.transcribe({
      audioBase64,
      mimeType: chunk.mimeType,
      chunkId: chunk.chunkId,
      offsetMs: chunk.offsetMs,
      durationMs: chunk.durationMs,
    });
    if (chunk.meetingId !== rec.owner || rec.segmentListeners.size === 0) return;
    if (segments.length === 0 && refusedSegments > 0) {
      spool.confirm(chunk);
      report({ recoverable: true, message: NO_SPEECH });
      return;
    }
    for (const segment of segments) emit(segment);
    spool.confirm(chunk);
  }

  return { canSendNow, keep, dispatch, drainSends };
}

export type Sender = ReturnType<typeof createSender>;
