/**
 * The larger argument and return validators of the storage functions that
 * call, schedule or decrypt. Most of those bodies stay in `functions/storage.ts`
 * beside their registration; `reverifyStorage`'s is in `./bindingActions.ts`.
 *
 * Moved verbatim; the registrations pass them to Convex unchanged. This
 * module registers nothing.
 */

import { v } from "convex/values";
import { capabilitiesValidator, providerValidator } from "./shapes";

export const bindStorageArgs = {
  workspaceId: v.id("workspaces"),
  provider: providerValidator,
  endpoint: v.string(),
  region: v.string(),
  bucket: v.string(),
  rootPrefix: v.optional(v.string()),
  accessKeyId: v.string(),
  secretAccessKey: v.string(),
  /**
   * Optional, and meant to stay unset.
   *
   * Absent is "let the adapter decide", which is correct for R2 and for the
   * classic AWS regional endpoints. It only has to be supplied for an
   * endpoint whose first host label is the bucket name, and in that case the
   * refusal below tells the owner so in as many words rather than letting the
   * probe fail with a status they cannot act on.
   */
  forcePathStyle: v.optional(v.boolean()),
};

export const bindStorageReturns = v.object({ bindingId: v.id("storageBindings"), status: v.string() });

export const applyBindingArgs = {
  actorUserId: v.id("users"),
  workspaceId: v.id("workspaces"),
  provider: providerValidator,
  endpoint: v.string(),
  region: v.string(),
  bucket: v.string(),
  rootPrefix: v.optional(v.string()),
  accessKeyId: v.string(),
  encryptedSecretAccessKey: v.string(),
  forcePathStyle: v.optional(v.boolean()),
  /** Keep a newly minted managed credential amber while IAM propagates. */
  verificationRetryUntil: v.optional(v.number()),
};

export const applyBindingReturns = v.object({ bindingId: v.id("storageBindings"), status: v.string() });

export const rekeyStorageBindingsReturns = v.object({
  rekeyed: v.number(),
  skipped: v.number(),
  unreadable: v.number(),
  dataKeysRekeyed: v.number(),
  dataKeysSkipped: v.number(),
  dataKeysUnreadable: v.number(),
  googleConnectionsRekeyed: v.number(),
  googleConnectionsSkipped: v.number(),
  googleConnectionsUnreadable: v.number(),
  providerCredentialsRekeyed: v.number(),
  providerCredentialsSkipped: v.number(),
  providerCredentialsUnreadable: v.number(),
  platformSecretsRekeyed: v.number(),
  platformSecretsSkipped: v.number(),
  platformSecretsUnreadable: v.number(),
  managedMigrationsRekeyed: v.number(),
  managedMigrationsSkipped: v.number(),
  managedMigrationsUnreadable: v.number(),
});

export const reverifyStorageReturns = v.object({
  queued: v.boolean(),
  /**
   * The status *before* the probe. The probe has not run yet — it cannot
   * have, it is scheduled — so anything else here would be a guess. Watch
   * `getStorageBinding` for the outcome.
   */
  status: v.string(),
});

// Two shapes, not one shape with holes. The gateway's factory refuses a
// binding carrying a credential its provider does not use, so a union here
// is what makes that refusal unreachable by accident: there is no way to
// return a Dropbox binding with an `accessKeyId` on it.
export const getBindingForGatewayReturns = v.union(
  v.null(),
  v.object({
    provider: v.union(
      v.literal("r2"),
      v.literal("s3"),
      v.literal("b2"),
      v.literal("s3-compatible"),
    ),
    endpoint: v.string(),
    region: v.string(),
    bucket: v.string(),
    rootPrefix: v.optional(v.string()),
    accessKeyId: v.string(),
    secretAccessKey: v.string(),
    forcePathStyle: v.optional(v.boolean()),
    capabilities: capabilitiesValidator,
    status: v.string(),
  }),
  v.object({
    provider: v.literal("dropbox"),
    accessToken: v.string(),
    rootPrefix: v.optional(v.string()),
    capabilities: capabilitiesValidator,
    status: v.string(),
  }),
);
