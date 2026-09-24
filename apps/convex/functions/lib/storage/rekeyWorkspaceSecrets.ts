/**
 * The rekey sweep's reads and conditional writes for secrets sealed to one
 * workspace: storage bindings, data keys, provider credentials and Google
 * connections. The decrypt and re-seal between them stays in
 * `rekeyStorageBindings`.
 *
 * Split out of `functions/storage.ts`, which keeps every registered storage
 * function and wires these handlers to them; this module registers none and opens no credential.
 */

import { v } from "convex/values";
import type { ObjectType } from "convex/values";
import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import { recordAudit } from "../audit";
import { envelopeKeyId } from "../crypto";
import {
  ENVELOPE_FIELDS,
  envelopeFieldValidator,
  googleConnectionEnvelopeField,
} from "./rekeyColumns";

export const listRekeyCandidatesArgs = { currentKeyId: v.string(), limit: v.number() };

export const listRekeyCandidatesReturns = v.object({
  candidates: v.array(
    v.object({
      bindingId: v.id("storageBindings"),
      workspaceId: v.id("workspaces"),
      field: envelopeFieldValidator,
      envelope: v.string(),
    }),
  ),
  /** Rows in a format no configured key can open — v1, or corrupt. */
  unreadable: v.number(),
});

/** Envelopes written under some other key id, one row per envelope. */
export async function listRekeyCandidatesHandler(
  ctx: QueryCtx,
  args: ObjectType<typeof listRekeyCandidatesArgs>,
) {
  const bindings = await ctx.db.query("storageBindings").take(args.limit);
  const candidates = [];
  let unreadable = 0;
  for (const binding of bindings) {
    for (const field of ENVELOPE_FIELDS) {
      const envelope = binding[field];
      // Absent is normal now, not a defect: a Dropbox binding has no bucket
      // secret and an S3 one has no tokens. Only a *present* envelope that
      // cannot be read is unreadable.
      if (typeof envelope !== "string" || envelope.length === 0) continue;
      let keyId: string;
      try {
        keyId = envelopeKeyId(envelope);
      } catch {
        unreadable += 1;
        continue;
      }
      if (keyId === args.currentKeyId) continue;
      candidates.push({
        bindingId: binding._id,
        workspaceId: binding.workspaceId,
        field,
        envelope,
      });
    }
  }
  return { candidates, unreadable };
}

export const applyRekeyArgs = {
  bindingId: v.id("storageBindings"),
  field: envelopeFieldValidator,
  expectedEnvelope: v.string(),
  envelope: v.string(),
};

export const applyRekeyReturns = v.boolean();

/**
 * Swap one envelope for an equivalent one under the current key.
 *
 * Conditional on the envelope we read: if the owner rebound storage while the
 * pass was running, the row already holds a *newer* credential under the
 * current key, and overwriting it with a re-encryption of the old one would
 * quietly restore a credential the customer just replaced.
 */
export async function applyRekeyHandler(
  ctx: MutationCtx,
  args: ObjectType<typeof applyRekeyArgs>,
) {
  const binding = await ctx.db.get(args.bindingId);
  if (binding === null) return false;
  // Still conditional, and now per field: a Dropbox binding whose access
  // token was refreshed mid-pass must not have the stale one restored.
  if (binding[args.field] !== args.expectedEnvelope) return false;

  await ctx.db.patch(args.bindingId, {
    [args.field]: args.envelope,
    updatedAt: Date.now(),
  });
  // No actor: this is a maintenance pass, not a person. The credential and
  // the bucket are unchanged; only the key protecting it moved.
  await recordAudit(ctx, {
    workspaceId: binding.workspaceId,
    action: "storage.rekeyed",
  });
  return true;
}

export const listDataKeyRekeyCandidatesArgs = { currentKeyId: v.string(), limit: v.number() };

export const listDataKeyRekeyCandidatesReturns = v.object({
  candidates: v.array(
    v.object({
      rowId: v.id("workspaceDataKeys"),
      workspaceId: v.id("workspaces"),
      envelope: v.string(),
    }),
  ),
  unreadable: v.number(),
});

