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
 * `getDisplayMedia`, which costs a source picker, so the capability has to be
 * something somebody turns **on** deliberately — and with no sheet there was
 * nowhere left to turn it on.
 *
 * So the answer moved to the meetings settings pane and lives on the device.
 * `useMeetingFlow` reads it at the press rather than holding it in state: it is
 * changed in another pane, and a value captured on mount would record the wrong
 * thing for anybody who changed it without reloading.
 *
 * ## The default is what the surface costs
 *
 * `null` — nobody has answered — is not the same as a `false` somebody chose,
 * and `defaultMachineAudio` is where that distinction is spent: on in the
 * desktop shell, where the tap is free, off in a browser, where it is a prompt
 * in front of every meeting including the in-person ones. That is the sheet's
 * own rule, kept verbatim, because it was right about what each surface costs.
 *
 * Reads and writes swallow their own failures, exactly as `rememberDestination`
 * does: a device that cannot answer records without the tap, which is the same
 * as never having chosen, and there is no screen it would be honest to
 * interrupt to say so.
 */
export function defaultMachineAudio(needsPicker: boolean): boolean {
  return !needsPicker;
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
 * default for a surface that costs a picker.
 *
 * The press path's only reader. It takes `needsPicker` because the default is
 * a fact about the recorder rather than about the store — `useMeetingFlow` has
 * the recorder's capability in hand and this module deliberately does not
 * import one.
 */
export async function recallSystemAudio(
  store: KeyValueStore,
  needsPicker = true,
): Promise<boolean> {
  return (await recallMachineAudio(store)) ?? defaultMachineAudio(needsPicker);
}
