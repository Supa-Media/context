/**
 * Storage bindings — the customer's own bucket.
 *
 * A binding is keyed by `workspaceId`, never `userId`. The credential belongs
 * to the context, not to whoever pasted it; keying it to a person means the
 * day a context gains a second member you are writing a migration instead of
 * an insert. See CLAUDE.md, "The workspace model".
 *
 * ## The credential's lifecycle, in one place
 *
 *   client → `bindStorage` (action)  plaintext secret, in memory only
 *          → `encryptSecret`         AES-GCM envelope, bound to the workspace
 *          → `applyBinding`          envelope written to the row
 *          ...
 *   gateway → `getBindingForGateway` (INTERNAL action) envelope → plaintext
 *
 * There is deliberately no public path from the row back to the plaintext.
 * `getStorageBinding` returns status, a masked access key id, and — for
 * Dropbox — the account id it is connected to, and nothing else. If you are
 * adding a function that returns `encryptedSecretAccessKey`
 * to a client, you are building a credential-disclosure endpoint even though
 * the value looks opaque — an offline attack on a leaked key beats a value
 * that never left the server.
 *
 * That last rule is not left to reviewers noticing: `__tests__/structure.test.ts`
 * walks every Convex module, builds the call graph, and fails if any *public*
 * function can transitively reach the decrypt path — including through a new
 * module written specifically to launder it.
 *
 * The envelope is bound to its `workspaceId` as AES-GCM additional
 * authenticated data, so it opens in exactly one workspace's row. Copying a
 * row's envelope into another workspace yields a decrypt failure, not that
 * workspace's credential.
 *
 * ## Where the rest of it lives
 *
 * Every storage function is still registered here, under the same name, kind
 * and validators. The credential's lifecycle above — `bindStorage`,
 * `applyBinding`, `getBindingForGateway` and the rekey pass — stays here in
 * full: this is the module `DECRYPT_IMPORTERS` names, and
 * `__tests__/structure/` reads these bodies' own text. Everything else — the
 * shapes, endpoint rules, probe records, the rekey sweep's reads and writes,
 * the member's view, and what happens to a binding after it is written — is
 * in `./lib/storage/`, which the credential graph follows through imports.
 */

import { ConvexError, v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internal } from "../_generated/api";
import {
  isDropboxReconnectRequired,
  refreshDropboxToken,
} from "./lib/dropboxOAuth";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import {
  CredentialCryptoError,
  decryptSecret,
  encryptSecret,
  requireKeyset,
} from "./lib/crypto";
import { recordAudit } from "./lib/audit";
import { requireWorkspaceRole } from "./lib/workspaceAuth";
import {
  capabilitiesValidator,
  initialCapabilities,
  type BindingResult,
  type DataKeyRekeyCandidates,
  type GatewayCredential,
  type ManagedMigrationRekeyCandidates,
  type PlatformSecretRekeyCandidates,
  type RekeyCandidates,
  type RekeyResult,
  type SealedBinding,
} from "./lib/storage/shapes";
import {
  addressingIsAmbiguous,
  ambiguousAddressingError,
  assertUsableEndpoint,
  normalizeRootPrefix,
  storageMoved,
} from "./lib/storage/address";
import { ACCESS_TOKEN_MARGIN_MS } from "./lib/storage/gatewayBinding";
import {
  REKEY_BATCH_SIZE,
  type GoogleConnectionRekeyCandidates,
  type ProviderCredentialRekeyCandidates,
} from "./lib/storage/rekeyColumns";
import * as bindingState from "./lib/storage/bindingState";
import * as gatewayBinding from "./lib/storage/gatewayBinding";
import * as rekeyWorkspace from "./lib/storage/rekeyWorkspaceSecrets";
import * as rekeyPlatform from "./lib/storage/rekeyPlatformSecrets";
import * as bindingView from "./lib/storage/bindingView";
import * as validators from "./lib/storage/validators";
import * as bindingActions from "./lib/storage/bindingActions";

export {
  capabilitiesValidator,
  type BindingResult,
  type DataKeyRekeyCandidates,
  type DropboxGatewayCredential,
  type GatewayCredential,
  type ManagedMigrationRekeyCandidates,
  type PlatformSecretRekeyCandidates,
  type RekeyCandidates,
  type RekeyResult,
  type S3GatewayCredential,
  type SealedBinding,
  type StorageCapabilities,
} from "./lib/storage/shapes";
export {
  addressingIsAmbiguous,
  storageAddress,
  storageMoved,
} from "./lib/storage/address";
export {
  ENVELOPE_FIELDS,
  ROTATED_ENVELOPE_COLUMNS,
  ROTATION_EXEMPT_ENVELOPE_COLUMNS,
  type EnvelopeField,
  type GoogleConnectionRekeyCandidates,
  type ProviderCredentialRekeyCandidates,
} from "./lib/storage/rekeyColumns";
export { CAPABILITY_SWEEP_BATCH } from "./lib/storage/limits";