/**
 * Workspace data keys still on an older envelope key, one row per envelope.
 *
 * Its own query rather than a second shape inside `listRekeyCandidates`,
 * because the two write to different tables and a union of row ids in one
 * validator is a way to patch the wrong one.
 */
export async function listDataKeyRekeyCandidatesHandler(
  ctx: QueryCtx,
  args: ObjectType<typeof listDataKeyRekeyCandidatesArgs>,
) {
  const rows = await ctx.db.query("workspaceDataKeys").take(args.limit);
  const candidates = [];
  let unreadable = 0;
  for (const row of rows) {
    const envelope = row.encryptedDataKey;
    if (typeof envelope !== "string" || envelope.length === 0) {
      unreadable += 1;
      continue;
    }
    let keyId: string;
    try {
      keyId = envelopeKeyId(envelope);
    } catch {
      unreadable += 1;
      continue;
    }
    if (keyId === args.currentKeyId) continue;
    candidates.push({
      rowId: row._id,
      workspaceId: row.workspaceId,
      envelope,
    });
  }
  return { candidates, unreadable };
}

export const applyDataKeyRekeyArgs = {
  rowId: v.id("workspaceDataKeys"),
  expectedEnvelope: v.string(),
  envelope: v.string(),
};

export const applyDataKeyRekeyReturns = v.boolean();

/**
 * Re-seal one workspace data key under the current envelope key.
 *
 * **This is not an update path for the key.** The material is identical on both
 * sides — only the envelope around it moves — and the write is conditional on
 * the exact bytes the pass read, so a row that changed underneath it is skipped
 * rather than overwritten. A path that could write *different* material is the
 * one this feature may never have: it would make every note already encrypted
 * under the old material unreadable, and it would look like a fix.
 */
export async function applyDataKeyRekeyHandler(
  ctx: MutationCtx,
  args: ObjectType<typeof applyDataKeyRekeyArgs>,
) {
  const row = await ctx.db.get(args.rowId);
  if (row === null) return false;
  if (row.encryptedDataKey !== args.expectedEnvelope) return false;
  await ctx.db.patch(args.rowId, { encryptedDataKey: args.envelope });
  await recordAudit(ctx, {
    workspaceId: row.workspaceId,
    action: "encryption.rekeyed",
  });
  return true;
}

export const listProviderCredentialRekeyCandidatesArgs = { currentKeyId: v.string(), limit: v.number() };

export const listProviderCredentialRekeyCandidatesReturns = v.object({
  candidates: v.array(
    v.object({
      rowId: v.id("providerCredentials"),
      workspaceId: v.id("workspaces"),
      envelope: v.string(),
    }),
  ),
  unreadable: v.number(),
});

/**
 * Candidate envelopes on `providerCredentials`, the agent's model account.
 *
 * A fourth table and therefore a fourth walk, for the reason the mail
 * connection's own header gives one paragraph down: the cross-schema guard
 * catches an unaccounted column *name*, and cannot catch a table this pass
 * never visits. `providerCredentials` is not exempt — losing the envelope
 * means the customer re-pastes an API key from somebody else's console, which
 * is not "an action the owner is already in the middle of" — so it moves
 * forward with everything else.
 */
export async function listProviderCredentialRekeyCandidatesHandler(
  ctx: QueryCtx,
  args: ObjectType<typeof listProviderCredentialRekeyCandidatesArgs>,
) {
  const rows = await ctx.db.query("providerCredentials").take(args.limit);
  const candidates = [];
  let unreadable = 0;
  for (const row of rows) {
    const envelope = row.encryptedApiKey;
    if (typeof envelope !== "string" || envelope.length === 0) {
      unreadable += 1;
      continue;
    }
    let keyId: string;
    try {
      keyId = envelopeKeyId(envelope);
    } catch {
      unreadable += 1;
      continue;
    }
    if (keyId === args.currentKeyId) continue;
    candidates.push({ rowId: row._id, workspaceId: row.workspaceId, envelope });
  }
  return { candidates, unreadable };
}

