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
 *  - **Only one of the five recorders can produce one.** The desktop shell
 *    holds an `AnalyserNode` on the stream it is recording; the phone's
 *    `expo-audio` and the browser's `MediaRecorder` do not. Putting it on the
 *    shared interface would oblige four implementations to answer a question
 *    they cannot, and the honest answers would all be `null`.
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
      setLevel(null);
      return;
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
