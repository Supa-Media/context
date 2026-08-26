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
 * `getStorageBinding` returns status and a masked access key id and nothing
 * else. If you are adding a function that returns `encryptedSecretAccessKey`
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
  CredentialCryptoError,
  decryptSecret,
  encryptSecret,
  envelopeKeyId,
  maskAccessKeyId,
  requireKeyset,
} from "./lib/crypto";
import { recordAudit } from "./lib/audit";
import { redactSigningArtifacts } from "./lib/verification";
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

/** One batch of rows still sealed under an older key. */
export interface RekeyCandidates {
  candidates: {
    bindingId: Id<"storageBindings">;
    workspaceId: Id<"workspaces">;
    envelope: string;
  }[];
  unreadable: number;
}

/** What one re-encrypt pass moved. */
export interface RekeyResult {
  rekeyed: number;
  skipped: number;
  unreadable: number;
}

/**
 * Hostnames and literal addresses that are not somewhere on the public
 * internet.
 *
 * The endpoint is a URL an owner supplies and something of ours later makes a
 * request to — the connect probe today, the gateway afterwards. That makes it
 * an SSRF sink: `https://169.254.169.254/…` is the cloud instance-metadata
 * service, `https://localhost:8080/…` and `https://10.0.0.5/…` are whatever
 * else is reachable from the machine running the probe. "The owner chose it"
 * is not a defense, because the owner is not who the request is made *as*.
 *
 * This is a literal-address filter, not a resolution-time one. A hostname that
 * resolves to a private address still passes here, and DNS rebinding still
 * beats any check made at this layer — whichever component ultimately performs
 * the request has to enforce its own egress policy. What this does buy is that
 * the obvious form of the attack cannot simply be typed into the connect form.
 */
const BLOCKED_HOST_PATTERNS: ReadonlyArray<RegExp> = [
  /^localhost$/i,
  /\.localhost$/i,
  /\.local$/i,
  /\.internal$/i,
  /^127(\.\d{1,3}){3}$/, // loopback
  /^0(\.\d{1,3}){3}$/, // "this host"
  /^10(\.\d{1,3}){3}$/, // RFC 1918
  /^192\.168(\.\d{1,3}){2}$/, // RFC 1918
  /^172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}$/, // RFC 1918
  /^169\.254(\.\d{1,3}){2}$/, // link-local, including instance metadata
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])(\.\d{1,3}){2}$/, // RFC 6598 CGNAT
];

/** IPv6 literals arrive from `URL` bracketed and lowercased. */
function isBlockedIpv6(hostname: string): boolean {
  if (!hostname.startsWith("[")) return false;
  const address = hostname.slice(1, -1);
  return (
    address === "::1" || // loopback
    address === "::" || // unspecified
    /^f[cd][0-9a-f]{2}:/.test(address) || // fc00::/7 unique-local
    /^fe[89ab][0-9a-f]:/.test(address) // fe80::/10 link-local
  );
}

/**
 * Reject an endpoint that would send the credential somewhere unencrypted, that
 * is not an absolute URL at all, or that points back inside our own network.
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

  const hostname = parsed.hostname.toLowerCase();
  const blocked =
    isBlockedIpv6(hostname) ||
    BLOCKED_HOST_PATTERNS.some((pattern) => pattern.test(hostname));
  if (blocked) {
    throw new ConvexError({
      code: "INVALID_ENDPOINT",
      message:
        "The storage endpoint must be a public address, not a loopback, link-local, or private-network one.",
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
      { workspaceId: args.workspaceId, actorUserId: args.actorUserId },
    );

    return { bindingId, status: "unverified" };
  },
});

/**
 * How much provider failure text we keep.
 *
 * `lastError` is readable by every member of the workspace and is written by
 * whatever performed the probe, so it is an untrusted string on a published
 * surface. A cap stops an unbounded provider response (or a deliberately
 * enormous one) from being stored and served, and keeps the field to the size
 * of the thing it is for: one line a human can act on.
 */
const MAX_LAST_ERROR_LENGTH = 300;