/**
 * Bind (or rebind) a workspace's storage.
 *
 * An **action**, not a mutation, for two reasons: encryption is Web Crypto,
 * which belongs in the action runtime, and the plaintext secret should live in
 * as few places as possible — here it exists only for the duration of one call
 * and is never written anywhere in the clear.
 *
 * Owner-only. Rebinding storage repoints the entire context at a different
 * bucket, which is functionally "replace everyone's data", so it is not
 * something an `editor` (let alone a read-only `member`) may do. The role
 * check runs again inside `applyBinding`, because an action's check and its
 * write are not one transaction and membership can change in between.
 *
 * The binding starts `unverified`. We do not claim a bucket works until
 * something has actually talked to it.
 */
export const bindStorage = action({
  args: validators.bindStorageArgs,
  returns: validators.bindStorageReturns,
  // The explicit return type breaks the inference cycle created by calling
  // `internal.functions.storage.applyBinding` from inside this same module.
  handler: async (ctx, args): Promise<BindingResult> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new ConvexError({
        code: "NOT_AUTHENTICATED",
        message: "Not authenticated",
      });
    }

    assertUsableEndpoint(args.endpoint);
    if (args.bucket.trim().length === 0) {
      throw new ConvexError({
        code: "INVALID_BUCKET",
        message: "A bucket name is required.",
      });
    }
    if (
      args.accessKeyId.trim().length === 0 ||
      args.secretAccessKey.length === 0
    ) {
      throw new ConvexError({
        code: "INVALID_CREDENTIAL",
        message: "Both an access key id and a secret access key are required.",
      });
    }
    const bucket = args.bucket.trim();
    // Refuse the one configuration nothing downstream can resolve, here, while
    // there is still a person and a form to answer the question. Left to the
    // probe it becomes a permanently-`error` binding whose only documented cure
    // is re-pasting a credential that was never the problem.
    if (
      args.forcePathStyle === undefined &&
      addressingIsAmbiguous(args.endpoint, bucket)
    ) {
      throw ambiguousAddressingError(bucket);
    }
    const rootPrefix = normalizeRootPrefix(args.rootPrefix);

    // Bound to this workspace id. `applyBinding` authorizes the same id and
    // writes the envelope into that workspace's row, so an envelope and the
    // row holding it can never disagree about which context they belong to.
    const encryptedSecretAccessKey = await encryptSecret(
      args.secretAccessKey,
      requireKeyset(),
      { workspaceId: args.workspaceId },
    );

    return await ctx.runMutation(internal.functions.storage.applyBinding, {
      actorUserId: userId as Id<"users">,
      workspaceId: args.workspaceId,
      provider: args.provider,
      endpoint: args.endpoint,
      region: args.region,
      bucket,
      rootPrefix,
      accessKeyId: args.accessKeyId.trim(),
      encryptedSecretAccessKey,
      forcePathStyle: args.forcePathStyle,
    });
  },
});

/**
 * Write the binding. Internal — the plaintext secret never reaches here.
 *
 * `actorUserId` is supplied by the calling action rather than read from auth,
 * which is safe precisely because internal functions are unreachable from any
 * client: there is nobody who could pass a forged one. The membership and role
 * checks below are what actually authorize the write.
 */
