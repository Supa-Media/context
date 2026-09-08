import { makeFunctionReference } from "convex/server";
import { TRANSCRIPT_CHANNELS } from "../protocol";
import type { TranscriptSegment } from "../protocol";
import type { TranscribesAt } from "./index";

/**
 * The other half of cloud capture: audio in, `TranscriptSegment`s out.
 *
 * `audio.ts` and `audio.web.ts` know how to get a complete, self-contained
 * audio file out of a platform. Neither knows what a transcript is, and neither
 * may: the product's two tiers are two very different data paths — cloud on the
 * paid tier, on-device on the free one — and a recorder that reached for one of
 * them directly would be the free tier arriving as a degraded special case of
 * the paid one. So the recorders take *this*, and there is exactly one place
 * per tier that knows where the audio goes.
 *
 * ## Nothing here hands audio back
 *
 * `transcribe` takes a chunk and answers with words. There is no method that
 * returns audio, stores it, or names where it was, which is the same rule
 * `MeetingRecorder` is built on: "audio is transient" is a property of the
 * shapes rather than a promise in a document. The caller deletes the file it
 * read the base64 out of before this is even awaited.
 *
 * ## `speaker` is `null`, always, and it is normalised here
 *
 * The engine on the other end of `transcribeChunk` is Whisper, which does no
 * diarization at all and gives no per-segment confidence. Both fields are
 * nullable in the protocol for exactly this reason. A label appearing on a
 * segment from this path would be something the pipeline *invented* rather than
 * heard, so this boundary refuses it rather than passing it up — the contract
 * says the action already sends `null`, and this is the check that keeps the
 * app honest if it ever stops.
 */

/**
 * One chunk of audio, on its way out. Session-relative, so nothing guesses.
 *
 * A `type` rather than an `interface` because Convex's `makeFunctionReference`
 * constrains its argument type to `DefaultFunctionArgs` (`Record<string, any>`),
 * and only a type alias picks up the implicit index signature that satisfies
 * it. An interface here fails to compile at `TRANSCRIBE_CHUNK`, obscurely.
 */
export type TranscribeChunkArgs = {
  /** The whole chunk, base64-encoded. Transient: never written down by us. */
  audioBase64: string;
  /** What the platform actually produced — `audio/m4a`, `audio/webm`, … */
  mimeType: string;
  /** Stable across re-sends. See `chunkIdFor` in the recorders. */
  chunkId: string;
  /** Milliseconds from the start of the session to the start of this chunk. */
  offsetMs: number;
  durationMs: number;
};

/**
 * The seam a recorder holds.
 *
 * `transcribesAt` is on the transcriber rather than on the recorder because it
 * is a fact about where the words are produced, and the recorder is the same
 * either way — which is what makes an on-device implementation a second object
 * here rather than a second recorder.
 */
/**
 * What comes back for one chunk: the words, and how many were refused.
 *
 * `refusedSegments` is how many segments the transcription worker dropped
 * because the engine's own evidence said they were not speech. It exists
 * because of a measurement: ninety seconds of a quiet room on a Mac produced
 * 166 words and filed them into the bucket. The worker refuses them now, which
 * means an empty answer has two causes needing two different sentences on a
 * phone — a quiet room, and a transcriber that is not working — and this is the
 * only field that tells them apart.
 *
 * Nothing here decides anything. The engine's fields live in the worker and the
 * judgement is made there, once, for every recorder.
 */
export interface ChunkTranscription {
  segments: TranscriptSegment[];
  /** Zero from a control plane or worker too old to say. Never a claim of silence. */
  refusedSegments: number;
}

export interface ChunkTranscriber {
  readonly transcribesAt: TranscribesAt;
  transcribe(input: TranscribeChunkArgs): Promise<ChunkTranscription>;
}

/**
 * The action, named rather than reached for through the generated `api`.
 *
 * `functions/meetings/transcribe:transcribeChunk` is built to this exact
 * contract in the control plane. `makeFunctionReference` is Convex's own way to
 * name a function by path with its argument and return types attached, and it
 * is the right tool here for a reason beyond convenience: this app is bundled
 * from a checkout that may be a deploy behind the backend, and
 * `api.functions.meetings.transcribe` is a *generated* type that only exists
 * once `npx convex dev` has regenerated `_generated/api.d.ts`. Reaching through
 * the generated tree would make this file fail to compile in any checkout whose
 * generated types are older than the action — and the fix for that is never to
 * hand-edit `_generated/`.
 *
 * The types below are therefore the contract, asserted at the one call site.
 * If the action's shape changes, this line is the single place that has to.
 */
export const TRANSCRIBE_CHUNK = makeFunctionReference<
  "action",
  TranscribeChunkArgs,
  { segments: TranscriptSegment[]; refusedSegments?: number }
>("functions/meetings/transcribe:transcribeChunk");

/**
 * Just enough of a Convex client to run one action.
 *
 * Deliberately structural and tiny. The app has exactly one `ConvexReactClient`
 * — `SupaConvexProvider` builds it and keeps it as a module singleton — and a
 * second one here would be a second websocket, a second auth state, and a
 * second set of credentials on the device. So the app *hands* this the client
 * it already has (`useMeetings.ts`), and this file never constructs one.
 */
export interface ActionRunner {
  action(
    reference: typeof TRANSCRIBE_CHUNK,
    args: TranscribeChunkArgs,
  ): Promise<{ segments: TranscriptSegment[]; refusedSegments?: number }>;
}

/**
 * The real one: ship the chunk to the control plane, emit what comes back.
 *
 * The action returns segments **already offset to session time**, so nothing
 * here adds `offsetMs` a second time — that arithmetic happens once, on the
 * side that also knows what Whisper said about the inside of the chunk.
 */
