import type { KeyValueStore } from "../offline/memory";
import { machineAudioKey } from "./keys";

/**
 * Whether a recording takes this machine's own audio as well as the microphone.
 *
 * ## Why this is a stored setting rather than a question
 *
 * It was a switch on the destination sheet, answered before every meeting, and
 * the sheet is gone — a press of New meeting records. Letting the switch go
 * with it would be fine on a phone (which cannot do this at all) and inside the
 * desktop shell (which taps silently, and does it by default). It would not be
 * fine in a browser: there the far side of a call is reachable only through
 * `getDisplayMedia`, which costs a source picker, and somebody who never wants
 * that picker needs somewhere to say so.
 *
 * So the answer moved to the meetings settings pane and lives on the device.
 * `useMeetingFlow` reads it at the press rather than holding it in state: it is
 * changed in another pane, and a value captured on mount would record the wrong
 * thing for anybody who changed it without reloading.
 *
 * ## The default is on, everywhere, including in a browser
 *
 * `null` — nobody has answered — is not the same as a `false` somebody chose,
 * and `defaultMachineAudio` is where that distinction is spent. It used to be
 * spent by surface: on in the desktop shell, where the tap is free, and off in
 * a browser, where it costs a source picker in front of every meeting. That was
 * the wrong trade. People recorded calls on headphones from a browser and got
 * one side of the conversation, and found out only when they read the note —
 * a picker every meeting is an annoyance, a transcript missing half the call is
 * a meeting lost. The owner decided (2026-09-26) that the picker is the price.
 *
 * So the default is on wherever the recorder can take the machine's audio at
 * all. Somebody who only ever records in-person meetings turns it off once, in
 * the meetings pane, and that `false` is kept. Declining the picker for one
 * meeting is not that answer: the recording goes ahead from the microphone and
 * says so (`SYSTEM_AUDIO_UNSHARED`), and the next meeting asks again.
 *
 * Reads and writes swallow their own failures, exactly as `rememberDestination`
 * does: a device that cannot answer records with the default, which is the
 * same as never having chosen, and there is no screen it would be honest to
 * interrupt to say so.
 */
export function defaultMachineAudio(): boolean {
  return true;
}

/** `null` when this device has never been asked. */
export async function recallMachineAudio(store: KeyValueStore): Promise<boolean | null> {
  try {
    const raw = await store.get(machineAudioKey());
    if (raw === "on") return true;
    if (raw === "off") return false;
    return null;
  } catch {
    return null;
  }
}

export async function rememberMachineAudio(store: KeyValueStore, on: boolean): Promise<void> {
  try {
    await store.set(machineAudioKey(), on ? "on" : "off");
  } catch {
    // See the header: a preference that cannot be written costs one meeting's
    // worth of the default, and nothing about the recording itself.
  }
}

/**
 * What the next recording will do, as one call: the stored answer, or the
 * default. The press path's only reader.
 */
export async function recallSystemAudio(store: KeyValueStore): Promise<boolean> {
  return (await recallMachineAudio(store)) ?? defaultMachineAudio();
}
