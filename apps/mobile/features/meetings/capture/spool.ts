import { deviceSpool } from "./spoolDevice";
import {
  byMeetingThenIndex,
  spoolChanged,
  type AudioSpool,
  type ChunkPlacement,
  type SpoolSource,
  type SpooledChunk,
} from "./spoolShared";
import { encodeBase64 } from "./wav";

export {
  byMeetingThenIndex,
  onSpoolChange,
  spoolChanged,
  type AudioSpool,
  type ChunkPlacement,
  type SpoolSource,
  type SpooledChunk,
} from "./spoolShared";

/**
 * AUDIO THAT HAS NOT REACHED THE TRANSCRIBER YET, KEPT ON THIS DEVICE UNTIL IT HAS.
 *
 * Until this existed, a chunk of a meeting lived in a closure for the length of
 * one request and its file was deleted before the request was even made. That
 * made "audio is transient" a property of the code, and it made every chunk
 * sent without signal — a basement conference room, a train, a phone that
 * dropped to one bar mid-meeting — a gap in the transcript that nothing could
 * ever fill. At `MAX_INFLIGHT_CHUNKS` the recorder dropped outright, with a
 * sentence. The owner's call (2026-09-18): **offline audio is spooled, never
 * dropped.** `docs/decisions/meetings.md`, "Audio nobody has transcribed yet is
 * kept on the device", has the argument and what reversing it would cost.
 *
 * ## What the spool is
 *
 * One file per chunk, in a directory per meeting, under the app's *document*
 * directory — never the cache, which the OS may empty under storage pressure,
 * and which `audio.ts` sweeps at startup. The file's name is its whole index:
 * `<index>_<offsetMs>_<durationMs>.<wav|m4a>`, so there is no manifest to fall
 * out of step with the files and nothing to repair after a crash. The chunk id
 * is `chunkIdFor(meetingId, index)`, exactly as the live send mints it, so a
 * re-send lands on the same segment ids and the transcript merges rather than
 * doubling.
 *
 * ## The rules it keeps
 *
 * - **Somebody's content, not a cache.** Nothing sweeps it, nothing bounds it,
 *   nothing ages it out. A chunk leaves in exactly three ways: the transcriber
 *   answered for it and its words were handed to the meeting (`confirm`); the
 *   person discarded the meeting (`forgetMeeting`); or they signed out
 *   (`forgetSpooledAudio`, through `features/offline/forget.ts`).
 * - **A write belongs to a session.** `keep` takes the epoch the recording
 *   started under and re-checks it after the write, the discipline
 *   `features/offline/epoch.ts` describes: a chunk landing after a sign-out is
 *   deleted rather than left for the next person on the device.
 * - **Nothing above `capture/` holds the bytes.** This interface is not on the
 *   barrel. What is — counts, a drain that hands back *segments*, and the two
 *   forgets — says how much is waiting and never what it sounds like.
 *
 * ## Why an interface and a seam
 *
 * The device implementation (`spoolDevice.ts`) is `expo-file-system` and exists
 * only in a native bundle; a browser gets `null` (`spoolDevice.web.ts`), and a
 * browser meeting is not spooled — `audio.web.ts` says so on the glass. The
 * seam below is the same arrangement as `setTranscriber`: tests install a spool
 * by this file's own path, and `meetingsCaptureWiring.test.ts` keeps it off the
 * barrel.
 */

/* --------------------------------- claims -------------------------------- */

/*
  Two things send spooled chunks: the recorder, live, and the drain, later. A
  chunk both of them picked up would be transcribed twice — harmless to the
  transcript, because the ids are the same, and not harmless to a budget of
  twenty chunks a minute. So a sender claims a chunk before reading it and
  releases it when its request settles, and the other one skips it.

  Module state rather than a field on the spool, because it is a fact about
  this process's requests and not about the files: a restart has no requests in
  flight, and everything on disk is then claimable again, which is right.
*/
const claimed = new Set<string>();

export function claimChunk(chunk: SpooledChunk): boolean {
  if (claimed.has(chunk.key)) return false;
  claimed.add(chunk.key);
  return true;
}

export function releaseChunk(chunk: SpooledChunk): void {
  claimed.delete(chunk.key);
}

export function isClaimed(chunk: SpooledChunk): boolean {
  return claimed.has(chunk.key);
}

/* ---------------------------------- seam --------------------------------- */

let installed: AudioSpool | null | undefined;

/** Substitute the spool. Tests only; `undefined` restores the device's. */
export function setAudioSpool(spool: AudioSpool | null | undefined): void {
  installed = spool;
  claimed.clear();
}

/** The spool this build has, or `null` on a surface that cannot keep audio. */
export function audioSpool(): AudioSpool | null {
  return installed !== undefined ? installed : deviceSpool;
}

/* ------------------------------ in memory, for tests ---------------------- */

/**
 * A spool in a `Map`, which is all the recorder and the drain need to be
 * driven by hand. Bytes only: a file source is read through `readFile`, which a
 * test supplies, because a spool that reached for `expo-file-system` here would
 * put it in the web bundle.
 */
export function memorySpool(
  options: { readFile?: (uri: string) => Promise<string>; currentEpoch?: () => number } = {},
): AudioSpool & { readonly held: Map<string, SpooledChunk>; refuseNext: boolean } {
  const held = new Map<string, SpooledChunk>();
  const bodies = new Map<string, SpoolSource>();
  const spool = {
    held,
    refuseNext: false,
    keep(placement: ChunkPlacement, source: SpoolSource, epoch: number): SpooledChunk | null {
      if (spool.refuseNext) {
        spool.refuseNext = false;
        return null;
      }
      if (options.currentEpoch !== undefined && options.currentEpoch() !== epoch) return null;
      const key = `${placement.meetingId}/${placement.index}`;
      const chunk: SpooledChunk = {
        ...placement,
        chunkId: `${placement.meetingId}-${placement.index}`,
        mimeType: source.mimeType,
        key,
      };
      held.set(key, chunk);
      bodies.set(key, source);
      spoolChanged();
      return chunk;
    },
    list(): SpooledChunk[] {
      return [...held.values()].sort(byMeetingThenIndex);
    },
    async read(chunk: SpooledChunk): Promise<string> {
      const body = bodies.get(chunk.key);
      if (body === undefined) throw new Error("That chunk is not held.");
      if (body.kind === "bytes") return encodeBase64(body.bytes);
      if (options.readFile === undefined) throw new Error("No reader for a file source.");
      return options.readFile(body.uri);
    },
    confirm(chunk: SpooledChunk): void {
      held.delete(chunk.key);
      bodies.delete(chunk.key);
      spoolChanged();
    },
    forgetMeeting(meetingId: string): void {
      for (const [key, chunk] of held) {
        if (chunk.meetingId !== meetingId) continue;
        held.delete(key);
        bodies.delete(key);
      }
      spoolChanged();
    },
    forgetAll(): { left: number } {
      held.clear();
      bodies.clear();
      spoolChanged();
      return { left: 0 };
    },
  };
  return spool;
}
