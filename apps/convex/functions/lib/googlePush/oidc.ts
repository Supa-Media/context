/**
 * Proving a Pub/Sub push came from our own subscription.
 *
 * An authenticated push subscription sends `Authorization: Bearer <JWT>`, an
 * OIDC ID token Google signs (RS256) on behalf of the service account the
 * subscription was configured with, for the audience it was configured with.
 * A delivery is accepted only when all of these hold:
 *
 *  - the signature verifies against one of Google's published keys, chosen by
 *    the token's `kid`, with the algorithm pinned to RS256 (never read from
 *    the token and trusted);
 *  - `iss` is Google, `aud` is exactly this deployment's audience, and the
 *    token is inside its lifetime;
 *  - `email` is exactly our push service account and Google says it is
 *    verified.
 *
 * The audience is what stops a token minted for somebody else's endpoint
 * being replayed here, and the email is what stops anybody else's
 * subscription, signed by Google just the same, from pushing to this one. Any
 * Google account can get Google to sign a token; only ours names our account.
 *
 * What a forged delivery could do even if it got through is small — it only
 * makes a connection due sooner, the pass re-reads everything from Google
 * itself, and nothing in the notification is written anywhere — but an
 * unauthenticated poke is still a way to make us spend somebody's Google
 * quota on a loop, so it is refused at the door.
 */

export const GOOGLE_CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
/** Clock skew tolerated either side of `iat` and `exp`. */
const SKEW_SECONDS = 60;
/** How long fetched keys are trusted when Google sends no `max-age`. */
const DEFAULT_KEY_TTL_MS = 60 * 60 * 1000;

type Jwk = { kid?: string; kty?: string; n?: string; e?: string; alg?: string };

let cachedKeys: { keys: Map<string, Jwk>; expiresAt: number } | null = null;

/** Test seam: forget fetched keys. */
export function resetGoogleCertCache(): void {
  cachedKeys = null;
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function decodeJson(segment: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment)));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function googleKeys(
  fetchImpl: typeof fetch,
  now: number,
  forceRefresh: boolean,
): Promise<Map<string, Jwk>> {
  if (!forceRefresh && cachedKeys !== null && cachedKeys.expiresAt > now) return cachedKeys.keys;
  const response = await fetchImpl(GOOGLE_CERTS_URL);
  if (!response.ok) throw new Error(`Google certs answered ${response.status}`);
  const body = (await response.json()) as { keys?: Jwk[] };
  const keys = new Map<string, Jwk>();
  for (const key of body.keys ?? []) {
    if (typeof key.kid === "string" && key.kty === "RSA") keys.set(key.kid, key);
  }
  const maxAge = /max-age=(\d+)/.exec(response.headers.get("cache-control") ?? "");
  const ttl = maxAge ? Number(maxAge[1]) * 1000 : DEFAULT_KEY_TTL_MS;
  cachedKeys = { keys, expiresAt: now + Math.min(ttl, 24 * DEFAULT_KEY_TTL_MS) };
  return keys;
}

/**
 * True only for a Google-signed ID token for `audience`, issued to
 * `serviceAccount`. Never throws: every failure, including Google's key
 * endpoint being down, is a refusal, and Pub/Sub retries a refused push.
 */
export async function pubsubTokenIsValid(input: {
  authorization: string | null;
  audience: string;
  serviceAccount: string;
  fetchImpl?: typeof fetch;
  now?: number;
}): Promise<boolean> {
  try {
    const match = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(
      input.authorization?.trim() ?? "",
    );
    if (match === null) return false;
    const [, headerPart, payloadPart, signaturePart] = match as unknown as [string, string, string, string];
    const header = decodeJson(headerPart);
    const claims = decodeJson(payloadPart);
    if (header === null || claims === null) return false;
    // The algorithm is ours to choose. Reading it from the token is how
    // `alg: none` and HS256-with-the-public-key attacks get in.
    if (header.alg !== "RS256" || typeof header.kid !== "string") return false;

    const now = input.now ?? Date.now();
    const seconds = Math.floor(now / 1000);
    if (typeof claims.iss !== "string" || !ISSUERS.has(claims.iss)) return false;
    if (claims.aud !== input.audience) return false;
    if (typeof claims.exp !== "number" || claims.exp + SKEW_SECONDS < seconds) return false;
    if (typeof claims.iat !== "number" || claims.iat - SKEW_SECONDS > seconds) return false;
    if (claims.email_verified !== true) return false;
    if (typeof claims.email !== "string" || claims.email.toLowerCase() !== input.serviceAccount) {
      return false;
    }

    const fetchImpl = input.fetchImpl ?? globalThis.fetch;
    let jwk = (await googleKeys(fetchImpl, now, false)).get(header.kid);
    // Google rotates keys; an unknown `kid` is worth exactly one refetch.
    if (jwk === undefined) jwk = (await googleKeys(fetchImpl, now, true)).get(header.kid);
    if (jwk === undefined || typeof jwk.n !== "string" || typeof jwk.e !== "string") return false;

    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      base64UrlToBytes(signaturePart),
      new TextEncoder().encode(`${headerPart}.${payloadPart}`),
    );
  } catch {
    return false;
  }
}
