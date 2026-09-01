import * as Clipboard from "expo-clipboard";

/**
 * Clipboard — native.
 *
 * **This used to be `return false`, always**, on the reasoning that
 * `expo-clipboard` was not a dependency and web was the shipping surface. The
 * first half stopped being true when the native baseline was chosen (see
 * CLAUDE.md, "The native baseline was chosen once"): `expo-clipboard` is in
 * `native-deps.json` `core`, so it is in every build ever shipped and may be
 * imported statically with no runtime gate and no `runtimeVersion` bump.
 *
 * The second half was never a reason to lie, and the old stub did not lie — it
 * reported failure honestly so the UI could leave the label alone. What made
 * that honesty expensive is that the honest answer reached a person: with the
 * share dialog now *saying* what happened rather than silently declining to
 * relabel a button, "Couldn't reach the clipboard" is what Copy link told
 * somebody in the app. Reporting an absent capability is right; leaving it
 * absent when the module is sitting in the binary is not.
 */
export async function writeClipboard(text: string): Promise<boolean> {
  try {
    await Clipboard.setStringAsync(text);
    return true;
  } catch {
    // Still honest. A refusal here is real — the caller says the copy did not
    // happen rather than claiming one, which is the rule this file has always
    // followed and the reason it returns a boolean at all.
    return false;
  }
}

/**
 * The native half of `copyDeferred` — see the web file for what it is for.
 *
 * There is no user-activation window to preserve here: the web version exists
 * because Safari grants the clipboard only inside the gesture a press starts,
 * and an `await` spends it. Native has no such rule, so this is the plain
 * shape — run the round trip, then write.
 *
 * The text comes back either way, because a caller that could not copy still
 * has something worth showing.
 */
export async function copyDeferred(
  produce: () => Promise<string | null>,
): Promise<{ ok: boolean; text: string | null }> {
  const value = await produce();
  if (value === null) return { ok: false, text: null };
  return { ok: await writeClipboard(value), text: value };
}
