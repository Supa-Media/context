/** Granola webhook limits, queue prefixes and signature verification. Moved verbatim out of `src/index.js`. */

import { decodeBase64, encodeBase64, timingSafeEqual } from "../crypto/bytes.js";
import { GRANOLA_EVENTS_PREFIX } from "../../../../packages/shared/src/storageLayout.cjs";

export const GRANOLA_PENDING_PREFIX = `${GRANOLA_EVENTS_PREFIX}pending/`;
export const GRANOLA_COMPLETED_PREFIX = `${GRANOLA_EVENTS_PREFIX}completed/`;
export const GRANOLA_WEBHOOK_BYTE_CAP = 100_000;
const GRANOLA_WEBHOOK_MAX_AGE_SECONDS = 5 * 60;

export async function verifyGranolaSignature(headers, rawBody, signingSecret) {
  if (!signingSecret.startsWith("whsec_")) return false;
  const webhookId = headers.get("webhook-id") || "";
  const timestampText = headers.get("webhook-timestamp") || "";
  const signatureHeader = headers.get("webhook-signature") || "";
  const timestamp = Number(timestampText);
  if (!webhookId || !Number.isFinite(timestamp)) return false;
  if (Math.abs(Date.now() / 1000 - timestamp) > GRANOLA_WEBHOOK_MAX_AGE_SECONDS) return false;

  let keyBytes;
  try {
    keyBytes = decodeBase64(signingSecret.slice("whsec_".length));
  } catch {
    return false;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signedContent = `${webhookId}.${timestampText}.${rawBody}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedContent))
  );
  const expected = encodeBase64(signature);
  return signatureHeader.split(/\s+/).some((candidate) => {
    const [version, provided = ""] = candidate.split(",");
    return version === "v1" && timingSafeEqual(provided, expected);
  });
}
