/**
 * Cloud transcription: a chunk of audio out, words back, nothing kept.
 *
 * This is the desktop's implementation of the paid tier's engine, and it is a
 * client of one route — `ROUTES.transcribe(sessionId)` — reached with **this
 * machine's own grant**. That last part is the whole reason it is allowed to
 * exist: the audio is attributable to a workspace, charged against a meeting
 * that workspace already opened, and held for the life of one request.
 *
 * ## What this file guarantees
 *
 * **Audio is never queued.** The outbox exists so that a meeting recorded on a
 * plane still becomes a note, and it holds *text*. Audio is deliberately not in
 * it: queueing a recording means keeping somebody's recording, and
 * `docs/decisions/meetings.md` is explicit — *audio is never persisted by us.
 * Not as an attachment, not as a cache, not "temporarily" in a queue that has
 * no expiry.* A chunk that cannot be sent now is dropped, with a notice. What
 * is lost is words; what is never lost is the note.
 *
 * **The send is off the recorder's critical path.** `push` returns
 * immediately. The phone learned this one expensively: with the round trip
 * inside the rotation, seconds of every twenty were never recorded while the
 * offsets went on claiming the chunks were contiguous. `MAX_INFLIGHT_CHUNKS`
 * bounds how many may be outstanding, and at the bound a chunk is dropped
 * rather than queued — see `@context/meetings/chunks` for that argument, which
 * is shared with both mobile recorders.
 *
 * **A refusal that will not change is not retried.** A gateway that has no
 * transcription configured, or a grant that may not write here, answers the
 * same way to the next chunk and the one after. So the stream gives up for the
 * rest of the meeting, says so once through `onNotice`, and the recorder stops
 * opening the microphone for nothing.
 *
 * **Segment ids are derived, never minted.** `chunkIdFor` and `segmentIdFor`
 * are the phone's own functions. The same audio transcribed twice produces the
 * same ids, and the protocol's "same segment id replaces" rule collapses them
 * — which is what makes a re-send free rather than a doubled transcript.
 */

import { MAX_INFLIGHT_CHUNKS, chunkIdFor, segmentIdFor } from "@context/meetings/chunks";
import type { TranscriptSegment } from "../contract.ts";
import type { AudioFrame } from "./recorder.ts";
import type {
  Transcriber,
  TranscriberOptions,
  TranscriptionNotice,
  TranscriptionStream,
} from "./transcriber.ts";

/** One chunk, on its way out. The shape `ROUTES.transcribe` takes. */
export interface TranscribeRequest {
  sessionId: string;
  audioBase64: string;
  mimeType: string;
  chunkId: string;
  offsetMs: number;
  durationMs: number;
}

/**
 * Anything the far end refused, as data rather than a throw.
 *
 * `permanent` is the only field with a decision in it: it means "asking again
 * with the next chunk will get the same answer", which is what turns a refusal
 * into "this meeting is notes-only from here" instead of a message every twenty
 * seconds for an hour.
 */
export class TranscribeRefused extends Error {
  readonly permanent: boolean;

  constructor(message: string, permanent: boolean) {
    super(message);
    this.name = "TranscribeRefused";
    this.permanent = permanent;
  }
}

export type SendChunk = (request: TranscribeRequest) => Promise<TranscriptSegment[]>;

/**
 * Everything this transcriber may say, and the whole of it.
 *
 * A closed set for the same reason the phone has one: these strings reach the
 * glass, and an upstream `Error.message` passed through would eventually put a
 * URL, a request id, or a fragment of a payload on somebody's screen.
 */
export const CAPTURE_NOTICES = Object.freeze({
  dropped: "Transcription is running behind, so a few seconds of audio were not transcribed. Recording continues.",
  failed: "A few seconds of audio could not be transcribed. Recording continues.",
  refused:
    "This meeting is not being transcribed — the gateway would not accept the audio. Your notes and the meeting still land in your bucket.",
});

export interface GatewayTranscriberDeps {
  send: SendChunk;
  /** Bounded for the suite; the default is the shared one every recorder uses. */
  maxInFlight?: number;
}

/**
 * The engine, as one object the controller holds for the life of the app.
 *
 * Stateless between meetings on purpose: everything about *this* meeting —
 * the id, the chunk counter, what is in flight — belongs to the stream that
 * `start` returns, so two meetings in one launch cannot share a counter.
 */
