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
  dropboxBindingValidator,
  encryptionKeyValidator,
  keyRotationValidator,
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

export const openStorageBindingReturns = v.union(
  v.null(),
  v.object({
    binding: v.union(s3BindingValidator, dropboxBindingValidator),
    searchIndex: v.optional(searchIndexValidator),
    encryptionKey: v.optional(encryptionKeyValidator),
    rotation: v.optional(keyRotationValidator),
    noteCap: v.optional(v.number()),
  }),
);

export const openGatewayJobArgs = { hashedTicket: v.string() };

export const openGatewayJobReturns = v.union(
  v.null(),
  v.object({
    job: v.object({
      workspaceId: v.id("workspaces"),
      actorUserId: v.id("users"),
      actorClientId: v.string(),
      grantId: v.id("oauthGrants"),
      kind: gatewayJobKindValidator,
      moveId: v.optional(v.string()),
    }),
    binding: v.union(s3BindingValidator, dropboxBindingValidator),
    searchIndex: v.optional(searchIndexValidator),
    encryptionKey: v.optional(encryptionKeyValidator),
    rotation: v.optional(keyRotationValidator),
  }),
);