export const applyBinding = internalMutation({
  args: validators.applyBindingArgs,
  returns: validators.applyBindingReturns,
  handler: async (ctx, args) => {
    await requireWorkspaceRole(
      ctx,
      args.workspaceId,
      args.actorUserId,
      "owner",
    );

    const now = Date.now();
    const existing = await ctx.db
      .query("storageBindings")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .unique();

    const fields = {
      workspaceId: args.workspaceId,
      provider: args.provider,
      endpoint: args.endpoint,
      region: args.region,
      bucket: args.bucket,
      rootPrefix: args.rootPrefix,
      accessKeyId: args.accessKeyId,
      encryptedSecretAccessKey: args.encryptedSecretAccessKey,
      forcePathStyle: args.forcePathStyle,
      capabilities: initialCapabilities(),
      status: "unverified" as const,
      // A rebind invalidates whatever we knew about the old bucket. Carrying
      // `lastVerifiedAt` forward would show a green check for a bucket nothing
      // has ever contacted.
      lastVerifiedAt: undefined,
      lastError: undefined,
      errorCode: undefined,
      // Same reasoning as `lastVerifiedAt`, and it matters more: a rebind
      // points at a *different bucket*, so "we found an existing context" or
      // "we laid one down" describes somewhere else entirely. Carrying either
      // forward would have onboarding skip the question for a bucket nothing
      // has ever looked at.
      scaffolded: undefined,
      scaffoldReason: undefined,
      // And this one most of all: it is the licence to resume a half-written
      // scaffold without the "already a context" guard. Carrying it to a
      // different bucket would carry that licence somewhere it was never
      // earned.
      scaffoldMissing: undefined,
      // And the census, for the same reason as `lastVerifiedAt`: a rebind
      // points at a different bucket, so a count carried forward is a number
      // about somewhere else rendered as a fact about here. Left standing, a
      // rebind to an unreachable bucket showed `status: "error"` beside a
      // confident note total for a bucket nothing had ever contacted.
      noteCount: undefined,
      noteCountedAt: undefined,
      noteCountTruncated: undefined,
      // And where the storage-layout migration got to, which is the one whose
      // survival would be silent. It is what decides whether the console still
      // offers that migration, so a `complete` carried onto a different bucket
      // is a bucket that never gets offered it — the pre-v1 plumbing left in
      // place, dual reads carrying it, and nothing on any screen saying so.
      storageLayoutState: undefined,
      storageLayoutAt: undefined,
      // And the record that it was ever *asked*, which is the half that
      // decides whether the console offers at all. Left behind, a new bucket
      // reads as "checked, never run" and is never offered the migration.
      storageLayoutCheckedAt: undefined,
      // With the generation that asked, for the same reason: it qualifies an
      // answer about a different bucket, and an answer nobody gave needs no
      // qualifying.
      storageLayoutCheckedVersion: undefined,
      // And the Dropbox grant, which is the one with a life of its own.
      //
      // `applyDropboxBinding` clears every S3 field on the way in and says why:
      // "what is true of the old storage is not true of the new." The reverse
      // direction was never written, so a customer moving off Dropbox onto
      // their own bucket left us holding a live refresh token for their
      // Dropbox — invisible in the console, which shows an S3 binding and no
      // Dropbox field at all, and kept alive indefinitely because key rotation
      // walks `ENVELOPE_FIELDS` on every pass.
      //
      // That is the direct inverse of "a customer can revoke our storage
      // credential without asking us first, and keep a complete, usable
      // context": they did the thing that should end the relationship, the
      // product agreed, and the credential stayed. It is also the shape the
      // Cloudflare decision rules out for that credential — "there is no
      // steady state in which the control plane holds an account-level cloud
      // credential."
      encryptedRefreshToken: undefined,
      encryptedAccessToken: undefined,
      accessTokenExpiresAt: undefined,
      dropboxAccountId: undefined,
      boundBy: args.actorUserId,
      updatedAt: now,
    };

    // Rebinding away from Dropbox is a disconnect, and gets the same funeral.
    //
    // Clearing the four fields above stops us holding the credential, which
    // was the whole of the earlier fix — and it is only half. `disconnect`
    // schedules this and states the other half: without it "we forget our copy
    // of the credential while the authorization lives on in the person's
    // account, and their next connect silently auto-approves instead of
    // asking". A customer moving their context to their own bucket has ended
    // the Dropbox relationship exactly as definitively as one clicking
    // Disconnect; they should not have to go to Dropbox to finish the job.
    //
    // Scheduled, never called, so this mutation cannot reach the decrypt — and
    // the envelope travels in the args because `fields` is about to erase it.
    // No check that the new provider is not Dropbox: this mutation's own
    // validator cannot express one — `applyBinding` writes the S3 family and
    // nothing else, and a Dropbox binding is written by `applyDropboxBinding`.
    // `tsc` said so when the redundant clause was there.
    // The `provider` half is defence, not a live guard: no product path writes
    // a refresh token onto a non-Dropbox row (`applyDropboxBinding` sets both
    // together, this mutation only ever clears the field, and rotation
    // re-encrypts a field into itself without touching `provider`). Removing
    // it changes no test, which is the honest signal — and a reader meeting it
    // cannot tell that without running the sabotage, so it is written here.
    if (
      existing?.provider === "dropbox" &&
      existing.encryptedRefreshToken !== undefined
    ) {
      await ctx.scheduler.runAfter(
        0,
        internal.functions.dropboxConnect.revokeDropboxGrant,
        {
          workspaceId: args.workspaceId,
          encryptedRefreshToken: existing.encryptedRefreshToken,
        },
      );
    }

    /*
      And the projection of the notes, when the notes have moved.

      Every field cleared above describes the old bucket and costs nothing to
      recompute. The search index describes it too, and is the one that is
      neither free nor ours to keep: it is a D1 database holding this context's
      note text, and pointed at a different bucket it answers searches out of
      somewhere the person has left.

      `storageMoved` rather than "this row was rewritten", because rotating an
      access key on the same bucket is a repair and must not cost a
      re-provision. Before the write, so the comparison is against what was
      really there.
    */
    if (storageMoved(existing, fields)) {
      await ctx.runMutation(internal.functions.fastSearch.releaseForStorage, {
        workspaceId: args.workspaceId,
      });
    }

    let bindingId: Id<"storageBindings">;
    if (existing === null) {
      bindingId = await ctx.db.insert("storageBindings", {
        ...fields,
        createdAt: now,
      });
    } else {
      await ctx.db.patch(existing._id, fields);
      bindingId = existing._id;
    }

    await recordAudit(ctx, {
      workspaceId: args.workspaceId,
      actorUserId: args.actorUserId,
      action: existing === null ? "storage.bound" : "storage.rebound",
      details: {
        provider: args.provider,
        bucket: args.bucket,
        // Endpoint and bucket are configuration, not secrets. The access key
        // id and secret are omitted entirely.
        endpoint: args.endpoint,
      },
    });

    // Close the loop: something has to actually talk to the bucket before we
    // will call it connected. Scheduled rather than awaited, for three
    // reasons.
    //
    //  1. **It is transactional here and nowhere else.** Scheduling from
    //     inside the mutation queues the probe if and only if the row commits.
    //     Kicking it off from `bindStorage` after the mutation returned would
    //     leave a window where the row exists and nothing is coming for it.
    //  2. **The endpoint is a URL the customer typed.** Awaiting a round trip
    //     to it inside the call that saves their credential makes "paste and
    //     save" as slow as the slowest thing they can point us at.
    //  3. **Nothing flows back.** `verifyStorageBinding` decrypts, so a public
    //     function able to *call* it would have the credential decrypt path in
    //     its call graph. A scheduled function's result is discarded by the
    //     scheduler and can never reach whoever queued it — the distinction
    //     `__tests__/structure.test.ts` draws between a call edge and a
    //     schedule edge.
    //
    // The row stays `unverified` until the probe reports back, which is the
    // truthful state: nothing has contacted this bucket yet.
    await ctx.scheduler.runAfter(
      0,
      internal.functions.provisioning.verifyStorageBinding,
      {
        workspaceId: args.workspaceId,
        actorUserId: args.actorUserId,
        retryUntil: args.verificationRetryUntil,
      },
    );

    return { bindingId, status: "unverified" };
  },
});

