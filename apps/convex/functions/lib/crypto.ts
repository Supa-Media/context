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
 *  - **The workspace id is bound in as additional authenticated data.** An
 *    envelope decrypts in exactly one workspace's row and nowhere else. Without
 *    this, a row-level id-confusion bug anywhere upstream — a mis-scoped patch,
 *    a copied row, a future gateway passing the wrong id — turns into a
 *    cross-tenant credential handout; with it, the same bug is a decrypt
 *    failure. GCM's AAD is authenticated but not encrypted, which is exactly
 *    right here: the workspace id is not a secret, it is a binding.
 *  - **A key id in the envelope.** `v1` was an *algorithm* version, which meant
 *    the deployment had exactly one key forever: rotating
 *    `STORAGE_SECRET_ENCRYPTION_KEY` made every stored binding permanently
 *    undecryptable, so the answer to "the key leaked" was "every customer
 *    re-pastes their secret". A key id lets reads try the key the envelope was
 *    written with while writes always use the current one.
 *  - **One opaque envelope string**, `v2:<key-id>:<iv-b64>:<ciphertext-b64>`,
 *    rather than separate columns. It cannot be half-copied, half-migrated, or
 *    reassembled from the wrong row.
 *  - **No Convex imports.** This is pure Web Crypto so it runs unchanged in
 *    the Workers gateway and is directly unit-testable.
 *
 * ## The v1 → v2 break
 *
 * `v1` envelopes (no key id, no AAD) are **rejected, not migrated**. There is
 * no silent read path for them, because supporting one would mean keeping a
 * decrypt that is not bound to a workspace — which is the whole vulnerability
 * v2 exists to close, and an attacker who could write a row could simply
 * downgrade the envelope to v1 to get it back. A deployment holding v1 rows
 * asks its owners to rebind storage; the failure is loud, the credential is
 * re-pasted once, and the customer's bucket is untouched throughout. See
 * `decryptSecret` for the error a v1 row produces.
 *
 * Keys live in Convex environment variables and never in source, in the
 * customer's bucket, in logs, or on a device.
 */

/** Name of the Convex environment variable holding the base64 AES-256 key. */
export const ENCRYPTION_KEY_ENV_VAR = "STORAGE_SECRET_ENCRYPTION_KEY";

/**
 * Identifier for the key in `STORAGE_SECRET_ENCRYPTION_KEY`. Written into every
 * envelope so a later deployment can tell which key opened it.
 */
export const ENCRYPTION_KEY_ID_ENV_VAR = "STORAGE_SECRET_ENCRYPTION_KEY_ID";

/**
 * The key being rotated *out*, and its id. Optional. When set, envelopes
 * written under it still decrypt while `rekeyStorageBindings` moves them
 * forward; unset it once nothing is left on the old key.
 */
export const PREVIOUS_ENCRYPTION_KEY_ENV_VAR =
  "STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS";
export const PREVIOUS_ENCRYPTION_KEY_ID_ENV_VAR =
  "STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS_ID";

/**
 * The id assumed when `STORAGE_SECRET_ENCRYPTION_KEY_ID` is unset.
 *
 * Rotation is opt-in configuration, so a deployment that has never rotated
 * should not have to set a second variable to keep working. The first rotation
 * sets both ids explicitly.
 */
export const DEFAULT_KEY_ID = "k1";

const ENVELOPE_VERSION = "v2";
const IV_BYTE_LENGTH = 12; // 96 bits, the GCM-recommended nonce size
const KEY_BYTE_LENGTH = 32; // AES-256

/**
 * Key ids appear inside a `:`-delimited envelope, so they may not contain `:`.
 * Kept to an unambiguous charset rather than merely excluding the delimiter —
 * a key id is operator-chosen configuration, not user input, and there is no
 * reason for it to be exotic.
 */
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/** Thrown for any envelope/key problem. Message never contains key material. */
export class CredentialCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialCryptoError";
  }
}

/** One AES-256 key and the id recorded in the envelopes it produces. */
export interface EncryptionKey {
  id: string;
  /** Base64 AES-256 key material. Never logged, never returned to a client. */
  material: string;
}

/**
 * The keys a deployment can read with, and the one it writes with.
 *
 * Reads accept `current` or `previous`; writes only ever use `current`. That
 * asymmetry is what makes a rotation finishable: flip the variables, and every
 * subsequent write is on the new key while old rows keep opening until the
 * re-encrypt pass has moved them.
 */
export interface Keyset {
  current: EncryptionKey;
  previous?: EncryptionKey;
}

/**
 * What an envelope is bound to.
 *
 * A workspace id today. It is a named object rather than a bare string so that
 * adding another binding dimension later is a compile error at every call site
 * instead of a silently mismatched positional argument.
 */
