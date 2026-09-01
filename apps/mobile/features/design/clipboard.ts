/**
 * Clipboard — native.
 *
 * `expo-clipboard` is not a dependency (adding one is not free in this repo —
 * see CLAUDE.md on the native module graph), and web is the shipping surface.
 * Native reports failure honestly so the UI can leave the label alone rather
 * than claim "Copied" over a no-op.
 */
export async function writeClipboard(_text: string): Promise<boolean> {
  return false;
}

/**
 * The native half of `copyDeferred` — see the web file for what it is for.
 *
 * There is no user-activation window to preserve here and no clipboard to
 * write to, so this is the plain shape: run the round trip, report honestly
 * that nothing was copied. The text still comes back, because a caller that
 * cannot copy has something worth showing.
 */
export async function copyDeferred(
  produce: () => Promise<string | null>,
): Promise<{ ok: boolean; text: string | null }> {
  const value = await produce();
  if (value === null) return { ok: false, text: null };
  return { ok: await writeClipboard(value), text: value };
}