export const recordVerification = internalMutation({
  args: bindingState.recordVerificationArgs,
  returns: bindingState.recordVerificationReturns,
  handler: bindingState.recordVerificationHandler,
});

export const recordStorageLayoutState = internalMutation({
  args: bindingState.recordStorageLayoutStateArgs,
  returns: bindingState.recordStorageLayoutStateReturns,
  handler: bindingState.recordStorageLayoutStateHandler,
});

export const recordNoteCount = internalMutation({
  args: bindingState.recordNoteCountArgs,
  returns: bindingState.recordNoteCountReturns,
  handler: bindingState.recordNoteCountHandler,
});

export const getBindingRow = internalQuery({
  args: gatewayBinding.getBindingRowArgs,
  returns: gatewayBinding.getBindingRowReturns,
  handler: gatewayBinding.getBindingRowHandler,
});

/**
 * Hand the gateway a usable credential. INTERNAL ACTION — the only decryption
 * path in the codebase.
 *
 * `internalAction` is load-bearing, not stylistic. Convex refuses to route a
 * client call to an internal function, so this cannot be reached by anyone
 * holding a session token, an OAuth grant, or a guessed function name. The
 * gateway reaches it through a server-to-server call with its own deploy
 * credential.
 *
 * The caller must treat the returned `secretAccessKey` as radioactive: use it
 * to sign a request, never log it, never return it upward, never cache it
 * anywhere durable.
 */
