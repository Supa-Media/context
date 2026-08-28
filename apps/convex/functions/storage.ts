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
  envelopeKeyId,
  maskAccessKeyId,
  requireKeyset,
} from "./lib/crypto";
import { recordAudit } from "./lib/audit";
import { consumeRateLimit } from "./lib/rateLimit";
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

/**
 * The sealed row, as `getBindingRow` returns it.
 *
 * The S3 fields are optional because a Dropbox binding has none of them. What
 * used to be guaranteed by the type is now a per-provider check at the two
 * places that consume it, both of which refuse rather than half-build.
 */
export interface SealedBinding {
  provider: "r2" | "s3" | "b2" | "s3-compatible" | "dropbox";
  endpoint?: string;
  region?: string;
  bucket?: string;
  rootPrefix?: string;
  accessKeyId?: string;
  encryptedSecretAccessKey?: string;
  encryptedRefreshToken?: string;
  encryptedAccessToken?: string;
  accessTokenExpiresAt?: number;
  dropboxAccountId?: string;
  /** Absent means "let the adapter decide". See the schema for why. */
  forcePathStyle?: boolean;
  capabilities: StorageCapabilities;
  status: string;
}

/**
 * What the gateway gets: an opened credential that is complete.
 *
 * Spelled out rather than derived from `SealedBinding`, because the two stopped
 * being the same shape when Dropbox arrived. A *row* may be missing every S3
 * field; a credential handed to the gateway may not — `getBindingForGateway`
 * refuses a Dropbox row by name and narrows the rest before returning, so the
 * required fields here are a guarantee it has already made. Deriving this from
 * the row would push that guarantee onto every consumer as an optional-check
 * they would each get slightly wrong.
 */
export interface S3GatewayCredential {
  /**
   * A literal union, not `string`, so the two credential shapes actually
   * discriminate. With `string` here, `credential.provider === "dropbox"`
   * narrows nothing and every consumer sees a union it cannot take apart.
   */
  provider: "r2" | "s3" | "b2" | "s3-compatible";
  endpoint: string;
  region: string;
  bucket: string;
  rootPrefix?: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
  capabilities: StorageCapabilities;
  status: string;
}

/**
 * What a Dropbox-backed workspace hands the gateway.
 *
 * Deliberately a *different shape*, not the S3 one with holes in it. The
 * gateway's factory refuses a binding carrying a credential its provider does
 * not use, so a union here is what makes that refusal unreachable by accident
 * rather than something to remember.
 */
export interface DropboxGatewayCredential {
  provider: "dropbox";
  accessToken: string;
  rootPrefix?: string;
  capabilities: StorageCapabilities;
  status: string;
}

export type GatewayCredential = S3GatewayCredential | DropboxGatewayCredential;