/**
 * Redact the credential-shaped fragments we can actually recognize.
 *
 * The schema used to claim `lastError` "never contains the secret" with nothing
 * enforcing it. This enforces what is enforceable and no more, which is worth
 * being precise about:
 *
 *  - The **access key id** and the **stored envelope** are values we hold, so
 *    an error echoing them is detectable and gets replaced.
 *  - A signing artifact (`Signature=…`, `Credential=…`, `X-Amz-Security-Token=…`)
 *    is recognizable by shape, so it goes too — S3 error bodies quote the
 *    canonical request, and that is the realistic way one leaks.
 *  - The **plaintext secret** is not something this mutation holds; it exists
 *    only inside `bindStorage` and inside the gateway. It cannot be scrubbed
 *    here by matching, so the rule that the caller must not put it in an error
 *    string remains a rule. Truncation limits the blast radius; it does not
 *    remove it.
 */
function scrubProviderError(
  raw: string,
  binding: { accessKeyId: string; encryptedSecretAccessKey: string },
): string {
  let scrubbed = raw;
  for (const known of [binding.encryptedSecretAccessKey, binding.accessKeyId]) {
    if (known.length > 0) scrubbed = scrubbed.split(known).join("[redacted]");
  }
  // Shared with the verifying action, which applies the same rule to the value
  // it returns. Two redactors that drifted apart would mean one published
  // surface quietly became the weak one.
  scrubbed = redactSigningArtifacts(scrubbed);
  return scrubbed.length > MAX_LAST_ERROR_LENGTH
    ? `${scrubbed.slice(0, MAX_LAST_ERROR_LENGTH - 1)}…`
    : scrubbed;
}

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
      lastError: args.ok
        ? undefined
        : scrubProviderError(args.error ?? "Verification failed", binding),
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
      capabilities: binding.capabilities,
      status: binding.status,
    };
  },
});

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
// ---------------------------------------------------------------------------

/** How many bindings one `rekeyStorageBindings` pass moves. */
const REKEY_BATCH_SIZE = 50;

/** Bindings whose envelope was written under some other key id. */
export const listRekeyCandidates = internalQuery({
  args: { currentKeyId: v.string(), limit: v.number() },
  returns: v.object({
    candidates: v.array(
      v.object({
        bindingId: v.id("storageBindings"),
        workspaceId: v.id("workspaces"),
        envelope: v.string(),
      }),
    ),
    /** Rows in a format no configured key can open — v1, or corrupt. */
    unreadable: v.number(),
  }),
  handler: async (ctx, args) => {
    const bindings = await ctx.db.query("storageBindings").take(args.limit);
    const candidates = [];
    let unreadable = 0;
    for (const binding of bindings) {
      let keyId: string;
      try {
        keyId = envelopeKeyId(binding.encryptedSecretAccessKey);
      } catch {
        unreadable += 1;
        continue;
      }
      if (keyId === args.currentKeyId) continue;
      candidates.push({
        bindingId: binding._id,
        workspaceId: binding.workspaceId,
        envelope: binding.encryptedSecretAccessKey,
      });
    }
    return { candidates, unreadable };
  },
});

/**
 * Swap one envelope for an equivalent one under the current key.
 *
 * Conditional on the envelope we read: if the owner rebound storage while the
 * pass was running, the row already holds a *newer* credential under the
 * current key, and overwriting it with a re-encryption of the old one would
 * quietly restore a credential the customer just replaced.
 */
export const applyRekey = internalMutation({
  args: {
    bindingId: v.id("storageBindings"),
    expectedEnvelope: v.string(),
    encryptedSecretAccessKey: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const binding = await ctx.db.get(args.bindingId);
    if (binding === null) return false;
    if (binding.encryptedSecretAccessKey !== args.expectedEnvelope) return false;

    await ctx.db.patch(args.bindingId, {
      encryptedSecretAccessKey: args.encryptedSecretAccessKey,
      updatedAt: Date.now(),
    });
    // No actor: this is a maintenance pass, not a person. The credential and
    // the bucket are unchanged; only the key protecting it moved.
    await recordAudit(ctx, {
      workspaceId: binding.workspaceId,
      action: "storage.rekeyed",
    });
    return true;
  },
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
  returns: v.object({
    rekeyed: v.number(),
    skipped: v.number(),
    unreadable: v.number(),
  }),
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
          expectedEnvelope: candidate.envelope,
          encryptedSecretAccessKey: await encryptSecret(
            plaintext,
            keyset,
            context,
          ),
        },
      );
      if (applied) rekeyed += 1;
      else skipped += 1;
    }

    return { rekeyed, skipped, unreadable };
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
