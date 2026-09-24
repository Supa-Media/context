/**
 * Which sealed columns the rekey sweep rotates, and which it deliberately
 * does not.
 *
 * Split out of `functions/storage.ts`, which keeps every registered storage
 * function; this module registers none and opens no credential.
 */

import { v } from "convex/values";
import type { Id } from "../../../_generated/dataModel";

// ---------------------------------------------------------------------------
// Key rotation.
//
// A key id in the envelope makes a rotation *survivable* — old rows still open
// while the new key is in use. These three make it *finishable*: without a
// re-encrypt pass, the outgoing key can never actually be retired, and "we
// rotated the key" means "we now have two keys to protect instead of one".
//
// The operator sequence is:
//   1. move the live key to STORAGE_SECRET_ENCRYPTION_KEY_PREVIOUS (+ _ID),
//   2. put the new key in STORAGE_SECRET_ENCRYPTION_KEY (+ a new _ID),
//   3. run `rekeyStorageBindings` until it reports nothing left,
//   4. unset the PREVIOUS variables.
//
// **The pass covers every envelope this control plane holds, not only the ones
// on a binding.** `workspaceDataKeys.encryptedDataKey` is sealed by the same
// scheme and carries the same key id, and it is the one envelope whose loss
// cannot be repaired by asking the owner for the credential again — it opens
// the encrypted notes in somebody's bucket, and nothing else does. A rotation
// that walked only `storageBindings` would report "nothing left" while those
// rows still sat under the outgoing key, and step 4 would then destroy them.
// `ROTATED_ENVELOPE_COLUMNS` below is coupled to the schema so a fifth
// encrypted column in any table fails a test rather than being remembered.
// ---------------------------------------------------------------------------

/** How many bindings one `rekeyStorageBindings` pass moves. */
export const REKEY_BATCH_SIZE = 50;

/**
 * Every field on a binding that holds an encrypted envelope.
 *
 * **A binding no longer has exactly one secret.** An S3 binding has the bucket
 * secret; a Dropbox binding has a refresh token and a cached access token, and
 * no bucket secret at all. Rotation walks this list rather than one hardcoded
 * field, because a rotation that silently skipped a field would leave those
 * envelopes readable only by a key the operator is about to delete — the
 * failure would not appear until the customer's next read, long after the
 * pass reported success.
 *
 * Adding a fourth encrypted field means adding it here. There is a test that
 * fails if a schema field matching `encrypted*` is missing from this list, so
 * the coupling is enforced rather than remembered.
 */
export const ENVELOPE_FIELDS = [
  "encryptedSecretAccessKey",
  "encryptedRefreshToken",
  "encryptedAccessToken",
] as const;

export type EnvelopeField = (typeof ENVELOPE_FIELDS)[number];

/**
 * Every encrypted column in the schema that a rotation pass moves forward.
 *
 * `ENVELOPE_FIELDS` is the `storageBindings` half; this is the whole set, and
 * it exists because the guard that used to enforce the coupling read only the
 * `storageBindings` slice of `schema.ts`. A credential in a *new table* was
 * therefore invisible to it — the same blindness that guard's own rationale
 * warns about one level down, where a hand-maintained list does not know about
 * the field nobody has thought about yet. `workspaceDataKeys.encryptedDataKey`
 * was exactly that field.
 */
export const ROTATED_ENVELOPE_COLUMNS = [
  ...ENVELOPE_FIELDS,
  "encryptedDataKey",
  "encryptedValue",
  "encryptedTargetSecretAccessKey",
  "encryptedApiKey",
] as const;

/**
 * Encrypted columns a rotation deliberately does **not** move, and why.
 *
 * An exemption has to be written down rather than left as a column nobody
 * listed, because those two states look identical from inside a passing test
 * suite and only one of them is a decision. The bar is not "small" or "not very
 * secret" — it is that losing the envelope costs nothing that cannot be
 * recreated by repeating an action the owner is already in the middle of.
 *
 *  - `cloudflareProvisioning.encryptedSetupCredential` — one in-flight bucket
 *    creation, alive for seconds, deleted in the transaction that writes the
 *    binding and cleared on failure. A rotation landing inside that window
 *    fails that one attempt, which the owner retries. There is nothing here to
 *    carry forward: by design the row is gone before a pass would reach it.
 *
 *  - `dropboxConnectAttempts.encryptedVerifier` and
 *    `googleConnectAttempts.encryptedVerifier` — one in-flight OAuth
 *    authorization each. The PKCE verifier is replayed to the provider at the
 *    exchange minutes later and the row is spent there; an unreadable one
 *    costs the person a second press of Connect. Two tables, one column name,
 *    one exemption — the guard below matches by name, and both rows carry
 *    the identical ten-minute-lived shape this paragraph argues for.
 */
export const ROTATION_EXEMPT_ENVELOPE_COLUMNS = [
  "encryptedSetupCredential",
  "encryptedVerifier",
] as const;

export const envelopeFieldValidator = v.union(
  v.literal("encryptedSecretAccessKey"),
  v.literal("encryptedRefreshToken"),
  v.literal("encryptedAccessToken"),
);

/**
 * Every field on a mail connection that holds an encrypted envelope.
 *
 * A mailbox connection has its own table (`googleConnections`, never a column
 * on `storageBindings` — different credential, different provider, different
 * lifecycle), so it needs its own candidate query the way
 * `workspaceDataKeys` does. **This is the exact miss `encryptedDataKey` was**:
 * a credential in a table `listRekeyCandidates` never queries is invisible to
 * a rotation pass no matter how completely `ENVELOPE_FIELDS` is enumerated,
 * because that list is read against `storageBindings` rows only. The
 * cross-table guard in `storage.test.ts` ("every encrypted column in the
 * whole schema is one rotation moves") catches the column *name* being
 * unaccounted for; it cannot catch a table the walk itself never visits — only
 * this function, actually wired into `rekeyStorageBindings`, does that.
 */
export const googleConnectionEnvelopeField = v.union(
  v.literal("encryptedRefreshToken"),
  v.literal("encryptedAccessToken"),
);
export type GoogleConnectionEnvelopeField =
  "encryptedRefreshToken" | "encryptedAccessToken";

/** Candidate envelopes on `providerCredentials`, one per row. */
export interface ProviderCredentialRekeyCandidates {
  candidates: {
    rowId: Id<"providerCredentials">;
    workspaceId: Id<"workspaces">;
    envelope: string;
  }[];
  unreadable: number;
}

/** Candidate envelopes on `googleConnections`, one per field. */
export interface GoogleConnectionRekeyCandidates {
  candidates: {
    connectionId: Id<"googleConnections">;
    workspaceId: Id<"workspaces">;
    field: GoogleConnectionEnvelopeField;
    envelope: string;
  }[];
  unreadable: number;
}