export function gatewayTranscriber(deps: GatewayTranscriberDeps): Transcriber {
  const limit = deps.maxInFlight ?? MAX_INFLIGHT_CHUNKS;

  return {
    id: "cloud",
    // Said out loud in the notepad's rail, read off the engine rather than
    // typed into the markup. Audio does leave this machine on this path.
    audioLeavesDevice: true,
    label: "cloud (audio not stored)",

    async start(options: TranscriberOptions): Promise<TranscriptionStream> {
      const inFlight = new Set<Promise<void>>();
      /** Per channel, so mic chunk 3 and system chunk 3 are different files. */
      const counters = new Map<string, number>();
      let givenUp = false;

      function notice(value: TranscriptionNotice): void {
        try {
          options.onNotice?.(value);
        } catch {
          // A screen with a bug in its notice handler is not a reason to stop
          // somebody's meeting.
        }
      }

      function nextChunkId(frame: AudioFrame, sessionId: string): string {
        const index = counters.get(frame.channel) ?? 0;
        counters.set(frame.channel, index + 1);
        return chunkIdFor(`${sessionId}-${frame.channel}`, index);
      }

      return {
        push(frame: AudioFrame): void {
          if (givenUp) return;
          if (frame.data.length === 0 || frame.durationMs <= 0) return;
          if (inFlight.size >= limit) {
            // Dropped rather than queued. See the header, and
            // `MAX_INFLIGHT_CHUNKS` for the argument.
            notice({ recoverable: true, message: CAPTURE_NOTICES.dropped });
            return;
          }

          const request: TranscribeRequest = {
            sessionId: options.sessionId,
            audioBase64: base64(frame.data),
            mimeType: frame.mimeType,
            chunkId: nextChunkId(frame, options.sessionId),
            offsetMs: frame.atMs,
            durationMs: frame.durationMs,
          };

          const run = deps
            .send(request)
            .then((segments) => {
              segments.forEach((segment, index) => {
                options.onSegment({
                  ...segment,
                  /*
                    The id is derived here rather than taken from the answer.

                    Two reasons, and the second is the one that would hurt. The
                    protocol merges by segment id, so the id decides whether a
                    re-transcription of the same audio replaces rows or doubles
                    them — a decision that belongs to the side that knows the
                    audio is the same, which is this one. And an id from the
                    wire is a string this app did not compose, going into a key
                    the gateway stores; deriving it means the only ids this
                    client can ever send are ones `segmentIdFor` produced.
                  */
                  id: segmentIdFor(request.chunkId, index),
                  /*
                    The channel is this machine's knowledge, not the engine's:
                    the far end hears one file and cannot know whether it was
                    the room or the call. Stamped here so `## Transcript` can
                    say who was speaking at all.
                  */
                  channel: frame.channel,
                });
              });
            })
            .catch((error: unknown) => {
              if (error instanceof TranscribeRefused && error.permanent) {
                // Made true rather than repeated: giving up is what stops this
                // being the same sentence every twenty seconds.
                givenUp = true;
                notice({ recoverable: false, message: CAPTURE_NOTICES.refused });
                return;
              }
              notice({ recoverable: true, message: CAPTURE_NOTICES.failed });
            })
            .finally(() => {
              inFlight.delete(run);
            });
          inFlight.add(run);
        },

        /**
         * Wait for what is already out.
         *
         * Called by the controller after the recorder has stopped, so waiting
         * here costs a moment of "finalizing" rather than an open microphone —
         * and it buys the last chunk of the meeting landing in the note instead
         * of arriving after the finalize that would have carried it.
         */
        async finish(): Promise<void> {
          await Promise.allSettled([...inFlight]);
        },
      };
    },
  };
}

/**
 * Bytes to base64, without `Buffer` and without `btoa`.
 *
 * This module is imported by the Electron main process (Node, which has
 * `Buffer`) and by the suite (Node again) — but it is `core/`, and the rule for
 * `core/` is that it holds no runtime's API. Sixteen lines of table lookup is a
 * smaller price than a module that cannot move, and `transcriber.test.mjs`
 * checks it against `Buffer.toString("base64")` over random bytes so it is not
 * a hand-rolled encoder nobody verified.
 */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function base64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] as number;
    const b = i + 1 < bytes.length ? (bytes[i + 1] as number) : undefined;
    const c = i + 2 < bytes.length ? (bytes[i + 2] as number) : undefined;
    out += ALPHABET[a >> 2];
    out += ALPHABET[((a & 0b11) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? "=" : ALPHABET[((b & 0b1111) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? "=" : ALPHABET[c & 0b111111];
  }
  return out;
}
