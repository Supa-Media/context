/**
 * The rekey sweep's reads and conditional writes for secrets that are not one
 * workspace's binding: platform integration secrets and in-flight managed
 * storage migrations.
 *
 * Split out of `functions/storage.ts`, which keeps every registered storage
 * function and wires these handlers to them; this module registers none and opens no credential.
 */

import { v } from "convex/values";
import type { ObjectType } from "convex/values";
import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import { recordAudit } from "../audit";
import { envelopeKeyId } from "../crypto";

export const listPlatformSecretRekeyCandidatesArgs = { currentKeyId: v.string(), limit: v.number() };

export const listPlatformSecretRekeyCandidatesReturns = v.object({
  candidates: v.array(
    v.object({ rowId: v.id("appSecrets"), envelope: v.string() }),
  ),
  unreadable: v.number(),
});

/**
 * Platform secrets still on an older envelope key.
 *
 * `appSecrets` is bound to the `integration` scope rather than to a workspace,
 * so it needs its own context and could not have ridden the binding query even
 * if the tables had matched.
 */
export async function listPlatformSecretRekeyCandidatesHandler(
  ctx: QueryCtx,
  args: ObjectType<typeof listPlatformSecretRekeyCandidatesArgs>,
) {
  const rows = await ctx.db.query("appSecrets").take(args.limit);
  const candidates = [];
  let unreadable = 0;
  for (const row of rows) {
    const envelope = row.encryptedValue;
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
    candidates.push({ rowId: row._id, envelope });
  }
  return { candidates, unreadable };
}

export const applyPlatformSecretRekeyArgs = {
  rowId: v.id("appSecrets"),
  expectedEnvelope: v.string(),
  envelope: v.string(),
};

export const applyPlatformSecretRekeyReturns = v.boolean();

/**
 * Re-seal one platform secret, conditional on the bytes the pass read.
 *
 * `fingerprint` is not recomputed and must not change: it is derived from the
 * plaintext, which this does not touch. A fingerprint that moved during a
 * rotation would tell an operator their credential had been replaced.
 *
 * No audit row: `recordAudit` is keyed by workspace and this credential belongs
 * to no customer's context. Writing it against an arbitrary workspace would put
 * a platform maintenance event in somebody's own audit trail.
 */
export async function applyPlatformSecretRekeyHandler(
  ctx: MutationCtx,
  args: ObjectType<typeof applyPlatformSecretRekeyArgs>,
) {
  const row = await ctx.db.get(args.rowId);
  if (row === null) return false;
  if (row.encryptedValue !== args.expectedEnvelope) return false;
  await ctx.db.patch(args.rowId, { encryptedValue: args.envelope });
  return true;
}

export const listManagedMigrationRekeyCandidatesArgs = { currentKeyId: v.string(), limit: v.number() };

export const listManagedMigrationRekeyCandidatesReturns = v.object({
  candidates: v.array(
    v.object({
      rowId: v.id("managedStorageMigrations"),
      workspaceId: v.id("workspaces"),
      envelope: v.string(),
    }),
  ),
  unreadable: v.number(),
});

/** Destination credentials parked while a managed-storage copy is in flight. */
export async function listManagedMigrationRekeyCandidatesHandler(
  ctx: QueryCtx,
  args: ObjectType<typeof listManagedMigrationRekeyCandidatesArgs>,
) {
  const rows = await ctx.db
    .query("managedStorageMigrations")
    .take(args.limit);
  const candidates = [];
  let unreadable = 0;
  for (const row of rows) {
    const envelope = row.encryptedTargetSecretAccessKey;
    let keyId: string;
    try {
      keyId = envelopeKeyId(envelope);
    } catch {
      unreadable += 1;
      continue;
    }
    if (keyId !== args.currentKeyId) {
      candidates.push({
        rowId: row._id,
        workspaceId: row.workspaceId,
        envelope,
      });
    }
  }
  return { candidates, unreadable };
}

export const applyManagedMigrationRekeyArgs = {
  rowId: v.id("managedStorageMigrations"),
  expectedEnvelope: v.string(),
  envelope: v.string(),
};

export const applyManagedMigrationRekeyReturns = v.boolean();

export async function applyManagedMigrationRekeyHandler(
  ctx: MutationCtx,
  args: ObjectType<typeof applyManagedMigrationRekeyArgs>,
) {
  const row = await ctx.db.get(args.rowId);
  if (
    row === null ||
    row.encryptedTargetSecretAccessKey !== args.expectedEnvelope
  ) {
    return false;
  }
  await ctx.db.patch(row._id, {
    encryptedTargetSecretAccessKey: args.envelope,
    updatedAt: Date.now(),
  });
  await recordAudit(ctx, {
    workspaceId: row.workspaceId,
    action: "storage.rekeyed",
  });
  return true;
}
