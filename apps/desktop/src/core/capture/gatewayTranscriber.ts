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
import { DRAIN_INTERVAL_MS } from "../sync/drain.ts";
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
  /**
   * The far end says it does not know this — which is as often "not yet" as it
   * is "never", and one reply cannot tell you which.
   *
   * A separate bit from `permanent` because the two answer different questions.
   * `main/transcribe.ts`'s `notYet` is where it is set and where the whole
   * argument is written down; what it buys is below, in the `catch`.
   */
  readonly notYet: boolean;

  constructor(message: string, permanent: boolean, notYet = false) {
    super(message);
    this.name = "TranscribeRefused";
    this.permanent = permanent;
    this.notYet = notYet;
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

/**
 * HOW LONG A MEETING KEEPS TRYING AFTER THE FAR END SAYS "I DO NOT KNOW THAT".
 *
 * A wall clock, and **two full drain periods** of it, because the thing being
 * waited for is a drain: the session row goes out through the outbox and the
 * audio comes straight from here, so between the first chunk leaving and the
 * row landing there is a window in which the gateway honestly does not know
 * this meeting and answers 404. Believing that answer once threw away every
 * remaining chunk, which is what made every desktop recording produce an empty
 * transcript.
 *
 * ## Why a clock rather than a count of refusals
 *
 * A count is a proxy for time that stops being one the moment anything changes:
 * lengthen `SEGMENT_MS` and the same count is four minutes; drop chunks at
 * `MAX_INFLIGHT_CHUNKS` and it is spent without any time passing at all. Two
 * drain periods is the *actual* quantity that matters — "long enough that the
 * outbox has certainly had its turn, twice" — and it stays true when either
 * number moves. It is derived from `DRAIN_INTERVAL_MS` rather than typed out
 * for exactly that reason.
 *
 * ## Why not "once the session write is known flushed"
 *
 * That was the other candidate and it is worse in the case that matters. It
 * needs the queue's state inside the recorder — a coupling from `core/capture`
 * to `core/sync/outbox` that does not exist today — and, having paid for it, it
 * is **unbounded exactly where a bound is needed**: a session write that is
 * *parked* (a grant that cannot file meetings privately, which `postEntry`
 * refuses before the network) never becomes flushed, so a meeting that will
 * never be known would go on uploading a full chunk of audio every twenty
 * seconds for its whole length. The case it would protect — a machine offline
 * long enough for the row not to land — is already covered, because an offline
 * machine's chunks fail as *network* errors rather than 404s, and those have
 * never counted against anything.
 *
 * ## What the bound costs, stated
 *
 * A meeting that really is another workspace's, or a gateway that really has no
 * such route and answers 404 instead of 501, uploads about a minute of audio —
 * three chunks, roughly a megabyte — before this stops. That is the price of
 * never discarding a meeting on one unlucky 404, and it is the right way round.
 *
 * The deadline is armed by the *first* such refusal and **reset by any
 * success**, so an intermittent 404 in the middle of a healthy meeting never
 * accumulates toward it.
 */
export const NOT_YET_GRACE_MS = 2 * DRAIN_INTERVAL_MS;

export interface GatewayTranscriberDeps {
  send: SendChunk;
  /** Bounded for the suite; the default is the shared one every recorder uses. */
  maxInFlight?: number;
  /** Bounded for the suite; the default is `NOT_YET_GRACE_MS`. */
  notYetGraceMs?: number;
  /** The clock the grace above is measured on. Injected so a test owns it. */
  now?: () => number;
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
  const graceMs = deps.notYetGraceMs ?? NOT_YET_GRACE_MS;
  const now = deps.now ?? (() => Date.now());

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
      /**
       * When the far end first said it did not know this meeting, or `null`.
       *
       * Cleared by any success, so a 404 in the middle of a healthy meeting
       * starts the clock again rather than continuing somebody else's.
       */
      let notYetSince: number | null = null;

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
              // A chunk got through, so whatever was not known a moment ago is
              // known now. The grace below measures an *unbroken* run.
              notYetSince = null;
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
              /*
                "I do not know that" is checked before `permanent`, and it is
                the only refusal with a deadline rather than a verdict.

                The gateway cannot tell "not written yet" from "never existed"
                and must not — `sessionGone()`'s single code is the isolation
                guarantee — so this side waits `graceMs` for the session row to
                land before believing the second reading. Every chunk of every
                meeting used to be thrown away on the first of these, which is a
                race read as a permission. **One 404 must never end a meeting**,
                and with the clock armed here rather than counted, it cannot.
              */
              if (error instanceof TranscribeRefused && error.notYet) {
                const at = now();
                if (notYetSince === null) notYetSince = at;
                if (at - notYetSince < graceMs) {
                  notice({ recoverable: true, message: CAPTURE_NOTICES.failed });
                  return;
                }
                givenUp = true;
                notice({ recoverable: false, message: CAPTURE_NOTICES.refused });
                return;
              }
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