export function cloudTranscriber(client: ActionRunner): ChunkTranscriber {
  return {
    transcribesAt: "cloud",
    async transcribe(input) {
      const answer = await client.action(TRANSCRIBE_CHUNK, input);
      return {
        segments: (answer?.segments ?? []).map(intoSegment),
        refusedSegments: readRefused(answer?.refusedSegments),
      };
    },
  };
}

/**
 * A refusal count, or none.
 *
 * Optional in the action's type because this app is bundled from a checkout
 * that may be a deploy behind the backend — the same reason `TRANSCRIBE_CHUNK`
 * is named by path rather than reached through the generated `api`. Absent is
 * zero, and everything unreadable is zero too: a control plane too old to say,
 * a value that is not a number, a negative. None of those is evidence that a
 * room was quiet, and reading them as such would tell somebody no speech was
 * heard during a meeting they are talking in.
 */
function readRefused(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

/**
 * A transcriber a test drives by hand, and the reason no test needs a network.
 *
 * Same shape as `capture/fake.ts`'s recorder and for the same reason: the cases
 * that matter here are ordering cases — a chunk answered after the meeting
 * ended, a chunk that fails while the next one is already in flight — and every
 * one of them is about *when* an answer arrives.
 */
export interface FakeTranscriber extends ChunkTranscriber {
  /** Every chunk handed over, in order. */
  readonly chunks: TranscribeChunkArgs[];
  /** What the next `transcribe` answers with. Defaults to nothing. */
  answerWith(segments: TranscriptSegment[]): void;
  /**
   * ...and how many segments the engine refused as not-speech, if any.
   *
   * Separate from `answerWith` so the ordinary case stays one argument: a test
   * about *when* an answer arrives should not have to say anything about
   * silence, and a fake that quietly reported refusals would make the phone's
   * "no speech was heard" chip fire all over a suite that is about something
   * else.
   */
  refusedNextTime(count: number): void;
  /** Make the next `transcribe` reject. */
  refuse(message: string): void;
}

export function fakeTranscriber(
  transcribesAt: TranscribesAt = "cloud",
): FakeTranscriber {
  const chunks: TranscribeChunkArgs[] = [];
  let answer: TranscriptSegment[] = [];
  let refusal: string | null = null;
  let refusedSegments = 0;

  return {
    transcribesAt,
    chunks,
    answerWith(segments) {
      answer = segments;
    },
    refusedNextTime(count) {
      refusedSegments = count;
    },
    refuse(message) {
      refusal = message;
    },
    async transcribe(input) {
      chunks.push(input);
      if (refusal !== null) {
        const message = refusal;
        refusal = null;
        throw new Error(message);
      }
      const refused = refusedSegments;
      refusedSegments = 0;
      return { segments: answer.map(intoSegment), refusedSegments: refused };
    },
  };
}

/* ---------------------------- the module seam ---------------------------- */

/*
  `createRecorder(platform)` takes one argument and will keep taking one: it is
  "one function so there is one answer", and threading a transcriber through it
  would make every caller above `capture/` know that cloud transcription exists.
  So the recorders resolve their transcriber from here, and a test substitutes
  it here too — which is what keeps the whole suite off the network without a
  single `jest.mock` of `convex/react`.
*/

let installedClient: ActionRunner | null = null;
let installedTranscriber: ChunkTranscriber | null = null;

/**
 * Hand the app's Convex client to the recorders.
 *
 * Called once from `useMeetingsSetup`, which is inside the provider and so is
 * the one place that can see the client. Passing `null` forgets it — a sign-out
 * or a context switch, where a recorder left holding a stale client would be
 * shipping one person's audio under another person's session.
 */
export function setTranscriptionClient(client: ActionRunner | null): void {
  installedClient = client;
}

/**
 * Substitute the whole transcriber. Tests only; `null` restores the default.
 *
 * "Tests only" was a comment and nothing else while `capture/index.ts`
 * re-exported this beside the types — one import above `capture/` and any
 * module could install something that retained every chunk's base64, which
 * `fakeTranscriber` above does by design. It is no longer on the barrel, and
 * `meetingsCaptureWiring.test.ts` fails if it goes back, or if anything outside
 * `capture/` reaches past that door to find it.
 */
export function setTranscriber(transcriber: ChunkTranscriber | null): void {
  installedTranscriber = transcriber;
}

/**
 * The transcriber a recorder should use for the chunk it is about to send.
 *
 * Resolved per chunk rather than captured when the recorder is built, because
 * the recorder is built in the same effect that installs the client and a
 * recorder that had cached `null` would stay deaf for the life of the session.
 */
export function resolveTranscriber(): ChunkTranscriber | null {
  if (installedTranscriber !== null) return installedTranscriber;
  if (installedClient !== null) return cloudTranscriber(installedClient);
  return null;
}

/* -------------------------------------------------------------------------- */

/**
 * A segment, forced into the protocol's shape.
 *
 * `speaker` is `null` unconditionally — see the header. `confidence` survives
 * only if it is a real number; anything else is an engine that gives none, and
 * `null` is what the protocol says to write then rather than a `0` that reads
 * as "certainly wrong" or a `1` that reads as "certainly right".
 */
function intoSegment(segment: TranscriptSegment): TranscriptSegment {
  const channel = TRANSCRIPT_CHANNELS.includes(segment.channel) ? segment.channel : "mic";
  return {
    id: segment.id,
    startMs: segment.startMs,
    endMs: segment.endMs,
    text: segment.text,
    speaker: null,
    channel,
    confidence: typeof segment.confidence === "number" ? segment.confidence : null,
  };
}