export const getBindingForGateway = internalAction({
  args: { workspaceId: v.id("workspaces") },
  // Two shapes, not one shape with holes. The gateway's factory refuses a
  // binding carrying a credential its provider does not use, so a union here
  // is what makes that refusal unreachable by accident: there is no way to
  // return a Dropbox binding with an `accessKeyId` on it.
  returns: v.union(
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
  ),
  // Same inference cycle as `bindStorage`: annotated, not inferred.
  handler: async (ctx, args): Promise<GatewayCredential | null> => {
    const binding: SealedBinding | null = await ctx.runQuery(
      internal.functions.storage.getBindingRow,
      { workspaceId: args.workspaceId },
    );
    if (binding === null) return null;

    // Dropbox is served from a *refreshed* short-lived access token, and the
    // payload it gets carries nothing else. Two rules meet here:
    //
    //  - **The refresh token never leaves the control plane.** A compromised
    //    gateway then holds minutes of one workspace's storage rather than the
    //    standing ability to mint tokens for it. Same reasoning as "never
    //    cache a decrypted credential across requests", one layer up.
    //  - **The payload is built per provider, never spread from the row.** A
    //    workspace rebound from S3 to Dropbox can leave a stale `accessKeyId`
    //    behind; spread, that reaches the gateway as a credential for storage
    //    this binding no longer points at.
    if (binding.provider === "dropbox") {
      const accessToken = await dropboxAccessToken(
        ctx,
        args.workspaceId,
        binding,
      );
      return {
        provider: "dropbox",
        accessToken,
        rootPrefix: binding.rootPrefix,
        capabilities: binding.capabilities,
        status: binding.status,
      };
    }

    // Narrowed rather than asserted. These five are guaranteed together for
    // every non-Dropbox provider by `bindStorage`, and a row that somehow
    // lacks one is a corrupt binding, not something to paper over with `!`.
    if (
      !binding.endpoint ||
      !binding.region ||
      !binding.bucket ||
      !binding.accessKeyId ||
      !binding.encryptedSecretAccessKey
    ) {
      throw new ConvexError({
        code: "CREDENTIAL_UNAVAILABLE",
        message:
          "This workspace's storage binding is incomplete. Rebind storage to replace it.",
      });
    }

    // The workspace id is the AAD the envelope was sealed with. Passing the id
    // this call was made *for* — rather than one carried inside the row — is
    // what makes a future id-confusion bug in the gateway a decrypt failure
    // instead of a cross-tenant credential handout.
    let secretAccessKey: string;
    try {
      secretAccessKey = await decryptSecret(
        binding.encryptedSecretAccessKey,
        requireKeyset(),
        { workspaceId: args.workspaceId },
      );
    } catch (error) {
      // A `CredentialCryptoError` is a plain `Error`, which a caller sees as an
      // unhelpful "Server Error". Re-throw with a code so the gateway can tell
      // "this binding needs re-pasting" from "the service is broken" — and
      // carry no detail beyond that, since the underlying distinctions (wrong
      // key, wrong workspace, tampered ciphertext) are an oracle.
      if (error instanceof CredentialCryptoError) {
        throw new ConvexError({
          code: "CREDENTIAL_UNAVAILABLE",
          message:
            "This workspace's storage credential could not be opened. Rebind storage to replace it.",
        });
      }
      throw error;
    }

    return {
      provider: binding.provider,
      endpoint: binding.endpoint,
      region: binding.region,
      bucket: binding.bucket,
      rootPrefix: binding.rootPrefix,
      accessKeyId: binding.accessKeyId,
      secretAccessKey,
      forcePathStyle: binding.forcePathStyle,
      capabilities: binding.capabilities,
      status: binding.status,
    };
  },
});

async function dropboxAccessToken(
  ctx: { runMutation: (ref: never, args: never) => Promise<unknown> },
  workspaceId: Id<"workspaces">,
  binding: SealedBinding,
): Promise<string> {
  if (!binding.encryptedRefreshToken) {
    throw new ConvexError({
      code: "CREDENTIAL_UNAVAILABLE",
      message: "This context's Dropbox connection is incomplete. Reconnect it.",
    });
  }

  const keyset = requireKeyset();
  const context = { workspaceId: workspaceId as string };
  const stillFresh =
    typeof binding.accessTokenExpiresAt === "number" &&
    binding.accessTokenExpiresAt - Date.now() > ACCESS_TOKEN_MARGIN_MS;

  if (stillFresh && binding.encryptedAccessToken) {
    try {
      return await decryptSecret(binding.encryptedAccessToken, keyset, context);
    } catch {
      // A cached token that will not open is not worth failing a read over
      // when a new one is one call away. Fall through and refresh.
    }
  }

  let refreshToken: string;
  try {
    refreshToken = await decryptSecret(
      binding.encryptedRefreshToken,
      keyset,
      context,
    );
  } catch (error) {
    if (error instanceof CredentialCryptoError) {
      throw new ConvexError({
        code: "CREDENTIAL_UNAVAILABLE",
        message:
          "This context's Dropbox credential could not be opened. Reconnect Dropbox to replace it.",
      });
    }
    throw error;
  }

  const clientId = process.env.DROPBOX_APP_KEY;
  if (typeof clientId !== "string" || clientId.length === 0) {
    throw new ConvexError({
      code: "DROPBOX_NOT_CONFIGURED",
      message: "Dropbox is not configured on this deployment.",
    });
  }
  // Optional, unlike the key above: PKCE already proved this flow, so a
  // deployment with no secret configured refreshes as the public client this
  // feature shipped with. See `lib/dropboxOAuth.ts` for why sending one where
  // it is available costs nothing and buys an independent check.
  const clientSecret = process.env.DROPBOX_APP_SECRET || undefined;

  let refreshed;
  try {
    refreshed = await refreshDropboxToken({
      clientId,
      clientSecret,
      refreshToken,
    });
  } catch (error) {
    // A revoked grant is not a transient failure, and the two need different
    // words: one is "reconnect Dropbox", the other is "try again".
    if (isDropboxReconnectRequired(error)) {
      throw new ConvexError({
        code: "STORAGE_REAUTH_REQUIRED",
        message:
          "Dropbox access for this context was revoked. Reconnect Dropbox to restore it.",
      });
    }
    throw new ConvexError({
      code: "STORAGE_UNAVAILABLE",
      message: "Dropbox could not be reached. Try again.",
    });
  }

  await ctx.runMutation(
    internal.functions.storage.recordDropboxRefresh as never,
    {
      workspaceId,
      encryptedAccessToken: await encryptSecret(
        refreshed.accessToken,
        keyset,
        context,
      ),
      accessTokenExpiresAt: refreshed.expiresAt,
      encryptedRefreshToken: refreshed.refreshToken
        ? await encryptSecret(refreshed.refreshToken, keyset, context)
        : undefined,
    } as never,
  );

  return refreshed.accessToken;
}

