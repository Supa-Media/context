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
