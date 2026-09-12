import { useEffect, useState } from "react";
import { getDesktopBridge, type DesktopBridge } from "@context/desktop-bridge";

/**
 * How loud the thing that is recording can hear, if anything can say.
 *
 * ## Why this is not on `MeetingRecorder`
 *
 * Every other fact about a recording — its state, its segments, its faults —
 * reaches the app through the recorder interface, and a level deliberately does
 * not. Three reasons, and the first is the one that decided it:
 *
 *  - **It moves ten times a second.** `MeetingRecorder`'s events all run
 *    through the controller, whose `onChange` rebuilds the app's whole meetings
 *    snapshot; a level on that path would rebuild it 600 times a minute for a
 *    number nothing else reads. Subscribed here, at the leaf that draws it, a
 *    reading re-renders one component and the screen around it never learns.
 *  - **Not every recorder can produce one.** This said "only one of the five",
 *    naming the desktop shell's `AnalyserNode` and asserting that "the phone's
 *    `expo-audio` and the browser's `MediaRecorder` do not" — and the first
 *    half of that was wrong. `expo-audio` meters on both phone platforms
 *    (`isMeteringEnabled`, then `metering` on `getStatus()`), and because
 *    nobody had checked, every meeting recorded on a phone drew a mark that
 *    could not move. The owner lost an evening to it twice: once concluding
 *    his microphone was dead, once asking why the meter that is "supposed to"
 *    does not.
 *
 *    The conclusion survives the correction. `notesOnly` has no input at all,
 *    a browser's `MediaRecorder` has no meter, and a build with no shell has no
 *    bridge — so the interface would still oblige implementations to answer a
 *    question they cannot, and `null` would still be the honest answer for
 *    some of them. The channel below is how the two that *can* answer do,
 *    without the other two having to.
 *  - **It is a decoration, and nothing may depend on it.** No meeting, no
 *    note, no segment is affected by whether this hook ever fires.
 *
 * ## `null` is not zero, and the difference is the whole bug
 *
 * `0` is *something is listening and the room is quiet*. `null` is *nothing
 * here can tell you* — a phone, a browser, a shell older than the level
 * channel. Collapsing the second into the first is precisely the defect this
 * exists to fix, one level up: a meter that says "silent" where it means "I
 * have no idea" is the flat bar that reads as a dead microphone.
 */

/**
 * One number for the meter, from the two the bridge carries.
 *
 * **The wire carries both channels and the glass draws one.** `AudioLevel` is
 * `{ mic, systemAudio }` because the shell genuinely knows both and a
 * diagnostics screen may one day want the split — but two meters side by side
 * would be a worse answer to the question somebody is actually asking. That
 * question is *"can it hear anything"*, and on the two builds that exist it
 * would be read wrong in both directions: on an unsigned build there is no
 * loopback tap at all, so the second bar would sit flat for the whole meeting
 * and reintroduce the exact misreading this change removes; on a signed one it
 * sits flat whenever nobody on the call is talking, which is most of the time
 * you are. So it is the louder of the two, which is the honest answer to "is
 * this recording hearing anything".
 */
export function loudest(level: { mic: number; systemAudio: number }): number {
  const mic = Number.isFinite(level.mic) ? level.mic : 0;
  const system = Number.isFinite(level.systemAudio) ? level.systemAudio : 0;
  return Math.min(1, Math.max(0, Math.max(mic, system)));
}

/**
 * Subscribe to the shell's meter while `live`, and hand back what it says.
 *
 * `null` whenever nothing can answer: not live, no bridge, or a bridge that has
 * not spoken yet. The last of those is a real state and not a race worth
 * papering over — the shell posts a heartbeat at least once a second, so a
 * console window opened mid-meeting is drawing a real level within one.
 */
