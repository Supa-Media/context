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

/**
 * What the gateway answers a chunk with.
 *
 * `refusedSegments` is how many segments the transcription service dropped
 * because the engine's own evidence said they were not speech — VAD that kept
 * no audio, or a `no_speech_prob`/`avg_logprob` pair over Whisper's own
 * thresholds. It exists because of a measurement: ninety seconds of a quiet
 * room on this machine produced 166 words and filed them into the bucket, so
 * "the engine answered with nothing" and "the engine answered with nothing
 * *because nobody was talking*" are now different answers, and only one of them
 * is worth telling somebody about.
 */
export interface TranscribeAnswer {
  segments: TranscriptSegment[];
  /** Zero from a gateway or a service too old to say. Never a refusal by absence. */
  refusedSegments: number;
  /**
   * The engine's own numbers behind that count, or `null` when it did not say.
   *
   * See `SpeechEvidence`. `null` is a service or gateway one deploy behind, and
   * is never an object of zeros: "it did not say" and "it measured zero" are
   * different answers and only one of them is evidence of anything.
   */
  speechEvidence: SpeechEvidence | null;
}

/**
 * WHAT THE ENGINE SAID ABOUT WHETHER A CHUNK WAS SPEECH.
 *
 * Every value is a count or a reading, and `null` means the engine stated
 * nothing. The shape is the transcription service's
 * (`infra/transcribe-worker/src/transcribe.ts`, `SpeechEvidence`), carried
 * untouched by the gateway; this app reads it and never computes one.
 *
 * It exists because the refusal in that service cut invented speech about
 * threefold on the owner's Mac and did not stop it, and nobody could tell
 * whether the threshold was wrong or the signal was: the three numbers that
 * decide it were used for control flow in a Worker whose logs are in an
 * account the person diagnosing a recording does not have.
 *
 * **It is never rendered at a person and never written into a note.** A
 * `no_speech_prob` on a screen is a number with no meaning to whoever reads
 * it, and the sentence a person actually needs — `CAPTURE_NOTICES.silent` —
 * already exists and says what happened in words.
 */
export interface SpeechEvidence {
  segments: number | null;
  statedNoSpeech: number | null;
  statedLogprob: number | null;
  keptNoSpeechMax: number | null;
  keptLogprobMin: number | null;
  refusedNoSpeechMin: number | null;
  refusedLogprobMax: number | null;
  duration: number | null;
  durationAfterVad: number | null;
}

/** One chunk's evidence, with what this side knows about the same chunk. */
export interface SpeechEvidenceReport {
  /** The client's own chunk key. Names the meeting and channel; carries no text. */
  chunkId: string;
  /** How many segments came back after the service's refusal, and how many went. */
  kept: number;
  refused: number;
  evidence: SpeechEvidence | null;
}

/**
 * One chunk's evidence as a single structured line.
 *
 * ## Why a log line, and why this process's
 *
 * The three candidate homes were the segment, a per-chunk summary, and a log
 * the gateway keeps. The segment is out because a segment is written into the
 * customer's note and rendered at a person, and a number there is both
 * meaningless to its reader and a claim about their words. The gateway's log
 * is out because reaching it needs an account the person diagnosing does not
 * have, which is precisely what blocked a diagnosis on the owner's Mac. What
 * is left is the summary, delivered to the recorder that posted the audio —
 * and this is the recorder, so this is where it can be read.
 *
 * Bounded and content-free by construction: one short line per chunk, so about
 * three a minute per open channel, carrying counts, readings and a chunk id.
 * There is no field here that can hold a word anybody said.
 *
 * `absent` rather than `null` for a reading the engine did not state, because
 * the whole reason this exists is that "it did not say" was indistinguishable
 * from "it said zero" — and `absent` cannot be misread as a measurement.
 */
export function speechEvidenceLine(report: SpeechEvidenceReport): string {
  const value = (one: number | null): string => (one === null ? "absent" : String(one));
  const head = `meeting_speech_evidence chunk=${report.chunkId} kept=${report.kept} refused=${report.refused}`;
  const evidence = report.evidence;
  // A service that says nothing says so in one word. An object of zeros here
  // would read as an engine that measured silence, which is the confusion this
  // whole field exists to end.
  if (evidence === null) return `${head} evidence=absent`;
  return [
    head,
    `segments=${value(evidence.segments)}`,
    `stated_no_speech=${value(evidence.statedNoSpeech)}`,
    `stated_logprob=${value(evidence.statedLogprob)}`,
    `kept_no_speech_max=${value(evidence.keptNoSpeechMax)}`,
    `kept_logprob_min=${value(evidence.keptLogprobMin)}`,
    `refused_no_speech_min=${value(evidence.refusedNoSpeechMin)}`,
    `refused_logprob_max=${value(evidence.refusedLogprobMax)}`,
    `duration=${value(evidence.duration)}`,
    `duration_after_vad=${value(evidence.durationAfterVad)}`,
  ].join(" ");
}

export type SendChunk = (request: TranscribeRequest) => Promise<TranscribeAnswer>;

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
  /*
    The one a person will actually see on a quiet recording, and the reason it
    is a sentence rather than nothing at all.

    A chunk the engine says had no speech in it produces no words, and until
    this existed that was indistinguishable on the glass from a transcript that
    had stopped working. Both look like a rail that is not filling up. So the
    quiet one says so, and says it is deliberate — otherwise the honest fix for
    the hallucination defect ships as a *second* silent failure, which is the
    shape this repository keeps finding.
  */
  silent: "No speech was heard in the last stretch of audio, so nothing was transcribed from it. Recording continues.",
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
  /**
   * Where a chunk's speech evidence goes. Never `onNotice`, which is a person.
   *
   * Optional because it is a diagnostic and a transcriber with nowhere to put
   * one still transcribes. Called once per chunk the far end answered, and
   * never for one it refused: a refusal carries no evidence, and a line saying
   * so is a line about the network rather than about speech.
   */
  onEvidence?: (report: SpeechEvidenceReport) => void;
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
            .then((answer) => {
              // A chunk got through, so whatever was not known a moment ago is
              // known now. The grace below measures an *unbroken* run.
              notYetSince = null;
              const segments = answer.segments;
              /*
                The engine's evidence, reported before anything is decided about
                the words — including before the quiet-chunk notice below, so a
                meeting whose sentence never appeared still leaves the numbers
                that say why. Guarded because a diagnostic that can take a
                recording down is worse than no diagnostic.
              */
              try {
                deps.onEvidence?.({
                  chunkId: request.chunkId,
                  kept: segments.length,
                  refused: answer.refusedSegments,
                  evidence: answer.speechEvidence,
                });
              } catch {
                // A sink with a bug in it is not a reason to stop transcribing.
              }
              /*
                THE QUIET CHUNK, SAID OUT LOUD.

                Only when the whole chunk came back empty: a meeting with pauses
                in it refuses the odd segment all the time, and a sentence per
                pause would be noise that teaches somebody to ignore the one
                that matters. "Nothing at all came back, and the engine says it
                is because nobody was talking" is the case worth a line.
              */
              if (segments.length === 0 && answer.refusedSegments > 0) {
                notice({ recoverable: true, message: CAPTURE_NOTICES.silent });
              }
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
