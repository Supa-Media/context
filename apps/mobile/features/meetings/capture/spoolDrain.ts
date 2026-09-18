import { ConvexError } from "convex/values";
import type { TranscriptSegment } from "../protocol";
import { captureOffline } from "./connectivity";
import { audioSpool, claimChunk, isClaimed, releaseChunk, type SpooledChunk } from "./spool";
import { resolveTranscriber } from "./transcriber";

/**
 * SENDING WHAT THE SPOOL IS HOLDING, LATER, THROUGH THE SAME DOOR.
 *
 * The recorder sends live. Anything it could not — offline, backed up, a send
 * that failed, a send that answered after nobody was listening — is on the
 * device in the spool, and this is what empties it: on launch, on coming back
 * online, on returning to the foreground, and after a meeting ends.
 *
 * ## The same path, and why that is the whole of idempotency
 *
 * Every chunk goes to `transcribeChunk` with the `chunkId` the recorder minted
 * — `chunkIdFor(meetingId, index)`, rebuilt from the file name — and the same
 * offset and duration. The action is stateless by design (it may not keep a
 * transcript: `docs/decisions/meetings.md`, and the control plane never holds
 * note content), and it derives every segment id from the chunk id and the
 * segment's position, so the same chunk answers with the same ids
 * (`two identical calls produce identical segments`,
 * `apps/convex/__tests__/meetingTranscribe.test.ts`). The meeting upserts by
 * id. A chunk re-sent after an answer nobody heard therefore replaces its own
 * rows rather than adding a second copy — which is why there is no server-side
 * change here: the only way to make the server "remember" a chunk would be to
 * store its transcript in the control plane, and that is the one thing it is
 * forbidden to do.
 *
 * ## Sequential, stopping at the first failure that may pass
 *
 * One request at a time, oldest meeting first, in index order: the budget is
 * twenty chunks a minute (`TRANSCRIBE_CHUNKS_PER_WINDOW`), and an hour offline
 * is a hundred and eighty chunks. A burst would be refused after the twentieth
 * and teach the drain nothing. So a refusal for rate stops the pass and says
 * when to come back; a network failure stops it because the next chunk would
 * fail the same way; and a chunk the server refuses *on its own merits* is
 * counted and, after `MAX_REFUSALS`, set aside for this process so one bad file
 * cannot hold a meeting's note forever. Set aside is not deleted: it stays on
 * the device, is counted on the screen, and goes only with the meeting or a
 * sign-out.
 *
 * ## The words go to the meeting, never to a listener
 *
 * `deliver` is the controller's, keyed by the meeting id the chunk names, and
 * it resolves once the words are written down on the device. Only then is the
 * chunk confirmed and deleted. The other order would lose a chunk's words to a
 * crash between the two; this order costs, at worst, one re-send whose ids land
 * on the rows already there.
 */

/** Refusals of one chunk, on its own merits, before it stops holding its meeting. */
export const MAX_REFUSALS = 3;

/** Codes that are about the caller or the deployment, never about the chunk. */
const NOT_THE_CHUNK = new Set(["NOT_AUTHENTICATED", "TRANSCRIPTION_NOT_CONFIGURED", "RATE_LIMITED"]);

/** Refused for its own sake: it can never succeed, so it is set aside at once. */
const HOPELESS = new Set(["INVALID_CHUNK_ID"]);

const refusals = new Map<string, number>();

/** A chunk this process has stopped trying. Kept on the device regardless. */
export function isSetAside(chunk: SpooledChunk): boolean {
  return (refusals.get(chunk.key) ?? 0) >= MAX_REFUSALS;
}

/** Tests only. */
export function resetSpoolDrain(): void {
  refusals.clear();
}

export interface SpoolDrainDeps {
  /** Whether this chunk's meeting is one this drain may deliver to right now. */
  owns(meetingId: string): boolean;
  /** Fold the words into the meeting and write it down. Resolves when durable. */
  deliver(meetingId: string, segments: TranscriptSegment[]): Promise<void>;
  /** Whether the session this drain started under still owns the device. */
  mine(): boolean;
}

