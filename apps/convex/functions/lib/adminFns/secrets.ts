/**
 * The parts of `listSecrets`, `setSecret`, `deleteSecret` and `applySecret`
 * that run after the staff-only check `admin.ts` keeps inline.
 *
 * Split out of `functions/admin.ts` — see that file's header for the
 * credential-boundary rule this whole module exists under: `encryptedValue`
 * is never selected, decrypted, or returned by anything here, and there is
 * deliberately no `getSecret`.
 */

import { ConvexError } from "convex/values";
import { internal } from "../../../_generated/api";
import type { Doc } from "../../../_generated/dataModel";
import type { ActionCtx, MutationCtx, QueryCtx } from "../../../_generated/server";
import {
  fingerprintSecret,
  normalizeSecretDescription,
  normalizeSecretName,
  normalizeSecretValue,
} from "../appSecrets";
import { encryptSecret, requireKeyset } from "../crypto";
import type { AdminActor } from "../admin";
import { recordAdminAudit } from "./audit";

export interface AdminSecretRow {
  name: string;
  fingerprint: string;
  description?: string;
  updatedAt: number;
  createdAt: number;
  updatedByEmail?: string;
}

/**
 * Every stored integration credential, as metadata.
 *
 * `encryptedValue` is not selected, not decrypted, and not returned. The
 * envelope never leaves the database through this function — not even in its
 * sealed form, because a sealed envelope plus a leaked key is the credential,
 * and a ciphertext on a client is a ciphertext an attacker can keep.
 */
export async function listSecretsHandler(ctx: QueryCtx): Promise<AdminSecretRow[]> {
  const rows = await ctx.db.query("appSecrets").collect();
  rows.sort((a, b) => a.name.localeCompare(b.name));

  const out: AdminSecretRow[] = [];
  for (const row of rows) {
    const setter = await ctx.db.get(row.updatedBy);
    out.push({
      name: row.name,
      fingerprint: row.fingerprint,
      description: row.description,
      updatedAt: row.updatedAt,
      createdAt: row.createdAt,
      updatedByEmail: setter?.email,
    });
  }
  return out;
}

/**
 * Store or replace one integration credential, once the caller has already
 * been proven staff and the raw arguments normalized.
 *
 * Replacing is deliberately the same call as creating. A separate "rotate"
 * path would be a second place for the envelope to be written, and the
 * difference an operator cares about — did this change, and to what — is the
 * fingerprint, which both paths recompute.
 */
export async function setSecretHandler(
  ctx: ActionCtx,
  actor: AdminActor,
  name: string,
  value: string,
  description: string | undefined,
): Promise<{ name: string; fingerprint: string }> {
  const fingerprint = await fingerprintSecret(value);
  const envelope = await encryptSecret(value, requireKeyset(), {
    platform: "integration",
  });

  await ctx.runMutation(internal.functions.admin.applySecret, {
    actorUserId: actor.userId,
    actorEmail: actor.email,
    name,
    envelope,
    fingerprint,
    description,
  });

  return { name, fingerprint };
}

/** Normalize `setSecret`'s raw arguments. Thrown values are `AppSecretError`. */
export function normalizeSecretInput(args: {
  name: string;
  value: string;
  description?: string;
}): { name: string; value: string; description: string | undefined } {
  return {
    name: normalizeSecretName(args.name),
    value: normalizeSecretValue(args.value),
    description: normalizeSecretDescription(args.description),
  };
}

export async function deleteSecretHandler(
  ctx: MutationCtx,
  actor: AdminActor,
  name: string,
): Promise<{ name: string }> {
  const row = await ctx.db
    .query("appSecrets")
    .withIndex("by_name", (q) => q.eq("name", name))
    .unique();
  if (row === null) {
    throw new ConvexError({
      code: "NOT_FOUND",
      message: `No secret named ${name}.`,
    });
  }

  await ctx.db.delete(row._id);
  await recordAdminAudit(ctx, actor, "secret.deleted", name, {
    fingerprint: row.fingerprint,
  });
  return { name };
}

export async function applySecretHandler(
  ctx: MutationCtx,
  args: {
    actorUserId: AdminActor["userId"];
    actorEmail: string;
    name: string;
    envelope: string;
    fingerprint: string;
    description?: string;
  },
): Promise<void> {
  const now = Date.now();
  const existing: Doc<"appSecrets"> | null = await ctx.db
    .query("appSecrets")
    .withIndex("by_name", (q) => q.eq("name", args.name))
    .unique();

  const actor: AdminActor = {
    userId: args.actorUserId,
    email: args.actorEmail,
  };

  if (existing === null) {
    await ctx.db.insert("appSecrets", {
      name: args.name,
      encryptedValue: args.envelope,
      fingerprint: args.fingerprint,
      description: args.description,
      updatedBy: args.actorUserId,
      updatedAt: now,
      createdAt: now,
    });
    await recordAdminAudit(ctx, actor, "secret.set", args.name, {
      fingerprint: args.fingerprint,
    });
    return;
  }

  await ctx.db.patch(existing._id, {
    encryptedValue: args.envelope,
    fingerprint: args.fingerprint,
    // An absent description leaves the existing one alone: the common edit
    // is rotating a value, and clearing the note explaining what a token is
    // for as a side effect of that would be a surprise.
    description: args.description ?? existing.description,
    updatedBy: args.actorUserId,
    updatedAt: now,
  });
  await recordAdminAudit(ctx, actor, "secret.updated", args.name, {
    fingerprint: args.fingerprint,
    previousFingerprint: existing.fingerprint,
  });
}
