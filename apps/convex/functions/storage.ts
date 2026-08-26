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
 *          → `encryptSecret`         AES-GCM envelope
 *          → `applyBinding`          envelope written to the row
 *          ...
 *   gateway → `getBindingForGateway` (INTERNAL action) envelope → plaintext
 *
 * There is deliberately no public path from the row back to the plaintext.
 * `getStorageBinding` returns status and a masked access key id and nothing
 * else. If you are adding a function that returns `encryptedSecretAccessKey`
 * to a client, you are building a credential-disclosure endpoint even though
 * the value looks opaque — an offline attack on a leaked key beats a value
 * that never left the server.
 */

import { ConvexError, v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { requireAuthId } from "@supa-media/convex/auth";
import { internal } from "../_generated/api";
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
  decryptSecret,
  encryptSecret,
  maskAccessKeyId,
  requireEncryptionKey,
} from "./lib/crypto";
import { recordAudit } from "./lib/audit";
import { requireWorkspaceAccess, requireWorkspaceRole } from "./lib/workspaceAuth";

const providerValidator = v.union(
  v.literal("r2"),
  v.literal("s3"),
  v.literal("b2"),
  v.literal("s3-compatible"),
);

/**
 * Providers whose conditional-write support we do not assume.
 *
 * R2 (`onlyIf: { etagMatches }`) and AWS S3 (`If-Match`) support it. B2 and
 * arbitrary S3-compatible endpoints do not reliably, so a new binding starts
 * with `conditionalWrite: false` and only a real probe at verification time
 * may turn it on. Optimistically claiming the capability would mean silently
 * dropping conflict detection — a lost write with no error, which is the one
 * failure mode a notes product cannot have.
 */
function initialCapabilities(): StorageCapabilities {
  return { conditionalWrite: false };
}

export interface StorageCapabilities {
  conditionalWrite: boolean;
}

/** What the binding write returns. Named so the action can annotate itself. */
export interface BindingResult {
  bindingId: Id<"storageBindings">;
  status: string;
}

/** The sealed row, as `getBindingRow` returns it. */
export interface SealedBinding {
  provider: string;
  endpoint: string;
  region: string;
  bucket: string;
  rootPrefix?: string;
  accessKeyId: string;
  encryptedSecretAccessKey: string;
  capabilities: StorageCapabilities;
  status: string;
}

/** What the gateway gets: the same row with the secret opened. */
export type GatewayCredential = Omit<
  SealedBinding,
  "encryptedSecretAccessKey"
> & { secretAccessKey: string };

/**
 * Reject an endpoint that would send the credential somewhere unencrypted, or
 * that is not an absolute URL at all.
 */
function assertUsableEndpoint(endpoint: string): void {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new ConvexError({
      code: "INVALID_ENDPOINT",
      message: "The storage endpoint must be an absolute URL.",
    });
  }
  if (parsed.protocol !== "https:") {
    throw new ConvexError({
      code: "INVALID_ENDPOINT",
      message: "The storage endpoint must use https.",
    });
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new ConvexError({
      code: "INVALID_ENDPOINT",
      message: "Credentials must not be embedded in the endpoint URL.",
    });
  }
}

/**
 * `rootPrefix` is a convenience for customers whose bucket holds other things
 * — it is applied at the adapter boundary and is invisible above it. It is
 * emphatically NOT tenancy, so it must never be derived from a workspace id.
 * Normalized to `foo/bar/` (no leading slash, one trailing slash).
 */
