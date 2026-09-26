/**
 * Bytes to something an `<img>` will take, on both platforms.
 *
 * The bytes arrive from a Convex action as an `ArrayBuffer` and have to become a
 * `src`. Two ways exist and only one of them works everywhere this app runs:
 *
 *  - `URL.createObjectURL(new Blob(…))` is the efficient one and is **web
 *    only**. React Native has no `URL.createObjectURL`, and the `WebView` guest
 *    cannot be handed a blob URL minted in the host's document anyway — a blob
 *    URL is scoped to the origin that created it.
 *  - a `data:` URL is bigger and works in every one of them, including inside
 *    the guest, which is the surface with no other way to be given bytes.
 *
 * So: a data URL, everywhere, and the base64 is written out rather than left to
 * `btoa`. `btoa` is on the web and on Hermes today and has been missing from a
 * React Native runtime within living memory; this is the one place a picture
 * would stop appearing on a platform upgrade, so it does not depend on it.
 *
 * Chunked because `String.fromCharCode(...bytes)` on a megabyte of image is a
 * spread of a million arguments, which throws `RangeError: Maximum call stack
 * size exceeded` — the same reason the gateway's own `base64FromBytes` chunks.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Standard base64, padded, of everything in `bytes`. */
export function base64FromBytes(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let out = "";
  for (let index = 0; index < view.length; index += 3) {
    const first = view[index];
    const second = view[index + 1];
    const third = view[index + 2];
    out += ALPHABET[first >> 2];
    out += ALPHABET[((first & 0x03) << 4) | ((second ?? 0) >> 4)];
    out += second === undefined ? "=" : ALPHABET[((second & 0x0f) << 2) | ((third ?? 0) >> 6)];
    out += third === undefined ? "=" : ALPHABET[third & 0x3f];
  }
  return out;
}

/**
 * The `src` for an image of this type.
 *
 * The content type comes from the store rather than from the file name, because
 * a picture served as `application/octet-stream` is a download and not an
 * image — which is why `readAttachment` answers with one.
 */
export function dataUrlFor(bytes: ArrayBuffer, contentType: string): string {
  return `data:${contentType};base64,${base64FromBytes(bytes)}`;
}

/**
 * Base64 back to bytes, without `atob`, and the inverse of `base64FromBytes`.
 *
 * `atob` is present on the web and on Hermes today and has been absent from a
 * React Native runtime within living memory, so the one place a paste would
 * break on a platform upgrade is written out instead. Throws on a character
 * outside the alphabet, which the caller turns into a sentence — a truncated
 * image is worth refusing rather than storing.
 *
 * It was in `webview/host.ts`, with the editor's guest-message handling, and it
 * moved here when a second caller appeared: the workspace-icon picker decodes
 * what `expo-image-picker` hands back. `host.ts` imports `EDITOR_BUNDLE`, the
 * whole committed editor build, so importing a four-line decoder from it would
 * have put that bundle in the settings panel's module graph. `host.ts`
 * re-exports this so its own callers are unchanged.
 */

export function bytesFromBase64(value: string): ArrayBuffer {
  const clean = value.replace(/=+$/, "");
  const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let byte = 0;
  let accumulator = 0;
  let bits = 0;
  for (const character of clean) {
    const index = ALPHABET.indexOf(character);
    if (index < 0) throw new Error("not base64");
    accumulator = (accumulator << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[byte] = (accumulator >> bits) & 0xff;
      byte += 1;
    }
  }
  return bytes.buffer;
}

/**
 * Is this embed target a remote image, to be drawn through the image proxy
 * (`readRemoteImage`) rather than read out of the workspace's own store?
 *
 * https only. A plain-http link is not proxied, and not drawn: the server would
 * refuse it anyway, and asking costs a round trip to learn that.
 */
export function isRemoteImageTarget(target: string): boolean {
  return /^https:\/\//i.test(target.trim());
}
