import { getRecordingPermissionsAsync, requestRecordingPermissionsAsync } from "expo-audio";
import { currentEpoch } from "../../../offline/epoch";
import type { CaptureOptions, MeetingRecorder, RecorderError } from "../index";
import type { RecorderInternals } from "./internals";
import { configureAudioSession } from "./audioSession";
import {
  ALREADY_RECORDING,
  IOS_BACKGROUND_UNAVAILABLE,
  MIC_DENIED,
  messageOf,
  requireSessionId,
} from "./messages";
import type { Chunks } from "./chunks";
import type { Device } from "./device";
import type { Rotation } from "./rotation";
import type { Sender } from "./sender";

/**
 * The recorder's verbs — `start`, `pause`, `resume`, `stop`, `drain` — moved
 * out of `audio.ts` unchanged. `audio.ts` still builds the object a caller
 * gets, so the surface `meetingsCapture` pins by name is decided there.
 */
export function createLifecycle(
  rec: RecorderInternals,
  platform: "ios" | "android",
  deps: {
    queue(work: () => Promise<void>): Promise<void>;
    report(error: RecorderError): void;
    device: Device;
    rotation: Rotation;
    cancelResume(): void;
    closeChunk: Chunks["closeChunk"];
    drainSends: Sender["drainSends"];
  },
): Pick<MeetingRecorder, "start" | "pause" | "resume" | "stop"> & { drain(): Promise<void> } {
  const { queue, report, cancelResume, closeChunk, drainSends } = deps;
  const { openDevice, openChunk, releaseDevice } = deps.device;
  const { startRotation, stopRotation } = deps.rotation;

  async function ensurePermission(): Promise<boolean> {
    const current = await getRecordingPermissionsAsync();
    if (current.granted) return true;
    if (!current.canAskAgain) return false;
    const asked = await requestRecordingPermissionsAsync();
    return asked.granted;
  }

  return {
    async start(options?: CaptureOptions) {
      /*
        The id is read before the state, because what "already recording"
        means depends on it: the same meeting twice is one start, and a second
        meeting is a refusal. See `ALREADY_RECORDING`.
      */
      const meetingId = requireSessionId(options);
      if (rec.state === "recording") {
        if (meetingId === rec.sessionKey) return;
        throw new Error(ALREADY_RECORDING);
      }
      // Before the first await, and after the refusal above: a start that is
      // refused must not have taken ownership of the meeting already running,
      // or the first meeting's in-flight sends would be folded into nobody.
      // See `owner`.
      rec.owner = meetingId;
      rec.epoch = currentEpoch();
      if (!(await ensurePermission())) throw new Error(MIC_DENIED);
      rec.sessionWarning = null;
      const backgroundEnabled = await configureAudioSession(platform);

      rec.sessionKey = meetingId;
      rec.chunkIndex = 0;
      rec.chunkStartOffsetMs = 0;
      rec.interrupted = false;
      rec.interruptedAtMs = 0;

      try {
        await openDevice();
        await openChunk();
      } catch (error: unknown) {
        await releaseDevice();
        rec.state = "idle";
        throw new Error(messageOf(error, MIC_DENIED));
      }

      rec.state = "recording";
      startRotation();
      if (!backgroundEnabled) {
        rec.sessionWarning = {
          recoverable: true,
          kind: "background-unavailable",
          message: IOS_BACKGROUND_UNAVAILABLE,
        };
        report(rec.sessionWarning);
      }
    },

    async pause() {
      stopRotation();
      cancelResume();
      const wasCapturing = rec.state === "recording";
      if (wasCapturing) {
        await queue(async () => {
          await closeChunk(Math.max(0, Date.now() - rec.chunkStartedAtMs));
          /*
            AND THE MICROPHONE GOES BACK, WHICH IT DID NOT USED TO HAVE TO.

            On the rotating path `closeChunk` stopped the device itself, so a
            paused meeting held a stopped recorder and `resume`'s `openDevice`
            tidied it away later. A continuous recorder is still running after
            its slice — that is the point of it — so pausing without this would
            leave the input open, the red indicator up, and the file growing
            for the length of a pause, all of which `resume` would then throw
            away. Released here, both paths mean the same thing by `paused`.
          */
          await releaseDevice();
        });
      }
      /*
        `interrupted` is cleared here and in `resume` because `cancelResume`
        above kills the retry that would otherwise have cleared it. Left set, it
        made `handleFailure`'s guard return for the rest of the meeting — so a
        microphone permission revoked later was never noticed at all: no error,
        no release, and a session recording silence while reporting health.
      */
      rec.interrupted = false;
      rec.interruptedAtMs = 0;
      /*
        Not unconditionally, and this is the second lock `resume` already has.
        There are two ways to arrive here with the device already back: `stop()`
        ran first, or the `closeChunk` above gave capture up — a chunk with
        nowhere to send releases the device. Writing `paused` over either would
        put a released device back within reach of `resume`, which would reopen
        the microphone for a session that has nowhere to send the next chunk
        either. `wasCapturing` rather than a second read of `state`, because
        `closeChunk` can move it from under this method.
      */
      if (rec.state !== "stopped") rec.state = "paused";
    },

    async resume() {
      if (rec.state === "recording") return;
      /*
        A meeting that has ended does not reopen the microphone. `stop()` is
        "stop and release the device", and the controller's own state table
        already refuses `resume` after `end` — this is the second lock on the
        one failure that leaves a red bar over an app somebody has finished
        with.
      */
      if (rec.state === "stopped") return;
      cancelResume();
      rec.interrupted = false;
      rec.interruptedAtMs = 0;
      await queue(async () => {
        await openDevice();
        await openChunk();
      });
      rec.state = "recording";
      startRotation();
    },

    async stop() {
      stopRotation();
      cancelResume();
      const wasCapturing = rec.state === "recording";
      rec.state = "stopped";
      await queue(async () => {
        /*
          `finally`, and this is the most expensive line in the file to get
          wrong. `closeChunk` used to await the transcriber, which throws on
          every worker fault — offline, 502, 401, bad JSON — and the rejection
          escaped this arrow into `queue`'s catch, so `releaseDevice()` never
          ran. Ending a meeting with no signal is the ordinary case, and on iOS
          the result is the red bar across the status bar for the life of the
          process. **Releasing the device cannot depend on the send.**
        */
        try {
          if (wasCapturing) await closeChunk(Math.max(0, Date.now() - rec.chunkStartedAtMs));
        } finally {
          await releaseDevice();
        }
      });
    },

    /**
     * WAIT FOR WHAT IS STILL BEING TRANSCRIBED. SEPARATE FROM `stop()`.
     *
     * This used to be the last line of `stop()`, with a comment saying the
     * wait "costs a spinner rather than a microphone". Two things made that
     * wrong once a meeting was one continuous recording.
     *
     * The microphone half was false on this path — the device is released
     * *after* `closeChunk`, and `closeChunk` is where the waiting moved to, so
     * the input stayed open for the length of the drain. That is fixed where it
     * happened, by stopping the device before slicing.
     *
     * The spinner half was worse than it sounds. `controller.end()` cannot fold
     * the `end` event until `stop()` resolves, so the session stayed
     * `recording` for the whole of it: the live screen, the running clock, and
     * the microphone chip, over a meeting the person had finished — for however
     * long a transcription took. *"The post processing step was just really
     * slow… the countdown doesn't stop."*
     *
     * What the wait buys is unchanged and still worth having: the end of the
     * meeting reaches the note before the finalize composes it, rather than
     * arriving after the first sync. So it is kept and moved. The controller
     * ends the meeting, lands the person on the screen that says *"your context
     * is writing this up"*, and waits here — which is the same wait in front of
     * the right words.
     */
    async drain() {
      await drainSends();
    },
  };
}
