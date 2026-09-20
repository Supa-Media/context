/**
 * The shapes and the change channel every spool shares.
 *
 * Its own file so that `spoolDevice.ts` — the `expo-file-system` half — and
 * `spool.ts` — the seam that chooses between it and a test's — can both import
 * them without importing each other. `spool.ts` carries the argument for why a
 * spool exists at all.
 */

/** A chunk on the device, waiting for its words. */
export interface SpooledChunk {
  meetingId: string;
  /** Zero-based chunk number within the meeting. */
  index: number;
  /** `chunkIdFor(meetingId, index)` — what the transcriber is sent. */
  chunkId: string;
  offsetMs: number;
  durationMs: number;
  mimeType: string;
  /** Where the spool can find it again. Opaque to everybody else. */
  key: string;
}

/** What is being kept: bytes already in memory, or a finished file to move in. */
export type SpoolSource =
  | { kind: "bytes"; bytes: Uint8Array; mimeType: string }
  | { kind: "file"; uri: string; mimeType: string };

export interface ChunkPlacement {
  meetingId: string;
  index: number;
  offsetMs: number;
  durationMs: number;
}

export interface AudioSpool {
  /**
   * Keep a chunk. `null` when it could not be kept — the disk refused, the
   * meeting id is not one, or the session this recording belongs to ended
   * before or during the write. A `null` means nothing is on the device.
   */
  keep(placement: ChunkPlacement, source: SpoolSource, epoch: number): SpooledChunk | null;
  /** Every chunk held, by meeting and then by index. */
  list(): SpooledChunk[];
  /** The chunk's audio, base64 — for the one request that carries it. */
  read(chunk: SpooledChunk): Promise<string>;
  /** The transcriber answered and the words reached the meeting: let it go. */
  confirm(chunk: SpooledChunk): void;
  /** The person discarded the meeting. */
  forgetMeeting(meetingId: string): void;
  /** Sign-out. Answers how many chunks were still there afterwards. */
  forgetAll(): { left: number };
}

/* ----------------------------- change events ----------------------------- */

const listeners = new Set<() => void>();
let announced = false;

/**
 * Something was kept, confirmed, forgotten, or handed back unsent.
 *
 * Announced on the next microtask and coalesced, not called inline, and the
 * delay is load-bearing: `keep` announces from inside the recorder's tick, one
 * line before the recorder claims the chunk it just kept and sends it. A
 * listener that drained synchronously would claim that chunk first and take
 * the live send away from the recorder — every chunk of every meeting would go
 * out one at a time through the drain, behind the words on the screen.
 */
export function spoolChanged(): void {
  if (announced) return;
  announced = true;
  queueMicrotask(() => {
    announced = false;
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // One screen's bug is not a reason to stop telling the others.
      }
    }
  });
}

export function onSpoolChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The order a meeting's audio is sent in, and the order the transcript reads. */
export function byMeetingThenIndex(a: SpooledChunk, b: SpooledChunk): number {
  if (a.meetingId !== b.meetingId) return a.meetingId < b.meetingId ? -1 : 1;
  return a.index - b.index;
}
