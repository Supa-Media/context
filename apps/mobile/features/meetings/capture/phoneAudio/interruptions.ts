import { getRecordingPermissionsAsync } from "expo-audio";
import type { RecordingStatus } from "expo-audio";
import type { RecorderError } from "../index";
import type { RecorderInternals } from "./internals";
import { INTERRUPTED, MIC_REVOKED } from "./messages";
import type { Chunks } from "./chunks";
import type { Device } from "./device";
import type { Rotation } from "./rotation";

/** How often an interrupted session tries to get the microphone back. */
export const RESUME_RETRY_MS = 2_000;

/**
 * What happens when the microphone goes away mid-meeting: given up for good,
 * or waited out and taken back. Moved out of `audio.ts` whole.
 */
export function createInterruptions(
  rec: RecorderInternals,
  deps: {
    queue(work: () => Promise<void>): Promise<void>;
    report(error: RecorderError): void;
    device: Device;
    rotation: Rotation;
    closeChunk: Chunks["closeChunk"];
  },
) {
  const { queue, report, closeChunk } = deps;
  const { openDevice, openChunk, releaseDevice } = deps.device;
  const { startRotation, stopRotation } = deps.rotation;

  function cancelResume(): void {
    if (rec.resumeTimer !== null) clearTimeout(rec.resumeTimer);
    rec.resumeTimer = null;
  }

  /**
   * Give capture up for the rest of this meeting, and put the device back.
   *
   * The same shape as a revoked permission, because it is the same situation
   * from the person's side: nothing more is going to be transcribed, so holding
   * the microphone would be recording for nobody.
   */
  async function abandon(message: string): Promise<void> {
    stopRotation();
    cancelResume();
    rec.state = "stopped";
    await releaseDevice();
    report({ recoverable: false, message });
  }

  /**
   * The device said something went wrong. Which kind it is decides everything.
   *
   * A revoked permission is the end of capture for this meeting; anything else
   * is treated as an interruption, because that is the honest reading of "the
   * input stopped and we are still allowed to have it". Guessing the other way
   * — calling every failure fatal — would turn a ten-second Siri query into a
   * meeting that silently never records again.
   */
  function onStatus(status: RecordingStatus): void {
    if (!status.hasError) return;
    void queue(() => handleFailure());
  }

  async function handleFailure(): Promise<void> {
    /*
      `interrupted` is what keeps a burst of failures from being a burst of
      chips. It is also why `state` is set *before* the device is released
      below: releasing emits another status, and without the flag that status
      would re-enter here and report a second time.
    */
    if (rec.state !== "recording" || rec.interrupted) return;
    stopRotation();
    const permission = await getRecordingPermissionsAsync();
    if (!permission.granted) {
      await abandon(MIC_REVOKED);
      return;
    }
    rec.interrupted = true;
    rec.interruptedAtMs = Date.now();
    /*
      The partial goes out with the length it actually ran for.

      Without this the chunk was simply dropped — `scheduleResume`'s
      `openDevice()` discards the file — and neither its seconds nor the
      interruption's were added to the offset, so after a thirty-second call
      every later segment was thirty seconds early, compounding per
      interruption. `docs/decisions/meetings.md` needs a flag's `at` on the
      right sentence, and this is the arithmetic that decides which sentence
      that is. (`audio.web.ts` always did this; the phone did not.)
    */
    await closeChunk(Math.max(0, Date.now() - rec.chunkStartedAtMs));
    /*
      That close can give capture up — a chunk with nowhere to send releases the
      device — and telling somebody "capture picks up when it is free" about a
      recorder that has stopped is two sentences for one event, the second of
      them false.
    */
    if (rec.state !== "recording") return;
    report({ recoverable: true, message: INTERRUPTED });
    scheduleResume();
  }

  function scheduleResume(): void {
    cancelResume();
    rec.resumeTimer = setTimeout(() => {
      rec.resumeTimer = null;
      void queue(async () => {
        if (rec.state !== "recording") return;
        try {
          await openDevice();
          await openChunk();
        } catch {
          // Still busy. Try again rather than giving the session up: the person
          // is in a meeting and there is nothing for them to do about this.
          scheduleResume();
          return;
        }
        /*
          The input was gone for this long and no audio exists for it, but the
          session was `recording` throughout — which is what `elapsedMs` counts
          and what a flag's `at` is measured against. So the gap is session time
          and it belongs in the offset.
        */
        rec.chunkStartOffsetMs += Math.max(0, rec.chunkStartedAtMs - rec.interruptedAtMs);
        rec.interrupted = false;
        rec.interruptedAtMs = 0;
        startRotation();
      });
    }, RESUME_RETRY_MS);
  }

  return { cancelResume, abandon, onStatus };
}
