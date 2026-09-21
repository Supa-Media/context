/**
 * Hand the device a file to keep — native.
 *
 * There is no `<a download>` here and no folder a phone app may simply write
 * into. The honest native shape is the share sheet — write the bytes to this
 * app's own cache, hand the path to the system, and let the person choose
 * Files, Mail or anything else — and it needs `expo-file-system` and
 * `expo-sharing`, which this build does not carry.
 *
 * So this answers `false`, which is the contract's own word for "this surface
 * cannot", and the caller says so in a sentence rather than drawing a control
 * that does nothing. **A capability the surface does not have is reported,
 * never faked** — the same rule `LiveEditor.tsx` and `menu.ts` already follow,
 * and the reason the file pair exists at all rather than a `Platform.OS`
 * branch: a lint rule in this repository requires both halves, precisely so
 * the native answer is written down rather than discovered.
 *
 * The console is a web surface today (`shareOrigin.ts` says the same thing
 * about the address bar). When a native console wants this, the work is the
 * two dependencies above and this function — not a change to anything that
 * calls it.
 */
export function saveFile(
  _name: string,
  _bytes: Uint8Array,
  _contentType: string,
): boolean {
  return false;
}