function normalizeRootPrefix(rootPrefix: string | undefined): string | undefined {
  if (rootPrefix === undefined) return undefined;
  const trimmed = rootPrefix.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (trimmed.length === 0) return undefined;
  if (trimmed.includes("..")) {
    throw new ConvexError({
      code: "INVALID_ROOT_PREFIX",
      message: "The root prefix must not contain '..'.",
    });
  }
  return `${trimmed}/`;
}

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
  args: {
    workspaceId: v.id("workspaces"),
    provider: providerValidator,
    endpoint: v.string(),
    region: v.string(),
    bucket: v.string(),
    rootPrefix: v.optional(v.string()),
    accessKeyId: v.string(),
    secretAccessKey: v.string(),
  },
  returns: v.object({ bindingId: v.id("storageBindings"), status: v.string() }),
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
    if (args.accessKeyId.trim().length === 0 || args.secretAccessKey.length === 0) {
      throw new ConvexError({
        code: "INVALID_CREDENTIAL",
        message: "Both an access key id and a secret access key are required.",
      });
    }
    const rootPrefix = normalizeRootPrefix(args.rootPrefix);

    const encryptedSecretAccessKey = await encryptSecret(
      args.secretAccessKey,
      requireEncryptionKey(),
    );

    return await ctx.runMutation(internal.functions.storage.applyBinding, {
      actorUserId: userId as Id<"users">,
      workspaceId: args.workspaceId,
      provider: args.provider,
      endpoint: args.endpoint,
      region: args.region,
      bucket: args.bucket.trim(),
      rootPrefix,
      accessKeyId: args.accessKeyId.trim(),
      encryptedSecretAccessKey,
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
  args: {
    actorUserId: v.id("users"),
    workspaceId: v.id("workspaces"),
    provider: providerValidator,
    endpoint: v.string(),
    region: v.string(),
    bucket: v.string(),
    rootPrefix: v.optional(v.string()),
    accessKeyId: v.string(),
    encryptedSecretAccessKey: v.string(),
  },
  returns: v.object({ bindingId: v.id("storageBindings"), status: v.string() }),
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
      capabilities: initialCapabilities(),
      status: "unverified" as const,
      // A rebind invalidates whatever we knew about the old bucket. Carrying
      // `lastVerifiedAt` forward would show a green check for a bucket nothing
      // has ever contacted.
      lastVerifiedAt: undefined,
      lastError: undefined,
      boundBy: args.actorUserId,
      updatedAt: now,
    };

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

    return { bindingId, status: "unverified" };
  },
});

/**
 * Record the outcome of an actual round trip to the customer's bucket.
 *
 * Internal, because only something that has genuinely talked to the provider
 * may set `connected` — a client-callable "mark me verified" would let a
 * broken binding claim to be healthy. The gateway calls this after its connect
 * probe, and passes the probed capabilities rather than assumptions.
 */
export const recordVerification = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    ok: v.boolean(),
    capabilities: v.optional(v.object({ conditionalWrite: v.boolean() })),
    error: v.optional(v.string()),
    actorUserId: v.optional(v.id("users")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const binding = await ctx.db
      .query("storageBindings")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .unique();
    if (binding === null) {
      throw new ConvexError({
        code: "NO_STORAGE_BINDING",
        message: "This workspace has no storage binding.",
      });
    }

    const now = Date.now();
    await ctx.db.patch(binding._id, {
      status: args.ok ? "connected" : "error",
      capabilities: args.capabilities ?? binding.capabilities,
      lastVerifiedAt: args.ok ? now : binding.lastVerifiedAt,
      // Clearing the error on success matters: a stale `lastError` next to a
      // green status is how support tickets get misdiagnosed.
      lastError: args.ok ? undefined : (args.error ?? "Verification failed"),
      updatedAt: now,
    });

    await recordAudit(ctx, {
      workspaceId: args.workspaceId,
      actorUserId: args.actorUserId,
      action: args.ok ? "storage.verified" : "storage.verification_failed",
      details: {
        conditionalWrite: (args.capabilities ?? binding.capabilities)
          .conditionalWrite,
      },
    });
    return null;
  },
});

/**
 * The binding row with the envelope still sealed. Internal.
 *
 * Split out from `getBindingForGateway` so the decrypting action can read the
 * row without an action-to-action hop, and so nothing that only needs
 * configuration ever has to touch the decryption path.
 */