export interface SpoolDrainReport {
  /** Chunks whose words reached their meeting and were let go. */
  sent: number;
  /** Stopped before the end because the next one may work later. */
  stoppedEarly: boolean;
  /** When the transcriber said to come back, if it did. */
  retryAfterMs: number | null;
}

/** How many chunks each meeting still has on the device, and how many hold it. */
export interface SpooledAudioCounts {
  /** Every chunk kept for the meeting, including ones set aside. */
  kept: number;
  /** The ones still being tried — what holds the meeting's note back. */
  waiting: number;
}

export function spooledAudioCounts(): Record<string, SpooledAudioCounts> {
  const counts: Record<string, SpooledAudioCounts> = {};
  const spool = audioSpool();
  if (spool === null) return counts;
  for (const chunk of spool.list()) {
    const entry = (counts[chunk.meetingId] ??= { kept: 0, waiting: 0 });
    entry.kept += 1;
    if (!isSetAside(chunk)) entry.waiting += 1;
  }
  return counts;
}

export async function drainSpooledAudio(deps: SpoolDrainDeps): Promise<SpoolDrainReport> {
  const report: SpoolDrainReport = { sent: 0, stoppedEarly: false, retryAfterMs: null };
  const spool = audioSpool();
  if (spool === null) return report;
  const transcriber = resolveTranscriber();
  if (transcriber === null) {
    report.stoppedEarly = spool.list().length > 0;
    return report;
  }

  for (const chunk of spool.list()) {
    if (!deps.mine()) {
      report.stoppedEarly = true;
      break;
    }
    if (captureOffline()) {
      report.stoppedEarly = true;
      break;
    }
    if (isSetAside(chunk) || isClaimed(chunk) || !deps.owns(chunk.meetingId)) continue;
    if (!claimChunk(chunk)) continue;
    try {
      const audioBase64 = await spool.read(chunk);
      const { segments } = await transcriber.transcribe({
        audioBase64,
        mimeType: chunk.mimeType,
        chunkId: chunk.chunkId,
        offsetMs: chunk.offsetMs,
        durationMs: chunk.durationMs,
      });
      /*
        Checked again after the round trip, which may have spanned a sign-out:
        words for a session that has ended are not delivered anywhere, and the
        chunk is not confirmed — the sign-out has already taken it.
      */
      if (!deps.mine()) {
        report.stoppedEarly = true;
        break;
      }
      await deps.deliver(chunk.meetingId, segments);
      spool.confirm(chunk);
      refusals.delete(chunk.key);
      report.sent += 1;
    } catch (error) {
      const code = codeOf(error);
      if (code === "RATE_LIMITED") report.retryAfterMs = retryAfterOf(error);
      if (code !== null && !NOT_THE_CHUNK.has(code)) {
        refusals.set(
          chunk.key,
          HOPELESS.has(code) ? MAX_REFUSALS : (refusals.get(chunk.key) ?? 0) + 1,
        );
        // Set aside: the next chunk is not this one's problem.
        if (isSetAside(chunk)) continue;
      }
      report.stoppedEarly = true;
      break;
    } finally {
      releaseChunk(chunk);
    }
  }
  return report;
}

function codeOf(error: unknown): string | null {
  if (!(error instanceof ConvexError)) return null;
  const data = error.data as unknown;
  if (typeof data !== "object" || data === null) return null;
  const code = (data as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function retryAfterOf(error: unknown): number | null {
  const data = (error as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return null;
  const value = (data as { retryAfterMs?: unknown }).retryAfterMs;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Sign-out: every chunk on the device, for every meeting, gone — and counted
 * afterwards rather than trusted. `features/offline/forget.ts` calls this after
 * it has ended the session, so a recorder or a drain still running finds its
 * epoch stale and writes nothing back.
 */
export function forgetSpooledAudio(): { left: number } {
  refusals.clear();
  const spool = audioSpool();
  if (spool === null) return { left: 0 };
  try {
    return spool.forgetAll();
  } catch {
    // The count could not be taken. Say something is left: it is the floor.
    return { left: 1 };
  }
}

/** The person discarded a meeting: its audio goes with it. */
export function forgetMeetingAudio(meetingId: string): void {
  try {
    audioSpool()?.forgetMeeting(meetingId);
  } catch {
    // Left on the device, and still counted; sign-out takes it.
  }
}
