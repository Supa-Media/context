import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Creating resources in somebody else's Cloudflare account.
 *
 * One slice of the control-plane schema, spread into `defineSchema` by
 * `apps/convex/schema.ts` in declaration order. Metadata only — see that
 * file's header.
 */
export const provisioningTables = {
  /**
   * ONE IN-FLIGHT ATTEMPT TO CREATE A BUCKET IN SOMEBODY ELSE'S CLOUD ACCOUNT.
   *
   * A person who has a Cloudflare account but no bucket hands us one credential
   * powerful enough to act on that account; we create a bucket and mint an S3
   * key scoped to that one bucket, and what persists afterwards is exactly what
   * a manual connect would have left behind — a `storageBindings` row and
   * nothing else. This table exists only for the seconds in between.
   *
   * ## Why the setup credential is here at all, and why it leaves
   *
   * The credential that can create buckets can also mint further credentials,
   * so it is categorically more dangerous than the bucket key it produces. It
   * is written here **encrypted, bound to this workspace** for exactly one
   * reason: the flow is a public entry point that *schedules* an internal
   * action rather than calling one, so the plaintext cannot be handed across
   * that gap in memory (see CLAUDE.md, "Scheduling is not calling"). The
   * envelope is the only channel, and it is closed the moment it has been used:
   *
   *  - **succeeded** — the whole row is deleted in the same transaction that
   *    writes the binding. Success leaves no trace here on purpose; the
   *    binding is the record.
   *  - **failed** — `encryptedSetupCredential` is cleared and the row stays,
   *    carrying only `status`, `errorCode` and `error` so the owner can read
   *    what went wrong. A failed attempt must not keep hold of a credential
   *    that could create more buckets.
   *
   * There is therefore no `succeeded` status: a row here is pending or failed,
   * and a test asserts the table is empty after a successful run.
   *
   * ## Why failures are recorded here rather than on the binding
   *
   * Until the S3 key is minted there is no binding to record anything on — and
   * once there is one, a *new* provisioning attempt that fails must not flip a
   * working binding to `error`. The vocabulary deliberately mirrors
   * `storageBindings` (`status`, `errorCode`, `error`) so a console renders
   * both the same way; see `ProvisionErrorCode` in `functions/lib/cloudflare.ts`
   * for the closed set.
   */
  cloudflareProvisioning: defineTable({
    workspaceId: v.id("workspaces"),
    /** The owner who started it. Re-authorized at write time, never trusted. */
    requestedBy: v.id("users"),
    /**
     * Where the setup credential came from.
     *
     * Downstream they are identical — both are a `Bearer` value — so this is
     * recorded rather than branched on. `oauth` is in the union because
     * Cloudflare's third-party OAuth exists and this is where it lands; the
     * public entry point accepts only `api-token` today, and will keep
     * refusing `oauth` until the open questions in `lib/cloudflare.ts` are
     * closed. A literal in a schema is not a feature.
     */
    credentialSource: v.union(v.literal("api-token"), v.literal("oauth")),
    /**
     * The setup credential, AES-GCM sealed and bound to `workspaceId`.
     *
     * **Present only while `status` is `pending`.** Absent on every failed row
     * and on no successful one, because a successful row does not exist.
     */
    encryptedSetupCredential: v.optional(v.string()),
    /** The customer's Cloudflare account id. Configuration, not a secret. */
    accountId: v.string(),
    bucket: v.string(),
    jurisdiction: v.union(
      v.literal("default"),
      v.literal("eu"),
      v.literal("fedramp"),
    ),
    locationHint: v.optional(v.string()),
    status: v.union(v.literal("pending"), v.literal("failed")),
    /** A `ProvisionErrorCode`. Ours, from a closed set — never provider text. */
    errorCode: v.optional(v.string()),
    /**
     * Human-readable failure text: our sentence, plus Cloudflare's own detail
     * redacted of the setup credential and truncated. Readable by every member
     * of the workspace, so treat it as published.
     */
    error: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    /**
     * When this row's *present* state stops being current.
     *
     * Two meanings, one field, because a row only ever has one deadline:
     * while `pending` it is the moment the attempt is abandoned — the sweep
     * marks it failed and destroys the sealed credential — and once `failed`
     * it is the moment the record itself is deleted.
     *
     * **The pending half is a credential control, not housekeeping.** Without
     * it, an attempt whose action never ran leaves an account-level Cloudflare
     * credential sealed on this row forever, which contradicts the invariant
     * this table exists to keep (CLAUDE.md, "The setup credential is not a
     * stored credential") and blocks the owner from starting another attempt.
     *
     * Optional because rows written before the sweep existed have no deadline,
     * and the honest reading of a missing one is "already expired": a pending
     * row from before this field is exactly the stuck row it was added for.
     */
    expiresAt: v.optional(v.number()),
  })
    .index("by_workspace", ["workspaceId"])
    /** For the sweep, and for nothing else — same reasoning as `oauthAuthorizations`. */
    .index("by_expiresAt", ["expiresAt"]),
};