export const applyProviderCredentialRekeyArgs = {
  rowId: v.id("providerCredentials"),
  expectedEnvelope: v.string(),
  envelope: v.string(),
};

export const applyProviderCredentialRekeyReturns = v.boolean();

/**
 * Re-seal one provider key under the current envelope key.
 *
 * Conditional on the bytes the pass read, like every other apply here: a
 * customer who reconnected a provider mid-pass holds a *newer* key under the
 * current generation, and restoring a re-encryption of the old one would
 * quietly put back a credential they had just replaced.
 */
export async function applyProviderCredentialRekeyHandler(
  ctx: MutationCtx,
  args: ObjectType<typeof applyProviderCredentialRekeyArgs>,
) {
  const row = await ctx.db.get(args.rowId);
  if (row === null) return false;
  if (row.encryptedApiKey !== args.expectedEnvelope) return false;
  await ctx.db.patch(args.rowId, { encryptedApiKey: args.envelope });
  await recordAudit(ctx, {
    workspaceId: row.workspaceId,
    action: "encryption.rekeyed",
  });
  return true;
}

export const listGoogleConnectionRekeyCandidatesArgs = { currentKeyId: v.string(), limit: v.number() };

export const listGoogleConnectionRekeyCandidatesReturns = v.object({
  candidates: v.array(
    v.object({
      connectionId: v.id("googleConnections"),
      workspaceId: v.id("workspaces"),
      field: googleConnectionEnvelopeField,
      envelope: v.string(),
    }),
  ),
  unreadable: v.number(),
});

export async function listGoogleConnectionRekeyCandidatesHandler(
  ctx: QueryCtx,
  args: ObjectType<typeof listGoogleConnectionRekeyCandidatesArgs>,
) {
  const rows = await ctx.db.query("googleConnections").take(args.limit);
  const candidates = [];
  let unreadable = 0;
  for (const row of rows) {
    for (const field of [
      "encryptedRefreshToken",
      "encryptedAccessToken",
    ] as const) {
      const envelope = row[field];
      // A disconnected mailbox's refresh token is the empty string, not a
      // missing envelope — see `disconnectGoogleConnection`. Empty is never a
      // candidate: there is nothing there to re-seal.
      if (typeof envelope !== "string" || envelope.length === 0) continue;
      let keyId: string;
      try {
        keyId = envelopeKeyId(envelope);
      } catch {
        unreadable += 1;
        continue;
      }
      if (keyId === args.currentKeyId) continue;
      candidates.push({
        connectionId: row._id,
        workspaceId: row.workspaceId,
        field,
        envelope,
      });
    }
  }
  return { candidates, unreadable };
}

export const applyGoogleConnectionRekeyArgs = {
  connectionId: v.id("googleConnections"),
  field: googleConnectionEnvelopeField,
  expectedEnvelope: v.string(),
  envelope: v.string(),
};

export const applyGoogleConnectionRekeyReturns = v.boolean();

/**
 * Re-seal one mail connection's envelope, conditional on the exact bytes read
 * — same reasoning as `applyRekey`: a connection reconnected or disconnected
 * mid-pass must not have a stale credential (or a disconnect's empty string)
 * overwritten by a re-encryption of what this pass read earlier.
 */
export async function applyGoogleConnectionRekeyHandler(
  ctx: MutationCtx,
  args: ObjectType<typeof applyGoogleConnectionRekeyArgs>,
) {
  const connection = await ctx.db.get(args.connectionId);
  if (connection === null) return false;
  if (connection[args.field] !== args.expectedEnvelope) return false;
  await ctx.db.patch(args.connectionId, {
    [args.field]: args.envelope,
    updatedAt: Date.now(),
  });
  await recordAudit(ctx, {
    workspaceId: connection.workspaceId,
    action: "mail.rekeyed",
  });
  return true;
}
