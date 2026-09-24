import { SEGMENT_MS } from "../segments";
import { meterLevel, publishRecorderLevel } from "../level";
import type { RecorderInternals } from "./internals";
import { MAX_SLICE_MS } from "./recordingFormat";
import type { Chunks } from "./chunks";

/**
 * How often the phone's own meter is read, in milliseconds.
 *
 * Ten times a second, which is what the desktop shell's bridge pushes and what
 * a meter needs to look like it is responding to a voice rather than sampling
 * one. `getStatus()` is a cheap native read and the reading goes to a module
 * channel rather than through the controller, so it re-renders `LiveWaveform`
 * and nothing else — `capture/level.ts` carries that argument, and it is the
 * reason this is a poll here rather than an event on `MeetingRecorder`.
 */
const LEVEL_INTERVAL_MS = 100;

/**
 * The tick that cuts a chunk every `SEGMENT_MS`, and the meter that lives
 * exactly as long as it does. Moved out of `audio.ts` whole.
 */
export function createRotation(
  rec: RecorderInternals,
  deps: {
    queue(work: () => Promise<void>): Promise<void>;
    openChunk(): Promise<void>;
    chunks: Chunks;
  },
) {
  const { queue, openChunk } = deps;
  const { sliceOnce, closeChunk, abandonIfNowhereToSend } = deps.chunks;

  function startRotation(): void {
    stopRotation();
    startLevelPolling();
    rec.rotationTimer = setInterval(() => {
      void queue(async () => {
        /*
          ON A CONTINUOUS RECORDER THIS TICK TOUCHES THE DEVICE NOT AT ALL.

          It reads the file and leaves the microphone exactly as it found it,
          which is the whole of the fix: the call iOS refuses from the
          background is `record()`, and nothing on this path makes one.
        */
        if (rec.continuous) {
          if (await abandonIfNowhereToSend()) return;
          sliceOnce(MAX_SLICE_MS);
          return;
        }
        /*
          `finally`, because a chunk that could not be closed used to cost the
          twenty seconds after it as well: the arrow rejected before
          `openChunk()`, so nothing recorded until the next tick — and neither
          that dead interval nor the failed chunk's own was ever added to the
          offset. One flaky chunk was forty seconds of a meeting and a permanent
          shift in every timestamp after it.
        */
        try {
          await closeChunk(SEGMENT_MS);
        } finally {
          await openChunk();
        }
      });
    }, SEGMENT_MS);
  }

  /**
   * PUBLISH WHAT THE MICROPHONE IS HEARING, TEN TIMES A SECOND.
   *
   * Straight to `capture/level.ts`'s channel and to nothing else. It does not
   * touch the session, the controller, or any listener this module already
   * has: a level is a decoration, *"no meeting, no note, no segment is
   * affected by whether this hook ever fires"*, and routing it through the
   * controller would rebuild the app's meetings snapshot six hundred times a
   * minute for a number one leaf reads.
   *
   * A reading that is absent, not a number, or infinite is published as
   * `null` rather than as zero. `Waveform` draws a different mark for "nothing
   * can tell you" than for "listening, and the room is quiet", and collapsing
   * the two is exactly the flat-bar-reads-as-dead-microphone defect the meter
   * was rebuilt to fix.
   */
  function startLevelPolling(): void {
    stopLevelPolling();
    rec.levelTimer = setInterval(() => {
      const active = rec.device;
      if (active === null || rec.state !== "recording") {
        publishRecorderLevel(null);
        return;
      }
      try {
        publishRecorderLevel(meterLevel(active.getStatus().metering));
      } catch {
        /*
          A status read can throw on a device that is going away underneath
          this timer. It is not a capture failure and it is not worth a chip:
          the meter says it has no reading and the next tick tries again.
        */
        publishRecorderLevel(null);
      }
    }, LEVEL_INTERVAL_MS);
  }

  function stopLevelPolling(): void {
    if (rec.levelTimer !== null) clearInterval(rec.levelTimer);
    rec.levelTimer = null;
    /*
      Said rather than left. A meter that keeps its last reading after the
      microphone has gone is the same lie as one that never moves, pointed the
      other way — it would draw a loud room over a meeting that has ended.
    */
    publishRecorderLevel(null);
  }

  function stopRotation(): void {
    if (rec.rotationTimer !== null) clearInterval(rec.rotationTimer);
    rec.rotationTimer = null;
    /*
      The meter's life is the rotation's, because they are the same life: both
      run exactly while this recorder is capturing, and every path that starts
      or stops one wants the other. Tied here rather than at the six call
      sites, which is how one of them would come to be missed.
    */
    stopLevelPolling();
  }

  return { startRotation, stopRotation };
}

export type Rotation = ReturnType<typeof createRotation>;
