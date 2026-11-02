/**
 * Time-based one-time codes (RFC 6238 over RFC 4226), for the staff console's
 * second factor (`functions/staffSecondFactor.ts`).
 *
 * The defaults every authenticator app shares: HMAC-SHA1, a 30-second step,
 * six digits. Pure functions over Web Crypto, so the tests drive them with
 * the RFC's own vectors.
 */

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Steps either side of now a code is still taken at: clock drift, not a longer life. */
export const TOTP_DRIFT_STEPS = 1;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Uint8Array {
  const clean = text.replace(/[\s=-]/g, "").toUpperCase();
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error("Not base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
}

/** The code for one step (RFC 4226 dynamic truncation). */
export async function totpCode(secret: Uint8Array, step: number): Promise<string> {
  const counter = new Uint8Array(8);
  let rest = step;
  for (let index = 7; index >= 0; index -= 1) {
    counter[index] = rest & 255;
    rest = Math.floor(rest / 256);
  }
  const key = await crypto.subtle.importKey("raw", secret as BufferSource, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter as BufferSource));
  const offset = mac[mac.length - 1]! & 15;
  const binary =
    ((mac[offset]! & 127) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

/**
 * The step a code matches, within the drift window, or null. Compares every
 * candidate rather than stopping at the first, so the time taken says nothing
 * about which step matched.
 */
export async function matchTotp(secret: Uint8Array, code: string, nowMs: number): Promise<number | null> {
  const typed = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(typed)) return null;
  const now = totpStep(nowMs);
  let matched: number | null = null;
  for (let delta = -TOTP_DRIFT_STEPS; delta <= TOTP_DRIFT_STEPS; delta += 1) {
    const expected = await totpCode(secret, now + delta);
    if (constantTimeEqual(expected, typed) && matched === null) matched = now + delta;
  }
  return matched;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}

/** What an authenticator app scans or is pasted: issuer and account label only. */
export function otpauthUri(secretBase32: string, account: string, issuer = "Context staff"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
