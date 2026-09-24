import { AudioModule } from "expo-audio";
import type { RecordingStatus } from "expo-audio";
import type { RecorderInternals } from "./internals";
import { ANDROID_RECORDING_OPTIONS, PCM_RECORDING_OPTIONS } from "./recordingFormat";
import { discard } from "./recordingFiles";

/**
 * Opening, starting and putting back the microphone. Moved out of
 * `audio.ts` whole; `onStatus` is handed in because what a failure means is
 * `interruptions.ts`'s question, not the device's.
 */
export function createDevice(
  rec: RecorderInternals,
  deps: { onStatus(status: RecordingStatus): void },
) {
  const { onStatus } = deps;

  /** Fresh device, fresh status subscription. Also the recovery path. */
  async function openDevice(): Promise<void> {
    await releaseDevice();
    /*
      `as never` on the flat object, for the reason its own comment gives: the
      published `RecordingOptions` type describes the *nested* shape the hook
      takes, and the constructor's runtime contract is the flat record the
      native side decodes. The two disagree, the native one is what runs, and
      lying to the type here is better than nesting an object that would be
      silently ignored. Android keeps the preset it has always had.
    */
    const opened = new AudioModule.AudioRecorder(
      rec.continuous
        ? (PCM_RECORDING_OPTIONS as never)
        : ANDROID_RECORDING_OPTIONS,
    );
    rec.statusSubscription = opened.addListener("recordingStatusUpdate", onStatus);
    rec.device = opened;
    /*
      A new device writes a new file, so what this module knows about the old
      one is now wrong — and wrong in the direction that loses audio: a read
      offset carried over from a recording that had grown past the new one's
      header would start the new recording part-way in, silently dropping the
      first words after every pause and every interruption. Cleared here rather
      than at each call site, because `openDevice` is the one place a file is
      replaced.

      **The format is the one that carries it, and the offset is belt.**
      Clearing `pcmFormat` is what makes `sliceOnce` re-read the header, and
      re-reading the header is what sets `pcmRead` to the new file's own
      `dataOffset` — so the second line below cannot be observed failing on its
      own, and a check for it would be a check of nothing. Sabotage says so:
      removing `pcmRead = 0` leaves `resuming does not re-send what it heard`
      green, and removing `pcmFormat = null` does not. It is kept because the
      two facts belong to the same file and separating them is how the next
      person introduces the bug the paragraph above describes.
    */
    rec.pcmFormat = null;
    rec.pcmRead = 0;
  }

  async function releaseDevice(): Promise<void> {
    const open = rec.device;
    rec.device = null;
    rec.statusSubscription?.remove();
    rec.statusSubscription = null;
    if (open === null) return;
    await open.stop().catch(() => {});
    /*
      A recording the session never got round to sending — the microphone was
      revoked mid-chunk, or the app is being torn down — is still a recording of
      somebody's meeting. It goes the same way as every other one, unless a send
      is still reading it: `send` deletes the file it owns before its request
      goes out, and deleting it from under that read would lose the chunk.
    */
    const leftover = open.uri;
    if (leftover !== null && !rec.inFlightUris.has(leftover)) discard(leftover);
    open.release();
  }

  /**
   * Begin recording. The clock for the open piece of audio starts here.
   *
   * **On a continuous recorder this runs once per device and not once per
   * chunk**, which is the entire fix: `record()` is the call iOS refuses from
   * the background, so the rotation calls it never and only `start`, `resume`
   * and the interruption recovery — all of which are either in the foreground
   * or already failing — ever reach it.
   *
   * It is still safe to call twice: `prepareToRecordAsync` on a recorder that
   * is already going would restart the file, so a device that is recording is
   * left alone.
   */
  async function openChunk(): Promise<void> {
    const active = rec.device;
    if (active === null) return;
    if (!(rec.continuous && active.isRecording)) {
      await active.prepareToRecordAsync();
      active.record();
    }
    rec.chunkStartedAtMs = Date.now();
  }

  return { openDevice, releaseDevice, openChunk };
}

export type Device = ReturnType<typeof createDevice>;
