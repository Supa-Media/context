/**
 * A sheet source's key: its shape, how one is made, and how a request's
 * `Authorization` header becomes the hash it is looked up by.
 *
 * `ctxs_` and 32 random bytes, base64url. Only the SHA-256 is stored, and the
 * key travels in a header, never a URL. See `functions/sheetSources.ts`.
 */

import { hashToken } from "./crypto";

export const KEY_PREFIX = "ctxs_";
const KEY_BYTES = 32;
/** `ctxs_` and 43 base64url characters: anything else is refused before a lookup. */
export const KEY_PATTERN = /^ctxs_[A-Za-z0-9_-]{43}$/;

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A new key. Only its hash is ever stored. */
export function newSourceKey(): string {
  return `${KEY_PREFIX}${base64url(crypto.getRandomValues(new Uint8Array(KEY_BYTES)))}`;
}

/** The hash a request's `Authorization: Bearer ctxs_…` header is looked up by, or `null` for anything else. */
export async function sourceKeyHash(authorization: string | null): Promise<string | null> {
  const match = /^Bearer\s+(\S+)$/i.exec((authorization ?? "").trim());
  if (match === null || !KEY_PATTERN.test(match[1]!)) return null;
  return await hashToken(match[1]!);
}