export const getBindingRow = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.union(
    v.null(),
    v.object({
      provider: v.string(),
      endpoint: v.string(),
      region: v.string(),
      bucket: v.string(),
      rootPrefix: v.optional(v.string()),
      accessKeyId: v.string(),
      encryptedSecretAccessKey: v.string(),
      capabilities: v.object({ conditionalWrite: v.boolean() }),
      status: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const binding = await ctx.db
      .query("storageBindings")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .unique();
    if (binding === null) return null;
    return {
      provider: binding.provider,
      endpoint: binding.endpoint,
      region: binding.region,
      bucket: binding.bucket,
      rootPrefix: binding.rootPrefix,
      accessKeyId: binding.accessKeyId,
      encryptedSecretAccessKey: binding.encryptedSecretAccessKey,
      capabilities: binding.capabilities,
      status: binding.status,
    };
  },
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
  returns: v.union(
    v.null(),
    v.object({
      provider: v.string(),
      endpoint: v.string(),
      region: v.string(),
      bucket: v.string(),
      rootPrefix: v.optional(v.string()),
      accessKeyId: v.string(),
      secretAccessKey: v.string(),
      capabilities: v.object({ conditionalWrite: v.boolean() }),
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

    const secretAccessKey = await decryptSecret(
      binding.encryptedSecretAccessKey,
      requireEncryptionKey(),
    );

    return {
      provider: binding.provider,
      endpoint: binding.endpoint,
      region: binding.region,
      bucket: binding.bucket,
      rootPrefix: binding.rootPrefix,
      accessKeyId: binding.accessKeyId,
      secretAccessKey,
      capabilities: binding.capabilities,
      status: binding.status,
    };
  },
});

/**
 * What the dashboard is allowed to see: is it connected, to what, and does it
 * support conditional writes.
 *
 * Any member may read this. Knowing that your context is healthy is not a
 * privileged operation, and hiding it from read-only members just means they
 * cannot tell a broken bucket from an empty one. The access key id is masked
 * and the secret is not present in any form.
 */
export const getStorageBinding = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.union(
    v.null(),
    v.object({
      provider: v.string(),
      endpoint: v.string(),
      region: v.string(),
      bucket: v.string(),
      rootPrefix: v.optional(v.string()),
      maskedAccessKeyId: v.string(),
      capabilities: v.object({ conditionalWrite: v.boolean() }),
      status: v.string(),
      lastVerifiedAt: v.optional(v.number()),
      lastError: v.optional(v.string()),
      updatedAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;
    await requireWorkspaceAccess(ctx, args.workspaceId, userId);

    const binding = await ctx.db
      .query("storageBindings")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .unique();
    if (binding === null) return null;

    return {
      provider: binding.provider,
      endpoint: binding.endpoint,
      region: binding.region,
      bucket: binding.bucket,
      rootPrefix: binding.rootPrefix,
      maskedAccessKeyId: maskAccessKeyId(binding.accessKeyId),
      capabilities: binding.capabilities,
      status: binding.status,
      lastVerifiedAt: binding.lastVerifiedAt,
      lastError: binding.lastError,
      updatedAt: binding.updatedAt,
    };
  },
});

/**
 * Forget the credential.
 *
 * Owner-only, and a hard delete rather than a `status: "disconnected"` flag —
 * "revoke the key and we're gone" has to mean the row is gone, not that we
 * kept an encrypted copy with a boolean promising not to use it. The
 * customer's bucket is untouched and every file in it still works.
 *
 * The audit row survives, because "storage was disconnected" is exactly the
 * kind of event you want to still see afterwards. It carries no credential.
 */
export const disconnectStorage = mutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({ disconnected: v.boolean() }),
  handler: async (ctx, args) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;
    await requireWorkspaceRole(ctx, args.workspaceId, userId, "owner");

    const binding = await ctx.db
      .query("storageBindings")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .unique();
    if (binding === null) return { disconnected: false };

    await ctx.db.delete(binding._id);
    await recordAudit(ctx, {
      workspaceId: args.workspaceId,
      actorUserId: userId,
      action: "storage.disconnected",
      details: { provider: binding.provider, bucket: binding.bucket },
    });
    return { disconnected: true };
  },
});
