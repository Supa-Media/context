/**
 * The larger argument and return validators of the storage functions that
 * call, schedule or decrypt. Most of those bodies stay in `functions/storage.ts`
 * beside their registration; `reverifyStorage`'s is in `./bindingActions.ts`.
 *
 * Moved verbatim; the registrations pass them to Convex unchanged. This
 * module registers nothing.
 */

import { v } from "convex/values";
import { sealedTemporaryValidator } from "../managedProvisioningFns/temporaryKey";
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

export const startManagedStorageHandoffArgs = bindStorageArgs;
export const startManagedStorageHandoffReturns = v.object({ started: v.literal(true) });

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
  /**
   * A temporary credential a new managed bucket is served on until its own key
   * answers (the schema's `temporaryAccessKeyId`). Every field sealed.
   */
  temporary: sealedTemporaryValidator,
  /**
   * A layout the first check writes once the bucket answers. Only a bucket we
   * just made for a personal workspace is given one
   * (`managedProvisioningFns/complete.ts`): the binding says a layout is on
   * its way from the moment it exists, so the console can show the folders
   * arriving rather than the first run holding somebody on a wait screen.
   */
  firstStructure: v.optional(
    v.object({
      template: v.literal("para"),
      folders: v.array(v.object({ folder: v.string(), description: v.string() })),
      kind: v.literal("personal"),
    }),
  ),
  /**
   * The storage-move engine's own switch-over. Every other caller is refused
   * while a move is copying, because a binding changed under a move is a
   * move that pauses with `SOURCE_CHANGED` (`docs/design/own-storage-moves`).
   */
  cutover: v.optional(v.boolean()),
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
  connectorSecretsRekeyed: v.number(),
  connectorSecretsSkipped: v.number(),
  connectorSecretsUnreadable: v.number(),
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
    sessionToken: v.optional(v.string()),
    forcePathStyle: v.optional(v.boolean()),
    capabilities: capabilitiesValidator,
    status: v.string(),
    /** Absent while the workspace's notes are read from the bucket (`functions/workspaceObjects.ts`). */
    notesHome: v.optional(v.union(v.literal("dual"), v.literal("object"))),
    notesBackfilledAt: v.optional(v.number()),
  }),
);