export const recordDropboxRefresh = internalMutation({
  args: gatewayBinding.recordDropboxRefreshArgs,
  returns: gatewayBinding.recordDropboxRefreshReturns,
  handler: gatewayBinding.recordDropboxRefreshHandler,
});

export const listRekeyCandidates = internalQuery({
  args: rekeyWorkspace.listRekeyCandidatesArgs,
  returns: rekeyWorkspace.listRekeyCandidatesReturns,
  handler: rekeyWorkspace.listRekeyCandidatesHandler,
});

export const applyRekey = internalMutation({
  args: rekeyWorkspace.applyRekeyArgs,
  returns: rekeyWorkspace.applyRekeyReturns,
  handler: rekeyWorkspace.applyRekeyHandler,
});

export const listDataKeyRekeyCandidates = internalQuery({
  args: rekeyWorkspace.listDataKeyRekeyCandidatesArgs,
  returns: rekeyWorkspace.listDataKeyRekeyCandidatesReturns,
  handler: rekeyWorkspace.listDataKeyRekeyCandidatesHandler,
});

export const applyDataKeyRekey = internalMutation({
  args: rekeyWorkspace.applyDataKeyRekeyArgs,
  returns: rekeyWorkspace.applyDataKeyRekeyReturns,
  handler: rekeyWorkspace.applyDataKeyRekeyHandler,
});

export const listProviderCredentialRekeyCandidates = internalQuery({
  args: rekeyWorkspace.listProviderCredentialRekeyCandidatesArgs,
  returns: rekeyWorkspace.listProviderCredentialRekeyCandidatesReturns,
  handler: rekeyWorkspace.listProviderCredentialRekeyCandidatesHandler,
});

export const applyProviderCredentialRekey = internalMutation({
  args: rekeyWorkspace.applyProviderCredentialRekeyArgs,
  returns: rekeyWorkspace.applyProviderCredentialRekeyReturns,
  handler: rekeyWorkspace.applyProviderCredentialRekeyHandler,
});

export const listGoogleConnectionRekeyCandidates = internalQuery({
  args: rekeyWorkspace.listGoogleConnectionRekeyCandidatesArgs,
  returns: rekeyWorkspace.listGoogleConnectionRekeyCandidatesReturns,
  handler: rekeyWorkspace.listGoogleConnectionRekeyCandidatesHandler,
});

export const applyGoogleConnectionRekey = internalMutation({
  args: rekeyWorkspace.applyGoogleConnectionRekeyArgs,
  returns: rekeyWorkspace.applyGoogleConnectionRekeyReturns,
  handler: rekeyWorkspace.applyGoogleConnectionRekeyHandler,
});

export const listPlatformSecretRekeyCandidates = internalQuery({
  args: rekeyPlatform.listPlatformSecretRekeyCandidatesArgs,
  returns: rekeyPlatform.listPlatformSecretRekeyCandidatesReturns,
  handler: rekeyPlatform.listPlatformSecretRekeyCandidatesHandler,
});

export const applyPlatformSecretRekey = internalMutation({
  args: rekeyPlatform.applyPlatformSecretRekeyArgs,
  returns: rekeyPlatform.applyPlatformSecretRekeyReturns,
  handler: rekeyPlatform.applyPlatformSecretRekeyHandler,
});

export const listManagedMigrationRekeyCandidates = internalQuery({
  args: rekeyPlatform.listManagedMigrationRekeyCandidatesArgs,
  returns: rekeyPlatform.listManagedMigrationRekeyCandidatesReturns,
  handler: rekeyPlatform.listManagedMigrationRekeyCandidatesHandler,
});

export const applyManagedMigrationRekey = internalMutation({
  args: rekeyPlatform.applyManagedMigrationRekeyArgs,
  returns: rekeyPlatform.applyManagedMigrationRekeyReturns,
  handler: rekeyPlatform.applyManagedMigrationRekeyHandler,
});

/**
 * Re-encrypt bindings still on an older key. INTERNAL ACTION — decrypts.
 *
 * Idempotent and resumable: run it until `rekeyed` comes back 0. A row it
 * cannot open (a v1 envelope, or one written under a key no longer configured)
 * is counted as `unreadable` and left alone rather than destroyed — the owner
 * rebinds that one. `skipped` is the benign race: the row changed underneath
 * the pass.
 */