/** One batch of envelopes still sealed under an older key. */
export interface RekeyCandidates {
  candidates: {
    bindingId: Id<"storageBindings">;
    workspaceId: Id<"workspaces">;
    field: EnvelopeField;
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
 * Is this endpoint/bucket pair one where nothing can tell path-style from
 * virtual-hosted addressing?
 *
 * **This must mean exactly what `S3Store`'s constructor means by it.** The
 * adapter refuses to guess when the endpoint's first host label is the bucket
 * name, because `https://my-context.s3.example` with bucket `my-context` is
 * either a virtual-hosted endpoint (the bucket is already in the host, so the
 * path must not repeat it) or a path-style endpoint that collides by
 * coincidence (`s3.wasabisys.com` with a bucket called `s3`,
 * `<account>.r2.cloudflarestorage.com` with a bucket named after the account).
 * Guessing wrong drops or adds a path segment, so the provider reads the first
 * *key* segment as the bucket and a write lands in a different bucket entirely,
 * silently.
 *
 * The point of duplicating the rule here is *when* it fires, not *whether*.
 * Left to the adapter alone it fires inside the connect probe, which cannot
 * throw usefully: the probe's job is to record a status, so the owner gets a
 * permanently-`error` binding and no way to say which addressing style they
 * meant. Checked at bind time it is a `ConvexError` naming both answers, on the
 * screen where the value would be typed.
 *
 * Two copies of a rule drift, so `__tests__/addressing.test.ts` pins this one
 * against the real `S3Store` constructor: for a matrix of endpoints and buckets
 * it asserts that this returns `true` exactly when constructing the adapter
 * without `forcePathStyle` throws.
 *
 * `URL` lowercases the hostname; the bucket is compared as given, which is the
 * same comparison `S3Store` makes.
 */
export function addressingIsAmbiguous(endpoint: string, bucket: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(endpoint).hostname;
  } catch {
    // Not a URL at all. `assertUsableEndpoint` is what reports that; there is
    // no addressing question to answer about a string that is not an endpoint.
    return false;
  }
  return hostname.startsWith(`${bucket}.`);
}

/**
 * The refusal, worded so the person can act on it without reading this file.
 *
 * It names the bucket (which they just typed, so it is not a disclosure) and
 * both possible answers. It carries **no** access key id and no secret — an
 * error string is the easiest place in a system for a credential to escape, and
 * this one is shown to a user and likely pasted into a support thread.
 */
function ambiguousAddressingError(
  bucket: string,
): ConvexError<{ code: string; message: string }> {
  return new ConvexError({
    code: "AMBIGUOUS_ADDRESSING",
    message:
      `The endpoint's first host label is the bucket name ("${bucket}"), so nothing ` +
      "can tell whether this bucket is addressed by host or by path. Set " +
      "forcePathStyle to false if the endpoint already contains the bucket " +
      `(virtual-hosted, e.g. https://${bucket}.s3.amazonaws.com), or to true if the ` +
      "bucket belongs in the path and the host merely starts with the same word.",
  });
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
    const bucket = args.bucket.trim();
    // Refuse the one configuration nothing downstream can resolve, here, while
    // there is still a person and a form to answer the question. Left to the
    // probe it becomes a permanently-`error` binding whose only documented cure
    // is re-pasting a credential that was never the problem.
    if (args.forcePathStyle === undefined && addressingIsAmbiguous(args.endpoint, bucket)) {
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
    forcePathStyle: v.optional(v.boolean()),
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
  binding: {
    accessKeyId?: string;
    encryptedSecretAccessKey?: string;
    encryptedRefreshToken?: string;
    encryptedAccessToken?: string;
  },
): string {
  let scrubbed = raw;
  // Every credential-shaped value the binding holds, whichever provider it is.
  // Listing them explicitly rather than iterating the row keeps a future
  // non-secret field from being redacted out of an error by accident, and a
  // future secret one from being missed — it has to be named here either way.
  for (const known of [
    binding.encryptedSecretAccessKey,
    binding.accessKeyId,
    binding.encryptedRefreshToken,
    binding.encryptedAccessToken,
  ]) {
    if (typeof known === "string" && known.length > 0) {
      scrubbed = scrubbed.split(known).join("[redacted]");
    }
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
    /**
     * The machine-readable companion to `error`. See the schema's `errorCode`
     * and `VerificationErrorCode` in `functions/provisioning.ts`.
     *
     * Not scrubbed, because it is not provider text: the caller picks it from a
     * closed set. A caller that puts a provider string in here is putting
     * unscrubbed text on a published surface — do not.
     */
    errorCode: v.optional(v.string()),
    /**
     * What the prober found in the bucket, and whether it wrote anything.
     *
     * Recorded here rather than computed on read because it is the *observed*
     * state of somebody else's bucket at a moment we had a credential — a query
     * cannot recompute it, and giving one the ability to would mean a public
     * function that opens a credential. See the schema for the closed set.
     *
     * Omitted leaves whatever is on the row, so a re-verification that fails
     * before it gets as far as looking does not erase what the last successful
     * one learned.
     */
    scaffolded: v.optional(v.boolean()),
    scaffoldReason: v.optional(v.string()),
    /**
     * Which keys of the chosen layout are still not in the bucket.
     *
     * Supplied only by a verification that actually attempted a scaffold. A
     * look-only probe omits it, which leaves the previous attempt's list
     * standing — that list is the record of what we still owe this bucket, and
     * it is what lets `applyStructure` tell a scaffold of ours that stopped
     * halfway from a vault that was here before we arrived. Erasing it because
     * a re-verification wandered past would strand the owner.
     */
    scaffoldMissing: v.optional(v.array(v.string())),
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
      errorCode: args.ok ? undefined : args.errorCode,
      scaffolded: args.scaffolded ?? binding.scaffolded,
      scaffoldReason: args.scaffoldReason ?? binding.scaffoldReason,
      scaffoldMissing: args.scaffoldMissing ?? binding.scaffoldMissing,
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
 * Record what a walk of the bucket counted. Internal, and separate from
 * `recordVerification` on purpose.
 *
 * They are two different observations, and folding the count into the status
 * write made the status wait on it. The walk is up to forty sequential LIST
 * round trips against somebody else's bucket; with both in one write, all of
 * that sat inside the window where the binding still read `unverified`, and an
 * action that died mid-walk left a perfectly good bucket permanently unverified
 * over a number nobody was waiting for.
 *
 * So the status lands first and this follows. A count that never arrives simply
 * never calls this, which is also why there is no "clear the count" path here:
 * absence is expressed by not calling, and the row keeps what the last real
 * walk found. See `noteCount.ts` for why absent must never become zero.
 */
export const recordNoteCount = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    notes: v.number(),
    truncated: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const binding = await ctx.db
      .query("storageBindings")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .unique();
    // Disconnected or rebound while we were walking. The count describes a
    // bucket this row no longer names, so it is dropped rather than written.
    if (binding === null) return null;

    await ctx.db.patch(binding._id, {
      noteCount: args.notes,
      // Stamped from the walk that produced it, never from the last
      // verification that happened to succeed.
      noteCountedAt: Date.now(),
      noteCountTruncated: args.truncated,
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
      endpoint: v.optional(v.string()),
      region: v.optional(v.string()),
      bucket: v.optional(v.string()),
      rootPrefix: v.optional(v.string()),
      accessKeyId: v.optional(v.string()),
      encryptedSecretAccessKey: v.optional(v.string()),
      // The Dropbox columns. Absent from this validator, Convex strips them
      // from the row and the gateway path reads a connection that looks
      // incomplete — which is exactly how this was found.
      encryptedRefreshToken: v.optional(v.string()),
      encryptedAccessToken: v.optional(v.string()),
      accessTokenExpiresAt: v.optional(v.number()),
      dropboxAccountId: v.optional(v.string()),
      forcePathStyle: v.optional(v.boolean()),
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
      encryptedRefreshToken: binding.encryptedRefreshToken,
      encryptedAccessToken: binding.encryptedAccessToken,
      accessTokenExpiresAt: binding.accessTokenExpiresAt,
      dropboxAccountId: binding.dropboxAccountId,
      forcePathStyle: binding.forcePathStyle,
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
      capabilities: v.object({ conditionalWrite: v.boolean() }),
      status: v.string(),
    }),
    v.object({
      provider: v.literal("dropbox"),
      accessToken: v.string(),
      rootPrefix: v.optional(v.string()),
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
      const accessToken = await dropboxAccessToken(ctx, args.workspaceId, binding);
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

/**
 * A usable Dropbox access token, refreshing if the cached one is near expiry.
 *
 * A plain function rather than its own action, deliberately: an internal
 * action here would be a *fourth* enumerated way to reach a decrypted
 * credential, and `__tests__/structure.test.ts` is right that each one needs
 * the scrutiny `getBindingForGateway` got. This does the same work inside the
 * function that already holds that permission, so the blast radius does not
 * grow.
 *
 * ## Refreshed on a clock, not on a 401
 *
 * Finding out a token expired by failing a customer's read is a worse way to
 * learn it: the read has already gone out, it surfaces as a storage outage,
 * and the retry costs a round trip somebody is waiting on. Dropbox access
 * tokens are short by design, so the expiry is stored and consulted, with a
 * minute of margin for a request that takes a moment to arrive.
 */
const ACCESS_TOKEN_MARGIN_MS = 60_000;

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
    refreshToken = await decryptSecret(binding.encryptedRefreshToken, keyset, context);
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

  let refreshed;
  try {
    refreshed = await refreshDropboxToken({ clientId, refreshToken });
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
      encryptedAccessToken: await encryptSecret(refreshed.accessToken, keyset, context),
      accessTokenExpiresAt: refreshed.expiresAt,
      encryptedRefreshToken: refreshed.refreshToken
        ? await encryptSecret(refreshed.refreshToken, keyset, context)
        : undefined,
    } as never,
  );

  return refreshed.accessToken;
}

/**
 * Persist a refreshed pair.
 *
 * Conditional on the binding still being Dropbox: a workspace rebound to a
 * bucket mid-refresh must not have Dropbox tokens written back onto it.
 */
export const recordDropboxRefresh = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    encryptedAccessToken: v.string(),
    accessTokenExpiresAt: v.number(),
    encryptedRefreshToken: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const binding = await ctx.db
      .query("storageBindings")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .unique();
    if (binding === null || binding.provider !== "dropbox") return null;

    await ctx.db.patch(binding._id, {
      encryptedAccessToken: args.encryptedAccessToken,
      accessTokenExpiresAt: args.accessTokenExpiresAt,
      // Dropbox rotates the refresh token only sometimes. Writing `undefined`
      // over a good one would lose the grant entirely, so it is patched only
      // when a replacement actually arrived.
      ...(args.encryptedRefreshToken
        ? { encryptedRefreshToken: args.encryptedRefreshToken }
        : {}),
      updatedAt: Date.now(),
    });
    return null;
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

/**
 * Every field on a binding that holds an encrypted envelope.
 *
 * **A binding no longer has exactly one secret.** An S3 binding has the bucket
 * secret; a Dropbox binding has a refresh token and a cached access token, and
 * no bucket secret at all. Rotation walks this list rather than one hardcoded
 * field, because a rotation that silently skipped a field would leave those
 * envelopes readable only by a key the operator is about to delete — the
 * failure would not appear until the customer's next read, long after the
 * pass reported success.
 *
 * Adding a fourth encrypted field means adding it here. There is a test that
 * fails if a schema field matching `encrypted*` is missing from this list, so
 * the coupling is enforced rather than remembered.
 */
export const ENVELOPE_FIELDS = [
  "encryptedSecretAccessKey",
  "encryptedRefreshToken",
  "encryptedAccessToken",
] as const;

export type EnvelopeField = (typeof ENVELOPE_FIELDS)[number];

const envelopeFieldValidator = v.union(
  v.literal("encryptedSecretAccessKey"),
  v.literal("encryptedRefreshToken"),
  v.literal("encryptedAccessToken"),
);

/** Envelopes written under some other key id, one row per envelope. */
export const listRekeyCandidates = internalQuery({
  args: { currentKeyId: v.string(), limit: v.number() },
  returns: v.object({
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
  }),
  handler: async (ctx, args) => {
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
    field: envelopeFieldValidator,
    expectedEnvelope: v.string(),
    envelope: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
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
          field: candidate.field,
          expectedEnvelope: candidate.envelope,
          envelope: await encryptSecret(plaintext, keyset, context),
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
      endpoint: v.optional(v.string()),
      region: v.optional(v.string()),
      bucket: v.optional(v.string()),
      rootPrefix: v.optional(v.string()),
      maskedAccessKeyId: v.optional(v.string()),
      forcePathStyle: v.optional(v.boolean()),
      capabilities: v.object({ conditionalWrite: v.boolean() }),
      status: v.string(),
      lastVerifiedAt: v.optional(v.number()),
      lastError: v.optional(v.string()),
      /**
       * A code from a closed set, so a client can branch on the failure
       * without matching on provider prose. See the schema's `errorCode`.
       */
      errorCode: v.optional(v.string()),
      /**
       * WHAT ONBOARDING BRANCHES ON.
       *
       * `scaffoldReason === "existing-context"` means this bucket already holds
       * a context: say so and use it, and do **not** ask which folder layout
       * they want. `"empty"` is the only value that makes that question worth
       * asking. See the schema for the full set.
       *
       * Both absent until something has verified the binding. Neither is a
       * credential, a key name, or note content — `scaffolded` is a boolean we
       * computed and `scaffoldReason` is a code from a closed set we chose, so
       * neither can carry provider text.
       */
      scaffolded: v.optional(v.boolean()),
      scaffoldReason: v.optional(v.string()),
      /**
       * WHAT IS STILL NOT THERE, WHEN `scaffoldReason` IS `partial`.
       *
       * A layout whose `privacy.md` landed and whose `3-resources/README.md`
       * did not is a working context with a gap, and this is the gap: bucket
       * keys, ours, generated. Say so plainly and offer to try again — do not
       * dress a `partial` up as a failure, and do not hide it either. Empty or
       * absent means nothing is outstanding.
       */
      scaffoldMissing: v.optional(v.array(v.string())),
      /**
       * HOW MANY NOTES, AND WHEN SOMETHING LAST LOOKED.
       *
       * All three absent until a verification has walked the bucket, **and
       * absent to everyone but the owner.**
       *
       * The count is of every Markdown file in the bucket, private ones
       * included, while a member of somebody else's context may read only the
       * `team` tier. Handing them the total would let them derive exactly how
       * much they are not being shown — an exact private-note count for a
       * person who deliberately shared a subset. Roles clamp what a client may
       * *read* in three places already; this is the same rule applied to a
       * number about the same notes.
       *
       * A client must render nothing rather than a zero when they are absent —
       * see the schema. `noteCountTruncated` means `noteCount` is a floor; say
       * "40,000+", never "40,000".
       */
      noteCount: v.optional(v.number()),
      noteCountedAt: v.optional(v.number()),
      noteCountTruncated: v.optional(v.boolean()),
      updatedAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;
    const { membership } = await requireWorkspaceAccess(ctx, args.workspaceId, userId);
    const isOwner = membership.role === "owner";

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
      // Absent for Dropbox, which has no access key. `undefined` rather than
      // an empty string, so the console renders nothing instead of a masked
      // credential that does not exist.
      maskedAccessKeyId: binding.accessKeyId
        ? maskAccessKeyId(binding.accessKeyId)
        : undefined,
      forcePathStyle: binding.forcePathStyle,
      capabilities: binding.capabilities,
      status: binding.status,
      lastVerifiedAt: binding.lastVerifiedAt,
      lastError: binding.lastError,
      errorCode: binding.errorCode,
      scaffolded: binding.scaffolded,
      scaffoldReason: binding.scaffoldReason,
      scaffoldMissing: binding.scaffoldMissing,
      // Owner only. See the validator above: this is a number about private
      // notes, and a member of this context cannot read them.
      noteCount: isOwner ? binding.noteCount : undefined,
      noteCountedAt: isOwner ? binding.noteCountedAt : undefined,
      noteCountTruncated: isOwner ? binding.noteCountTruncated : undefined,
      updatedAt: binding.updatedAt,
    };
  },
});

/**
 * How often one workspace may ask us to talk to its bucket again.
 *
 * The endpoint is a URL a customer typed, and re-verifying makes us issue an
 * outbound HTTPS request to it. Unlimited, that is a request amplifier pointed
 * at somebody else's infrastructure with our egress IP on it, and a way to keep
 * an action runtime busy for `REQUEST_TIMEOUT_MS` at a time.
 *
 * Keyed by **workspace**, not by user, because the workspace is what has an
 * endpoint. Keying it to the person would let two owners of a shared context
 * double the rate against one bucket, and would throttle an owner of five
 * contexts for checking each of them once.
 *
 * A handful an hour is far more than a person clicking "check again" needs, and
 * far less than a useful probe rate. `lib/rateLimit.ts` counts successful
 * mutations in a fixed window, so the true worst case is `limit * 2` across a
 * window boundary; at this size that does not matter.
 */
const REVERIFY_LIMIT = 6;
const REVERIFY_WINDOW_MS = 60 * 60 * 1000;

/**
 * Check an existing binding again, without re-supplying the credential.
 *
 * ## Why this has to exist
 *
 * Verification used to be scheduled from exactly one place — `applyBinding` —
 * so a single transient failure (a DNS blip, a provider having a minute, a
 * bucket policy fixed thirty seconds later) left the row `error` forever, and
 * the only documented cure was to paste the secret access key again. That is
 * both terrible and *dangerous*: it trains people to re-enter a credential to
 * fix problems that have nothing to do with the credential, which is exactly
 * the habit a phishing page wants them to have.
 *
 * ## Why it is a mutation that schedules rather than an action that probes
 *
 * `verifyStorageBinding` decrypts. Anything that **calls** it has a decrypted
 * credential in its own scope, which `__tests__/structure.test.ts` forbids for a
 * public function — correctly, because the return value of a call flows back to
 * the caller. Scheduling is a different edge: the scheduler discards the job's
 * result and there is no channel back to whoever queued it, so this function
 * can *cause* a probe without ever being able to see a credential. Nothing here
 * returns anything the probe learns; the outcome shows up where it belongs, on
 * the row, via `getStorageBinding`.
 *
 * Being a mutation also makes the rate limit real: `consumeRateLimit` writes,
 * and it commits in the same transaction as the scheduled job, so a refused
 * request queues nothing and a queued probe is always counted.
 *
 * ## Why every status is allowed
 *
 * `error` is the obvious one. `unverified` matters because the original probe
 * can be lost (a deploy mid-flight, a scheduler failure) and there would
 * otherwise be nothing to re-run it. `connected` matters because a re-check of
 * a binding we *believe* is healthy is exactly what someone does when the
 * gateway starts failing — and because a credential revoked at the provider
 * still reads `connected` here until something asks.
 *
 * The status is deliberately **not** reset to `unverified` while the probe
 * runs. Doing that would make a currently-working binding unusable to the
 * gateway (`isUsable` accepts only `connected`) for the duration of a check the
 * owner ran precisely because things were working.
 *
 * Owner-only, for the same reason `bindStorage` is: it is an action on the
 * workspace's credential and it spends the workspace's budget.
 */
export const reverifyStorage = mutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({
    queued: v.boolean(),
    /**
     * The status *before* the probe. The probe has not run yet — it cannot
     * have, it is scheduled — so anything else here would be a guess. Watch
     * `getStorageBinding` for the outcome.
     */
    status: v.string(),
  }),
  handler: async (ctx, args) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;
    await requireWorkspaceRole(ctx, args.workspaceId, userId, "owner");

    const binding = await ctx.db
      .query("storageBindings")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .unique();
    if (binding === null) {
      throw new ConvexError({
        code: "NO_STORAGE_BINDING",
        message: "This workspace has no storage binding to check.",
      });
    }

    // Counted before the schedule, in the same transaction: a refusal throws
    // and rolls the whole thing back, so a probe is never queued uncounted and
    // a count never survives a probe that was not queued.
    await consumeRateLimit(ctx, {
      key: `storage.reverify:${args.workspaceId}`,
      limit: REVERIFY_LIMIT,
      windowMs: REVERIFY_WINDOW_MS,
    });

    await ctx.scheduler.runAfter(
      0,
      internal.functions.provisioning.verifyStorageBinding,
      { workspaceId: args.workspaceId, actorUserId: userId },
    );

    await recordAudit(ctx, {
      workspaceId: args.workspaceId,
      actorUserId: userId,
      action: "storage.reverify_requested",
      // The status we are checking from, which is the interesting part of the
      // event. No endpoint, no key id, no secret.
      details: { fromStatus: binding.status },
    });

    return { queued: true, status: binding.status };
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

    // A Dropbox disconnect also disables the grant at Dropbox — otherwise we
    // forget our copy of the credential while the authorization lives on in
    // the person's account, and their next connect silently auto-approves
    // instead of asking. Scheduled, not called: this public mutation must not
    // reach the decrypt. Best-effort, and the envelope travels in the args
    // because the row is deleted on the next line.
    if (binding.provider === "dropbox" && binding.encryptedRefreshToken !== undefined) {
      await ctx.scheduler.runAfter(0, internal.functions.dropboxConnect.revokeDropboxGrant, {
        workspaceId: args.workspaceId,
        encryptedRefreshToken: binding.encryptedRefreshToken,
      });
    }

    await ctx.db.delete(binding._id);
    await recordAudit(ctx, {
      workspaceId: args.workspaceId,
      actorUserId: userId,
      action: "storage.disconnected",
      details: { provider: binding.provider, bucket: binding.bucket ?? null },
    });
    return { disconnected: true };
  },
});