export interface CredentialContext {
  workspaceId: string;
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

function assertKeyId(id: string, envVar: string): string {
  if (!KEY_ID_PATTERN.test(id)) {
    throw new CredentialCryptoError(
      `${envVar} must match ${KEY_ID_PATTERN.source}`,
    );
  }
  return id;
}

/**
 * The bytes GCM authenticates alongside the ciphertext.
 *
 * Version and key id are included as well as the workspace: an attacker who
 * can write the row must not be able to relabel an envelope (claim it was
 * written under a different key, or under a different envelope version) and
 * have it still authenticate.
 */
function additionalData(keyId: string, context: CredentialContext): Uint8Array {
  if (context.workspaceId.length === 0) {
    throw new CredentialCryptoError(
      "A credential envelope must be bound to a workspace id",
    );
  }
  return new TextEncoder().encode(
    `${ENVELOPE_VERSION}:${keyId}:workspace:${context.workspaceId}`,
  );
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
 * Read the whole keyset — the key to write with, plus the key being rotated out.
 *
 * A previous key without an id, or a previous id equal to the current one, is
 * refused rather than guessed at: both are the shape of a half-finished
 * rotation, and guessing would either silently write under the wrong id or
 * silently make old rows unreadable.
 */
export function requireKeyset(
  env: Record<string, string | undefined> = process.env,
): Keyset {
  const current: EncryptionKey = {
    id: assertKeyId(
      env[ENCRYPTION_KEY_ID_ENV_VAR] ?? DEFAULT_KEY_ID,
      ENCRYPTION_KEY_ID_ENV_VAR,
    ),
    material: requireEncryptionKey(env),
  };

  const previousMaterial = env[PREVIOUS_ENCRYPTION_KEY_ENV_VAR];
  if (!previousMaterial) return { current };

  const previousId = env[PREVIOUS_ENCRYPTION_KEY_ID_ENV_VAR];
  if (!previousId) {
    throw new CredentialCryptoError(
      `${PREVIOUS_ENCRYPTION_KEY_ENV_VAR} is set but ${PREVIOUS_ENCRYPTION_KEY_ID_ENV_VAR} is not. A key without an id cannot be matched to an envelope.`,
    );
  }
  assertKeyId(previousId, PREVIOUS_ENCRYPTION_KEY_ID_ENV_VAR);
  if (previousId === current.id) {
    throw new CredentialCryptoError(
      `${PREVIOUS_ENCRYPTION_KEY_ID_ENV_VAR} must differ from ${ENCRYPTION_KEY_ID_ENV_VAR}; two different keys cannot share one id.`,
    );
  }

  return { current, previous: { id: previousId, material: previousMaterial } };
}

/**
 * Generate a fresh base64 AES-256 key. For operator setup only — the output
 * goes into the Convex environment, never into this repository.
 */
export function generateEncryptionKey(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(KEY_BYTE_LENGTH)));
}

/**
 * The key id an envelope was written under, without decrypting it.
 *
 * The re-encrypt pass uses this to find rows still on the outgoing key. It
 * parses only — a well-formed prefix proves nothing about the ciphertext.
 */
export function envelopeKeyId(envelope: string): string {
  const parts = envelope.split(":");
  if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) {
    throw new CredentialCryptoError("Malformed credential envelope");
  }
  return parts[1];
}

/**
 * Encrypt a plaintext secret into a storable envelope, bound to one workspace.
 *
 * Each call generates a new random IV, so encrypting the same plaintext twice
 * yields different ciphertext — an attacker with read access to the table
 * cannot tell that two workspaces pasted the same credential.
 */
export async function encryptSecret(
  plaintext: string,
  keyset: Keyset,
  context: CredentialContext,
): Promise<string> {
  if (plaintext.length === 0) {
    throw new CredentialCryptoError("Refusing to encrypt an empty secret");
  }
  const { id, material } = keyset.current;
  const key = await importKey(material);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTE_LENGTH));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: iv as BufferSource,
      additionalData: additionalData(id, context) as BufferSource,
    },
    key,
    new TextEncoder().encode(plaintext) as BufferSource,
  );
  return [
    ENVELOPE_VERSION,
    id,
    toBase64(iv),
    toBase64(new Uint8Array(ciphertext)),
  ].join(":");
}

/**
 * Decrypt an envelope back to the plaintext secret.
 *
 * Only ever call this from an internal function serving the gateway. If you
 * find yourself calling it from a `query` or `mutation` that a client can
 * reach, stop: that is a credential-disclosure endpoint. `__tests__/structure.test.ts`
 * enforces that structurally.
 *
 * `context` must be the workspace the envelope was read out of. Passing the
 * wrong one fails authentication rather than returning someone else's
 * credential — that is the entire point of the AAD.
 */
export async function decryptSecret(
  envelope: string,
  keyset: Keyset,
  context: CredentialContext,
): Promise<string> {
  const parts = envelope.split(":");
  if (parts[0] === "v1") {
    // Deliberately actionable rather than opaque: this is an operator-facing
    // configuration state, not an attacker-facing oracle. A v1 envelope has no
    // workspace binding, so opening one would reintroduce the cross-tenant
    // decrypt that v2 exists to prevent.
    throw new CredentialCryptoError(
      "This credential was stored in the unbound v1 envelope format and cannot be opened. The workspace owner must rebind storage.",
    );
  }
  if (parts.length !== 4) {
    throw new CredentialCryptoError("Malformed credential envelope");
  }
  const [version, keyId, ivBase64, ciphertextBase64] = parts;
  if (version !== ENVELOPE_VERSION) {
    throw new CredentialCryptoError(
      `Unsupported credential envelope version "${version}"`,
    );
  }

  const key =
    keyset.current.id === keyId
      ? keyset.current
      : keyset.previous?.id === keyId
        ? keyset.previous
        : undefined;
  if (key === undefined) {
    throw new CredentialCryptoError(
      `No configured encryption key with id "${keyId}"`,
    );
  }

  const iv = fromBase64(ivBase64);
  if (iv.byteLength !== IV_BYTE_LENGTH) {
    throw new CredentialCryptoError("Credential envelope has a malformed IV");
  }
  const imported = await importKey(key.material);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: iv as BufferSource,
        additionalData: additionalData(keyId, context) as BufferSource,
      },
      imported,
      fromBase64(ciphertextBase64) as BufferSource,
    );
  } catch {
    // GCM authentication failed: wrong key, wrong workspace, or the ciphertext
    // was tampered with. Deliberately opaque — distinguishing them would be an
    // oracle.
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

/** The shape `hashToken` produces. Anything else is not a token hash. */
export const TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/;

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
