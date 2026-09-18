import { Directory, File, Paths } from "expo-file-system";
import { currentEpoch } from "../../offline/epoch";
import { isMeetingId } from "../protocol";
import {
  byMeetingThenIndex,
  spoolChanged,
  type AudioSpool,
  type ChunkPlacement,
  type SpoolSource,
  type SpooledChunk,
} from "./spoolShared";
import { chunkIdFor } from "./segments";
import { WAV_MIME } from "./wav";

/**
 * The spool on a phone: files under `<documents>/meeting-audio/<meetingId>/`.
 *
 * `spool.ts` has the argument for keeping audio at all. What is decided here is
 * where and how, and each choice has a failure it avoids:
 *
 * - **Documents, not caches.** iOS and Android both reserve the right to empty a
 *   cache directory when the device is short of space, and `audio.ts` sweeps
 *   `<caches>/ExpoAudio` on every launch. Audio that has not been transcribed is
 *   the only copy of those minutes of somebody's meeting; it lives where only
 *   this app deletes things. The cost, stated: an iOS document directory is
 *   included in the person's own device backup unless excluded, and this
 *   version of `expo-file-system` exposes no way to exclude it. It is their
 *   backup of their meeting — the same place their other app data goes — and a
 *   chunk is gone from the device the moment its words land.
 * - **The file name is the index.** `<index>_<offsetMs>_<durationMs>.<ext>` —
 *   no manifest, so a crash can never leave a manifest and the files
 *   disagreeing. A name that does not parse is not ours and is left alone.
 * - **Written beside, then moved in.** Bytes go to `<name>.part` and are renamed
 *   once complete, so a crash mid-write leaves a `.part` that is never sent,
 *   rather than a truncated WAVE the transcriber would turn into half a
 *   sentence. A finished recording (Android's `.m4a`) is simply moved: it is
 *   already whole, and a rename is the cheapest write there is.
 * - **The epoch is checked on both sides of the write.** Before, so a recorder
 *   still running after a sign-out writes nothing; after, so a write that was
 *   already under way when the session ended is taken back. The same two checks
 *   `features/offline` makes for a note body, for the same measured reason.
 */

const ROOT = "meeting-audio";
const NAME = /^(\d{1,6})_(\d{1,10})_(\d{1,10})\.(wav|m4a)$/;
const EXTENSION: Record<string, string> = { [WAV_MIME]: "wav", "audio/mp4": "m4a" };
const MIME: Record<string, string> = { wav: WAV_MIME, m4a: "audio/mp4" };

function root(): Directory {
  return new Directory(Paths.document, ROOT);
}

function meetingDirectory(meetingId: string): Directory {
  return new Directory(Paths.document, ROOT, meetingId);
}

function nameFor(placement: ChunkPlacement, extension: string): string {
  return `${placement.index}_${Math.max(0, Math.round(placement.offsetMs))}_${Math.max(
    0,
    Math.round(placement.durationMs),
  )}.${extension}`;
}

function chunkFrom(meetingId: string, file: File): SpooledChunk | null {
  const match = NAME.exec(file.name);
  if (match === null) return null;
  const index = Number(match[1]);
  return {
    meetingId,
    index,
    chunkId: chunkIdFor(meetingId, index),
    offsetMs: Number(match[2]),
    durationMs: Number(match[3]),
    mimeType: MIME[match[4] ?? ""] ?? WAV_MIME,
    key: file.uri,
  };
}

function quietly(work: () => void): void {
  try {
    work();
  } catch {
    // A delete of something already gone, or a path this build cannot open.
  }
}

export function createDeviceSpool(): AudioSpool {
  function list(): SpooledChunk[] {
    const found: SpooledChunk[] = [];
    try {
      const top = root();
      if (!top.exists) return found;
      for (const entry of top.list()) {
        if (!(entry instanceof Directory) || !isMeetingId(entry.name)) continue;
        for (const item of entry.list()) {
          if (!(item instanceof File)) continue;
          const chunk = chunkFrom(entry.name, item);
          if (chunk !== null) found.push(chunk);
        }
      }
    } catch {
      /*
        A directory that cannot be listed right now. Answered as what was found
        so far rather than thrown: this runs from a render path (the counts)
        and from a drain, and neither can do anything with a throw. Nothing is
        deleted on this path, so a listing that failed loses nothing.
      */
    }
    return found.sort(byMeetingThenIndex);
  }

  return {
    keep(placement, source: SpoolSource, epoch) {
      if (!isMeetingId(placement.meetingId)) return null;
      const extension = EXTENSION[source.mimeType];
      if (extension === undefined) return null;
      if (epoch !== currentEpoch()) return null;

      let target: File | null = null;
      let part: File | null = null;
      try {
        const directory = meetingDirectory(placement.meetingId);
        directory.create({ intermediates: true, idempotent: true });
        target = new File(directory, nameFor(placement, extension));
        if (source.kind === "bytes") {
          part = new File(directory, `${target.name}.part`);
          part.create({ overwrite: true });
          part.write(source.bytes);
          part.move(target);
        } else {
          new File(source.uri).move(target);
        }
      } catch {
        /*
          Nothing kept, and nothing half-kept. For a file source the recording
          is still where it was, so the caller's old path — send it once, delete
          it — is still available to it; that is why this answers `null` rather
          than throwing.
        */
        if (part !== null) quietly(() => part?.delete());
        if (target !== null) quietly(() => target?.delete());
        return null;
      }

      // The second check. See the header.
      if (epoch !== currentEpoch()) {
        quietly(() => target?.delete());
        return null;
      }

      const chunk = chunkFrom(placement.meetingId, target);
      spoolChanged();
      return chunk;
    },

    list,

    async read(chunk) {
      return new File(chunk.key).base64();
    },

    confirm(chunk) {
      quietly(() => new File(chunk.key).delete());
      quietly(() => {
        const directory = meetingDirectory(chunk.meetingId);
        if (directory.exists && directory.list().length === 0) directory.delete();
      });
      spoolChanged();
    },

    forgetMeeting(meetingId) {
      if (!isMeetingId(meetingId)) return;
      quietly(() => {
        const directory = meetingDirectory(meetingId);
        if (directory.exists) directory.delete();
      });
      spoolChanged();
    },

    forgetAll() {
      quietly(() => {
        const top = root();
        if (top.exists) top.delete();
      });
      spoolChanged();
      /*
        Re-listed rather than trusted, the stance `features/offline/forget.ts`
        takes for every clear it makes: a delete that did not land must be able
        to say so. `.part` files are not chunks and are not counted — but they
        live inside the directory that was just deleted, so a clear that worked
        took them too.
      */
      let left = list().length;
      try {
        if (root().exists) left = Math.max(left, 1);
      } catch {
        // Could not look. What `list` answered is the floor.
      }
      return { left };
    },
  };
}

export const deviceSpool: AudioSpool | null = createDeviceSpool();
