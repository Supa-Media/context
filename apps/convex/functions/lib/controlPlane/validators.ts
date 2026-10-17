/**
 * The argument and return validators of `openStorageBinding` and
 * `openGatewayJob`, whose bodies stay in `functions/controlPlane.ts`
 * because they call the functions that open a credential.
 *
 * Moved verbatim; the registrations pass them to Convex unchanged. This
 * module registers nothing, and `scripts/check-exit-is-ungated.mjs` scans it.
 */

import { v } from "convex/values";
import {
  encryptionKeyValidator,
  keyRotationValidator,
  meaningIndexValidator,
  s3BindingValidator,
  searchIndexValidator,
} from "./bindingShapes";
import { gatewayJobKindValidator } from "./gatewayJobs";

export const openStorageBindingArgs = {
  hashedAccessToken: v.string(),
  expectedWorkspaceId: v.union(v.string(), v.null()),
  /**
   * Mint the next key generation and retire the current one, or — if a
   * rotation is already under way — do nothing and report it. Never
   * mints a second rotation on top of one in progress; see
   * `startWorkspaceKeyRotation`.
   */
  startEncryptionRotation: v.optional(v.boolean()),
  /**
   * The gateway reporting that its bucket-side walk found nothing left on
   * this generation. Conditional on naming the *active* rotation's own
   * target, so a stale call cannot complete the wrong one.
   */
  completeEncryptionRotation: v.optional(v.string()),
};

/**
 * Managed-storage encryption's mode for this workspace's store, a sixth
 * sibling beside the binding. Absent for plain. The key is `encryptionKey`.
 */
export const managedEncryptionSiblingValidator = v.object({
  mode: v.union(v.literal("migrating"), v.literal("encrypted"), v.literal("decrypting")),
});

/** The privacy rules while they are the authority (phase 3, `functions/nodesPrivacy.ts`). */
export const heldPrivacyValidator = v.object({
  etag: v.string(),
  folders: v.array(v.object({ prefix: v.string(), visibility: v.string() })),
  notes: v.array(v.object({ path: v.string(), visibility: v.string() })),
});

export const openStorageBindingReturns = v.union(
  v.null(),
  v.object({
    binding: s3BindingValidator,
    searchIndex: v.optional(searchIndexValidator),
    meaningIndex: v.optional(meaningIndexValidator),
    encryptionKey: v.optional(encryptionKeyValidator),
    rotation: v.optional(keyRotationValidator),
    noteCap: v.optional(v.number()),
    managedEncryption: v.optional(managedEncryptionSiblingValidator),
  }),
);

export const openGatewayJobArgs = { hashedTicket: v.string(), contentSha256: v.optional(v.string()) };

export const openGatewayJobReturns = v.union(
  v.null(),
  v.object({ retryAfterMs: v.number() }),
  v.object({
    job: v.object({
      workspaceId: v.id("workspaces"),
      actorUserId: v.id("users"),
      actorClientId: v.string(),
      grantId: v.id("oauthGrants"),
      kind: gatewayJobKindValidator,
      moveId: v.optional(v.string()),
      imageSha256: v.optional(v.string()),
      imageBytes: v.optional(v.number()),
    }),
    binding: s3BindingValidator,
    searchIndex: v.optional(searchIndexValidator),
    meaningIndex: v.optional(meaningIndexValidator),
    encryptionKey: v.optional(encryptionKeyValidator),
    rotation: v.optional(keyRotationValidator),
    managedEncryption: v.optional(managedEncryptionSiblingValidator),
    privacy: v.optional(heldPrivacyValidator),
    /** Whether the workspace is keyed (`lib/noteIds/keyedStore.ts`): a path-based job is refused. */
    keyed: v.optional(v.boolean()),
  }),
);