export const rekeyStorageBindings = internalAction({
  args: { limit: v.optional(v.number()) },
  returns: validators.rekeyStorageBindingsReturns,
  handler: async (ctx, args): Promise<RekeyResult> => {
    const keyset = requireKeyset();
    const limit = Math.min(Math.max(args.limit ?? REKEY_BATCH_SIZE, 1), 200);

    const found: RekeyCandidates = await ctx.runQuery(
      internal.functions.storage.listRekeyCandidates,
      { currentKeyId: keyset.current.id, limit },
    );

    let rekeyed = 0;
    let skipped = 0;
    let unreadable = found.unreadable;
    for (const candidate of found.candidates) {
      const context = { workspaceId: candidate.workspaceId as string };
      let plaintext: string;
      try {
        plaintext = await decryptSecret(candidate.envelope, keyset, context);
      } catch {
        // Nothing configured can open it. Counted, never deleted.
        unreadable += 1;
        continue;
      }
      const applied: boolean = await ctx.runMutation(
        internal.functions.storage.applyRekey,
        {
          bindingId: candidate.bindingId,
          field: candidate.field,
          expectedEnvelope: candidate.envelope,
          envelope: await encryptSecret(plaintext, keyset, context),
        },
      );
      if (applied) rekeyed += 1;
      else skipped += 1;
    }

    // The workspace data keys, in the same pass and under the same budget, so
    // that "run it until it reports nothing left" stays one instruction. An
    // operator who has to remember a second command is an operator who
    // eventually does not, and the cost of forgetting this one is somebody's
    // encrypted notes rather than a credential they can re-enter.
    const dataKeys: DataKeyRekeyCandidates = await ctx.runQuery(
      internal.functions.storage.listDataKeyRekeyCandidates,
      { currentKeyId: keyset.current.id, limit },
    );

    let dataKeysRekeyed = 0;
    let dataKeysSkipped = 0;
    let dataKeysUnreadable = dataKeys.unreadable;
    for (const candidate of dataKeys.candidates) {
      const context = { workspaceId: candidate.workspaceId as string };
      let material: string;
      try {
        material = await decryptSecret(candidate.envelope, keyset, context);
      } catch {
        // Counted loudly and never deleted. This row is the only copy of the
        // key that opens a context's notes.
        dataKeysUnreadable += 1;
        continue;
      }
      const applied: boolean = await ctx.runMutation(
        internal.functions.storage.applyDataKeyRekey,
        {
          rowId: candidate.rowId,
          expectedEnvelope: candidate.envelope,
          envelope: await encryptSecret(material, keyset, context),
        },
      );
      if (applied) dataKeysRekeyed += 1;
      else dataKeysSkipped += 1;
    }

    // The connected mailboxes' Gmail tokens — a different table from
    // `storageBindings`, so `listRekeyCandidates` above never sees them. This
    // is the same class of miss `encryptedDataKey` was before its own pass
    // existed, and it gets the same fix: a dedicated candidate query, wired in
    // here, not merely a column name added to a list somewhere.
    const googleConnections: GoogleConnectionRekeyCandidates =
      await ctx.runQuery(
        internal.functions.storage.listGoogleConnectionRekeyCandidates,
        { currentKeyId: keyset.current.id, limit },
      );

    let googleConnectionsRekeyed = 0;
    let googleConnectionsSkipped = 0;
    let googleConnectionsUnreadable = googleConnections.unreadable;
    for (const candidate of googleConnections.candidates) {
      const context = { workspaceId: candidate.workspaceId as string };
      let plaintext: string;
      try {
        plaintext = await decryptSecret(candidate.envelope, keyset, context);
      } catch {
        googleConnectionsUnreadable += 1;
        continue;
      }
      const applied: boolean = await ctx.runMutation(
        internal.functions.storage.applyGoogleConnectionRekey,
        {
          connectionId: candidate.connectionId,
          field: candidate.field,
          expectedEnvelope: candidate.envelope,
          envelope: await encryptSecret(plaintext, keyset, context),
        },
      );
      if (applied) googleConnectionsRekeyed += 1;
      else googleConnectionsSkipped += 1;
    }

    // The agent's model account. A fourth table, so a fourth walk — wired in
    // here rather than only named in `ROTATED_ENVELOPE_COLUMNS`, because a
    // column listed as rotated whose table this pass never visits is the exact
    // shape of the `encryptedDataKey` miss.
    const providerCredentials: ProviderCredentialRekeyCandidates =
      await ctx.runQuery(
        internal.functions.storage.listProviderCredentialRekeyCandidates,
        { currentKeyId: keyset.current.id, limit },
      );

    let providerCredentialsRekeyed = 0;
    let providerCredentialsSkipped = 0;
    let providerCredentialsUnreadable = providerCredentials.unreadable;
    for (const candidate of providerCredentials.candidates) {
      const context = { workspaceId: candidate.workspaceId as string };
      let plaintext: string;
      try {
        plaintext = await decryptSecret(candidate.envelope, keyset, context);
      } catch {
        providerCredentialsUnreadable += 1;
        continue;
      }
      const applied: boolean = await ctx.runMutation(
        internal.functions.storage.applyProviderCredentialRekey,
        {
          rowId: candidate.rowId,
          expectedEnvelope: candidate.envelope,
          envelope: await encryptSecret(plaintext, keyset, context),
        },
      );
      if (applied) providerCredentialsRekeyed += 1;
      else providerCredentialsSkipped += 1;
    }

    // And the platform's own credentials. Losing these is an outage rather than
    // data loss — an operator re-enters them — but a rotation that cannot be
    // finished without one is a rotation nobody performs, which is the state
    // this pass exists to end.
    const platform: PlatformSecretRekeyCandidates = await ctx.runQuery(
      internal.functions.storage.listPlatformSecretRekeyCandidates,
      { currentKeyId: keyset.current.id, limit },
    );

    let platformSecretsRekeyed = 0;
    let platformSecretsSkipped = 0;
    let platformSecretsUnreadable = platform.unreadable;
    const platformContext = { platform: "integration" as const };
    for (const candidate of platform.candidates) {
      let value: string;
      try {
        value = await decryptSecret(
          candidate.envelope,
          keyset,
          platformContext,
        );
      } catch {
        platformSecretsUnreadable += 1;
        continue;
      }
      const applied: boolean = await ctx.runMutation(
        internal.functions.storage.applyPlatformSecretRekey,
        {
          rowId: candidate.rowId,
          expectedEnvelope: candidate.envelope,
          envelope: await encryptSecret(value, keyset, platformContext),
        },
      );
      if (applied) platformSecretsRekeyed += 1;
      else platformSecretsSkipped += 1;
    }

    const managedMigrations: ManagedMigrationRekeyCandidates =
      await ctx.runQuery(
        internal.functions.storage.listManagedMigrationRekeyCandidates,
        { currentKeyId: keyset.current.id, limit },
      );
    let managedMigrationsRekeyed = 0;
    let managedMigrationsSkipped = 0;
    let managedMigrationsUnreadable = managedMigrations.unreadable;
    for (const candidate of managedMigrations.candidates) {
      const context = { workspaceId: candidate.workspaceId as string };
      let plaintext: string;
      try {
        plaintext = await decryptSecret(candidate.envelope, keyset, context);
      } catch {
        managedMigrationsUnreadable += 1;
        continue;
      }
      const applied: boolean = await ctx.runMutation(
        internal.functions.storage.applyManagedMigrationRekey,
        {
          rowId: candidate.rowId,
          expectedEnvelope: candidate.envelope,
          envelope: await encryptSecret(plaintext, keyset, context),
        },
      );
      if (applied) managedMigrationsRekeyed += 1;
      else managedMigrationsSkipped += 1;
    }

    return {
      rekeyed,
      skipped,
      unreadable,
      dataKeysRekeyed,
      dataKeysSkipped,
      dataKeysUnreadable,
      googleConnectionsRekeyed,
      googleConnectionsSkipped,
      googleConnectionsUnreadable,
      providerCredentialsRekeyed,
      providerCredentialsSkipped,
      providerCredentialsUnreadable,
      platformSecretsRekeyed,
      platformSecretsSkipped,
      platformSecretsUnreadable,
      managedMigrationsRekeyed,
      managedMigrationsSkipped,
      managedMigrationsUnreadable,
    };
  },
});

export const getStorageBinding = query({
  args: bindingView.getStorageBindingArgs,
  returns: bindingView.getStorageBindingReturns,
  handler: bindingView.getStorageBindingHandler,
});

/** Ask this bucket where the storage-layout migration got to, and run nothing. See `./lib/storage/bindingActions.ts`. */
export const observeStorageLayout = mutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({ queued: v.boolean() }),
  handler: bindingActions.observeStorageLayoutHandler,
});

/** Check an existing binding again, without re-supplying the credential. See `./lib/storage/bindingActions.ts`. */
export const reverifyStorage = mutation({
  args: { workspaceId: v.id("workspaces") },
  returns: validators.reverifyStorageReturns,
  handler: bindingActions.reverifyStorageHandler,
});

/** Re-probe a binding that predates a capability field, so the field reaches it. See `./lib/storage/bindingActions.ts`. */
export const sweepUnprobedCapabilities = internalMutation({
  args: {},
  returns: v.object({ queued: v.number() }),
  handler: bindingActions.sweepUnprobedCapabilitiesHandler,
});

/** Forget the credential. See `./lib/storage/bindingActions.ts`. */
export const disconnectStorage = mutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({ disconnected: v.boolean() }),
  handler: bindingActions.disconnectStorageHandler,
});
