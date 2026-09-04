/**
 * Naming and fingerprinting rules for the platform's integration credentials.
 *
 * Pure functions, no database, no Convex imports — so the rules are unit
 * testable on their own and the mutation that applies them stays short enough
 * to read in one go.
 */

import { CredentialCryptoError } from "./crypto";

/**
 * Names that may never be stored in the database.
 *
 * ## The bootstrapping floor
 *
 * `STORAGE_SECRET_ENCRYPTION_KEY` is the key every row in `appSecrets` is
 * sealed with. A row holding it is a safe with its own combination inside, and
 * worse, it is a *plausible-looking* one: the console would accept the paste,
 * show a fingerprint, and report success, while the value is either
 * unrecoverable (sealed under itself) or, if someone "fixed" that by storing
 * it in the clear, the single most damaging plaintext this control plane could
 * hold.
 *
 * `GATEWAY_SECRET` is what proves a caller is the gateway. It has to be
 * checkable before any database content is trusted, so it cannot be a database
 * read. Its rotation key follows it for the same reason.
 *
 * The auth signing key and the deployment key are here on the same principle:
 * anything required to authenticate the request that would read this table
 * cannot live in this table.
 *
 * This is a refusal and not a warning. A warning is advice; somebody in a
 * hurry, or an agent following an instruction, takes the path that appears to
 * work. See CLAUDE.md: never weaken a boundary to move faster.
 */
export const RESERVED_SECRET_NAMES: ReadonlySet<string> = new Set([
  "STORAGE_SECRET_ENCRYPTION_KEY",
  "STORAGE_SECRET_ENCRYPTION_KEY_ID",
  "STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS",
  "STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS_ID",
  "GATEWAY_SECRET",
  "GATEWAY_SECRET_PREVIOUS",
  "JWT_PRIVATE_KEY",
  "JWKS",
  "CONVEX_DEPLOY_KEY",
  "ADMIN_EMAILS",
]);

/** `SEARCH_D1_API_TOKEN` — uppercase, digits, underscore; starts with a letter. */
export const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;

export const MAX_SECRET_VALUE_LENGTH = 8_192;
export const MAX_SECRET_DESCRIPTION_LENGTH = 200;

export class AppSecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppSecretError";
  }
}

/**
 * Validate and normalize a secret's name.
 *
 * Normalization is uppercasing and trimming only — deliberately not a
 * transliteration or a slugify. A name that needs rewriting to become legal is
 * rejected and shown to the operator, because a console that silently stores
 * `stripe-key` as `STRIPE_KEY` is a console where the thing you set and the
 * thing the code reads are two different names and nobody can see why the
 * integration is not working.
 */
export function normalizeSecretName(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new AppSecretError("A secret name is required.");
  }
  const name = raw.trim().toUpperCase();
  if (!SECRET_NAME_PATTERN.test(name)) {
    throw new AppSecretError(
      "A secret name must be 3-64 characters of A-Z, 0-9 and underscore, starting with a letter.",
    );
  }
  if (RESERVED_SECRET_NAMES.has(name)) {
    throw new AppSecretError(
      `${name} is held in the deployment environment and cannot be stored here. It is needed before this table can be read.`,
    );
  }
  return name;
}

/** Reject a value that is empty, oversized, or carrying stray whitespace. */
export function normalizeSecretValue(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new AppSecretError("A secret value is required.");
  }
  // Trimmed because a token pasted out of a terminal or an email very often
  // arrives with a trailing newline, and a credential that fails to
  // authenticate for an invisible reason costs an afternoon.
  const value = raw.trim();
  if (value.length === 0) {
    throw new AppSecretError("A secret value cannot be empty.");
  }
  if (value.length > MAX_SECRET_VALUE_LENGTH) {
    throw new AppSecretError(
      `A secret value cannot exceed ${MAX_SECRET_VALUE_LENGTH} characters.`,
    );
  }
  return value;
}

export function normalizeSecretDescription(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") {
    throw new AppSecretError("A description must be text.");
  }
  const description = raw.trim();
  if (description.length === 0) return undefined;
  if (description.length > MAX_SECRET_DESCRIPTION_LENGTH) {
    throw new AppSecretError(
      `A description cannot exceed ${MAX_SECRET_DESCRIPTION_LENGTH} characters.`,
    );
  }
  return description;
}

/** Hex characters of SHA-256 shown to an operator. */
export const FINGERPRINT_LENGTH = 8;

/**
 * A short, non-reversible fingerprint of a secret's value.
 *
 * Its whole job is to answer "is the value in here the value I meant to put
 * in here" without being the value. So it is a hash rather than a prefix or a
 * last-four: a fragment of a credential is a fragment of a credential, and it
 * would end up in the same screenshots and log lines this is safe to appear
 * in.
 *
 * Eight hex characters is 32 bits. That is not a collision-resistant identity
 * and is not used as one — rows are keyed by name — it is a human check
 * against a value the operator can re-hash if they doubt it.
 *
 * Truncating a hash does not make the input recoverable, but a *low-entropy*
 * input is guessable by hashing candidates whatever the length, so this is
 * only ever computed over credentials. It is never offered as a general
 * "fingerprint this" helper.
 */
export async function fingerprintSecret(value: string): Promise<string> {
  if (typeof value !== "string" || value.length === 0) {
    throw new CredentialCryptoError("Refusing to fingerprint an empty secret");
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value) as BufferSource,
  );
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex.slice(0, FINGERPRINT_LENGTH);
}
