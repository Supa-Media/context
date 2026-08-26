/**
 * Credential encryption for storage secrets.
 *
 * The customer pastes an S3 secret access key. That key can read and write
 * every note they own, so it is the single most valuable thing this control
 * plane holds — and the control plane holds nothing else of comparable value,
 * since note content lives in the customer's bucket. Encrypt it at rest, and
 * decrypt it only where it is used.
 *
 * Design notes:
 *  - **AES-256-GCM** via Web Crypto. Authenticated, so a tampered ciphertext
 *    fails to decrypt rather than yielding garbage a caller might send to a
 *    storage provider.
 *  - **A fresh 96-bit IV per record.** GCM catastrophically loses
 *    confidentiality on IV reuse under the same key, and rebinding storage
 *    re-encrypts the same-shaped value repeatedly, so the IV must never be
 *    derived from anything stable like the workspace id.
 *  - **One opaque envelope string**, `v1:<iv-b64>:<ciphertext-b64>`, rather
 *    than separate columns. It cannot be half-copied, half-migrated, or
 *    reassembled from the wrong row, and the `v1` prefix leaves room to rotate
 *    the algorithm without guessing at legacy rows.
 *  - **No Convex imports.** This is pure Web Crypto so it runs unchanged in
 *    the Workers gateway and is directly unit-testable.
 *
 * The key itself lives in a Convex environment variable and never in source,
 * in the customer's bucket, in logs, or on a device.
 */

/** Name of the Convex environment variable holding the base64 AES-256 key. */
export const ENCRYPTION_KEY_ENV_VAR = "STORAGE_SECRET_ENCRYPTION_KEY";

const ENVELOPE_VERSION = "v1";
const IV_BYTE_LENGTH = 12; // 96 bits, the GCM-recommended nonce size
const KEY_BYTE_LENGTH = 32; // AES-256

/** Thrown for any envelope/key problem. Message never contains key material. */
export class CredentialCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialCryptoError";
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new CredentialCryptoError("Envelope segment is not valid base64");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function importKey(keyBase64: string): Promise<CryptoKey> {
  const raw = fromBase64(keyBase64);
  if (raw.byteLength !== KEY_BYTE_LENGTH) {
    throw new CredentialCryptoError(
      `Encryption key must be ${KEY_BYTE_LENGTH} bytes (base64-encoded AES-256); got ${raw.byteLength}`,
    );
  }
  return await crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * Read the encryption key from the environment.
 *
 * Throws rather than falling back to a default. A silent fallback would mean a
 * misconfigured deployment writes "encrypted" secrets everyone can read, and
 * nobody would notice until it mattered.
 */
export function requireEncryptionKey(
  env: Record<string, string | undefined> = process.env,
): string {
  const key = env[ENCRYPTION_KEY_ENV_VAR];
  if (!key) {
    throw new CredentialCryptoError(
      `${ENCRYPTION_KEY_ENV_VAR} is not set. Storage credentials cannot be stored without it.`,
    );
  }
  return key;
}

/**
 * Generate a fresh base64 AES-256 key. For operator setup only — the output
 * goes into the Convex environment, never into this repository.
 */
export function generateEncryptionKey(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(KEY_BYTE_LENGTH)));
}

/**
 * Encrypt a plaintext secret into a storable envelope.
 *
 * Each call generates a new random IV, so encrypting the same plaintext twice
 * yields different ciphertext — an attacker with read access to the table
 * cannot tell that two workspaces pasted the same credential.
 */
export async function encryptSecret(
  plaintext: string,
  keyBase64: string,
): Promise<string> {
  if (plaintext.length === 0) {
    throw new CredentialCryptoError("Refusing to encrypt an empty secret");
  }
  const key = await importKey(keyBase64);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTE_LENGTH));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    new TextEncoder().encode(plaintext) as BufferSource,
  );
  return [
    ENVELOPE_VERSION,
    toBase64(iv),
    toBase64(new Uint8Array(ciphertext)),
  ].join(":");
}

/**
 * Decrypt an envelope back to the plaintext secret.
 *
 * Only ever call this from an internal function serving the gateway. If you
 * find yourself calling it from a `query` or `mutation` that a client can
 * reach, stop: that is a credential-disclosure endpoint.
 */
export async function decryptSecret(
  envelope: string,
  keyBase64: string,
): Promise<string> {
  const parts = envelope.split(":");
  if (parts.length !== 3) {
    throw new CredentialCryptoError("Malformed credential envelope");
  }
  const [version, ivBase64, ciphertextBase64] = parts;
  if (version !== ENVELOPE_VERSION) {
    throw new CredentialCryptoError(
      `Unsupported credential envelope version "${version}"`,
    );
  }
  const iv = fromBase64(ivBase64);
  if (iv.byteLength !== IV_BYTE_LENGTH) {
    throw new CredentialCryptoError("Credential envelope has a malformed IV");
  }
  const key = await importKey(keyBase64);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      fromBase64(ciphertextBase64) as BufferSource,
    );
  } catch {
    // GCM authentication failed: wrong key, or the ciphertext was tampered
    // with. Deliberately opaque — distinguishing the two would be an oracle.
    throw new CredentialCryptoError("Failed to decrypt credential");
  }
  return new TextDecoder().decode(plaintext);
}

/**
 * SHA-256, hex-encoded.
 *
 * Used for refresh tokens and client secrets, which we must be able to *match*
 * but never need to *read back*. Those are high-entropy random values, so a
 * plain digest is appropriate; this is not a password hash and must not be
 * used for one.
 */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token) as BufferSource,
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Mask an access key id for display.
 *
 * The access key id is not a secret on its own, but showing it in full in a
 * dashboard (and therefore in screenshots and support tickets) hands half a
 * credential to anyone reading over a shoulder.
 */
export function maskAccessKeyId(accessKeyId: string): string {
  if (accessKeyId.length <= 4) return "•".repeat(accessKeyId.length);
  return `${"•".repeat(Math.min(accessKeyId.length - 4, 12))}${accessKeyId.slice(-4)}`;
}
