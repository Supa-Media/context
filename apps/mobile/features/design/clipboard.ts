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
 *
 * **Nothing in `pnpm test` runs this file**, and that is worth knowing rather
 * than assuming a green suite covered it. `jest.config.js` resolves `.web.ts`
 * ahead of the bare extension — deliberately, so the suite exercises what
 * ships to the browser — and its own comment records that the native halves of
 * every platform split "were never once" reached. What stands in for a test
 * here is the dependency's own type: `setStringAsync` answers
 * `Promise<boolean>`, which is why the line below returns it.
 */
export async function writeClipboard(text: string): Promise<boolean> {
  try {
    /*
      **Returned, not discarded.** `setStringAsync` answers whether the copy
      actually happened. `await …; return true` reads as correct and turns a
      `false` into a claimed copy — the exact "small lie nobody forgives" this
      file has warned about since it was a stub, and an invisible one: the
      dialog would close and say "Link copied" over an empty clipboard.
    */
    return await Clipboard.setStringAsync(text);
  } catch {
    // A throw is a refusal too. Reported, never faked — which is the whole
    // reason this function returns a boolean rather than nothing.
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