export function useAudioLevel(
  live: boolean,
  bridgeOf: () => DesktopBridge | null = getDesktopBridge,
): number | null {
  const [level, setLevel] = useState<number | null>(null);

  useEffect(() => {
    if (!live) {
      setLevel(null);
      return;
    }
    const bridge = bridgeOf();
    if (bridge === null || typeof bridge.onLevel !== "function") {
      /*
        No shell, so the phone's own recorder is the only thing that can
        answer — and until this branch existed, nothing did: `null` meant the
        meter drew its static silhouette for the whole of every meeting on
        every phone. The owner read that as a microphone that could not hear
        him, which is what `Waveform`'s header calls "the flat bar that reads
        as a dead microphone", and the sentence under it — *"a meter that
        responds to sound is a capability claim"* — is only bearable when
        something is measuring. Now something is.

        The bridge is still preferred where there is one: it hears the
        machine's own audio as well as the microphone, and the phone's meter
        cannot.
      */
      const offRecorder = onRecorderLevel(setLevel);
      return () => {
        offRecorder();
        setLevel(null);
      };
    }
    /*
      Every subscription on the bridge hands back its own unsubscribe — the one
      place that surface deliberately differs from the shell's old renderer API
      — and this is a component that mounts and unmounts per meeting. A handler
      that could not be detached would be a second meter writing into an
      unmounted tree, ten times a second, for the rest of the session.
    */
    const off = bridge.onLevel((reading) => setLevel(loudest(reading)));
    return () => {
      off();
      setLevel(null);
    };
    // `bridgeOf` is a stable module function at every real call site; it is a
    // parameter so the suite can drive this without a global.
  }, [live, bridgeOf]);

  return level;
}

/* ------------------------- the phone's own meter -------------------------- */

/**
 * THE FLOOR OF THE METER, IN DECIBELS BELOW FULL SCALE.
 *
 * Both platforms answer in dBFS — iOS from `AVAudioRecorder.averagePower`,
 * Android by converting `MediaRecorder.maxAmplitude` with the same -160 floor
 * — so one number maps both. It is a **display** floor and not the format's:
 * -160 is digital silence, and scaling a meter across 160 dB would leave a
 * human voice in the top eighth of the bar and everything quieter flat.
 *
 * -55 is roughly a quiet room on a phone microphone. Speech at arm's length
 * lands around -25 to -15, which is the middle and upper half of the mark, and
 * that is the range a person is actually reading: *"can it hear me talking"*.
 */
export const METER_FLOOR_DB = -55;

/**
 * A decibel reading as a fraction of the meter, or `null` for no reading.
 *
 * `null` in is `null` out, and that is load-bearing rather than defensive:
 * `metering` is absent from a recorder that was not asked for it and from one
 * that is not running, and `Waveform` draws *a different thing* for "nothing
 * can tell you" than for "listening, and the room is quiet". Mapping an absent
 * reading to 0 would collapse the two and reintroduce the bug this whole seam
 * exists to close.
 *
 * `NaN` is treated as absent for the same reason — `20 * log10(0)` is
 * `-Infinity` on one platform and a hardware read can fail on the other, and
 * neither is a quiet room.
 */
export function meterLevel(db: number | null | undefined): number | null {
  if (typeof db !== "number" || !Number.isFinite(db)) return null;
  if (db <= METER_FLOOR_DB) return 0;
  if (db >= 0) return 1;
  return (db - METER_FLOOR_DB) / -METER_FLOOR_DB;
}

/**
 * The channel between the phone's recorder and the one leaf that draws a meter.
 *
 * **Deliberately not on `MeetingRecorder`, and not through the controller**,
 * for the reasons this file's own header gives: a level moves ten times a
 * second, and everything that reaches the controller rebuilds the app's whole
 * meetings snapshot — six hundred times a minute, for a number nothing else
 * reads. A module channel keeps the cost at `LiveWaveform` and leaves the
 * recorder interface as the four implementations can honestly fill it.
 *
 * One publisher at a time, which is what a device is. A meeting that ends
 * publishes `null` rather than stopping quietly, so a meter that outlives it by
 * a frame draws "nothing is listening" rather than the last loud moment.
 */
const recorderLevelListeners = new Set<(level: number | null) => void>();

export function publishRecorderLevel(level: number | null): void {
  for (const listener of recorderLevelListeners) {
    try {
      listener(level);
    } catch {
      // A screen's bug is never a reason to break capture. `audio.ts` guards
      // its own listeners the same way and says why.
    }
  }
}

export function onRecorderLevel(listener: (level: number | null) => void): () => void {
  recorderLevelListeners.add(listener);
  return () => {
    recorderLevelListeners.delete(listener);
  };
}
