/**
 * Linq signs every webhook the Standard Webhooks way:
 *
 *     webhook-signature: v1,<base64 HMAC-SHA256(key, "<id>.<timestamp>.<raw body>")>
 *
 * where the key is the subscription's `whsec_…` signing secret, base64-decoded.
 * This is the only thing standing between the public internet and a message
 * that the agent answers with somebody's own grant, so every malformed input is
 * a plain `false` and nothing here throws.
 *
 * The id is part of the signed string, so a captured signature cannot be
 * replayed under a fresh id; the conversation dedupes on the id, so it cannot
 * be replayed under the same one either. The timestamp bounds how long a
 * captured request stays usable at all.
 */

/** Standard Webhooks' recommended tolerance, and Linq's documented one. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

function decodeBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** Constant-time over the expected length; a length mismatch is just false. */
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function verifyLinqSignature(
  secret: string,
  headers: Headers,
  rawBody: string,
  nowSeconds: number,
): Promise<boolean> {
  const key = secret.startsWith("whsec_") ? decodeBase64(secret.slice(6)) : null;
  if (!key || key.length === 0) return false;

  const id = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp");
  const signatures = headers.get("webhook-signature");
  if (!id || !timestamp || !signatures) return false;
  if (!/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > SIGNATURE_TOLERANCE_SECONDS) return false;

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      cryptoKey,
      new TextEncoder().encode(`${id}.${timestamp}.${rawBody}`),
    ),
  );

  for (const candidate of signatures.split(" ")) {
    const [version, value] = candidate.split(",", 2);
    if (version !== "v1" || !value) continue;
    const bytes = decodeBase64(value);
    if (bytes && equalBytes(bytes, expected)) return true;
  }
  return false;
}
