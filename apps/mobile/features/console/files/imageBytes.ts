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
