/**
 * A phone as a person object keys it (`docs/decisions/texting-assistant/texting-in-objects.md`): HMAC-SHA256 under
 * HKDF-Expand(gateway secret, "context texting phone v1"), lowercase hex, so no object holds the number. Pure, so the
 * control plane, which holds the same secret, imports it to write the record (`apps/convex/functions/textingObjects.ts`).
 */

export const PHONE = /^\+[1-9][0-9]{6,14}$/;
const PHONE_KEY_INFO = new TextEncoder().encode("context texting phone v1");

/** `null` without a secret, or for anything but an E.164 number. */
export async function textingPhoneHash(secret, phone) {
  if (typeof secret !== "string" || secret.length < 16) return null;
  if (typeof phone !== "string" || !PHONE.test(phone)) return null;
  const encoder = new TextEncoder();
  const root = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const block = new Uint8Array(PHONE_KEY_INFO.length + 1);
  block.set(PHONE_KEY_INFO);
  block[PHONE_KEY_INFO.length] = 1;
  const derived = new Uint8Array(await crypto.subtle.sign("HMAC", root, block));
  const key = await crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(phone)));
  return Array.from(mac, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
