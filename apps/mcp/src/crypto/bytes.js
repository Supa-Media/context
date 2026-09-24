/**
 * Base64 codecs and a constant-time comparison, shared by the Granola webhook
 * signature check and the key-rotation progress MAC. Moved verbatim out of
 * `src/index.js`.
 */

/**
 * Constant-time string comparison, for the webhook HMAC above.
 *
 * The only remaining secret comparison in this worker. Access tokens are not
 * compared here at all — they are hashed and resolved by the control plane —
 * which is why this lives beside its one caller instead of in a shared auth
 * section that no longer exists.
 */
export function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const enc = new TextEncoder();
  const ba = enc.encode(a);
  const bb = enc.encode(b);
  if (ba.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i];
  return diff === 0;
}

export function decodeBase64(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function encodeBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
