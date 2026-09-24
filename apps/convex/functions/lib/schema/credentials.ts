import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Sealed secrets with their own lifetimes: a model provider key, a managed
 * storage move's destination, and the workspace data keys and their rotation.
 *
 * One slice of the control-plane schema, spread into `defineSchema` by
 * `apps/convex/schema.ts` in declaration order. Metadata only — see that
 * file's header.
 */
export const credentialTables = {
  /**
   * The model account the agent spends, one row per provider per workspace.
   *
   * The customer's own Anthropic or OpenAI key, so the bill is theirs and we
   * add nothing to it. It is a credential in exactly the sense non-negotiable
   * #1 means, and it is held the way `storageBindings` holds an S3 secret:
   * an envelope from `encryptSecret`, bound by AAD to this workspace, never
   * returned by a client-callable function and never logged.
   *
   * **`fingerprint` is a hash and not a prefix.** `appSecrets` settled that
   * already — "what appears in a screenshot is not a fragment of the real
   * value" — and it matters more here, because this key was issued by somebody
   * else's console and a leaked fragment is a clue to a credential we do not
   * control. The console shows which provider is connected and when; it never
   * shows part of the key.
   *
   * There is no base URL either, and no `compatible` provider yet: a URL the
   * gateway attaches a key to needs the loopback and private-network refusals
   * `storage.ts` already applies to a bucket endpoint, and the request it
   * would feed does not exist yet. See `functions/providers.ts`.
   *
   * There is no `selected` column. Which provider answers is a question about
   * the agent, not about the credential, and a boolean here would let two rows
   * both claim it.
   */
  providerCredentials: defineTable({
    workspaceId: v.id("workspaces"),
    provider: v.union(v.literal("anthropic"), v.literal("openai")),
    /** An envelope from `encryptSecret`. Never plaintext, never returned. */
    encryptedApiKey: v.string(),
    /** SHA-256 of the key, first 8 hex. For support, never for display as a key. */
    fingerprint: v.string(),
    connectedBy: v.id("users"),
    connectedAt: v.number(),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_workspace_provider", ["workspaceId", "provider"]),

  /**
   * A paid copy from customer-owned storage into a managed bucket.
   *
   * The source binding remains live until copy and verification finish. Its
   * id is pinned so a reconnect during the copy makes cutover fail closed.
   * The destination credential is workspace-bound encrypted metadata and is
   * never returned by a public function.
   */
  managedStorageMigrations: defineTable({
    workspaceId: v.id("workspaces"),
    sourceBindingId: v.id("storageBindings"),
    targetEndpoint: v.string(),
    targetBucket: v.string(),
    targetAccessKeyId: v.string(),
    encryptedTargetSecretAccessKey: v.string(),
    status: v.union(v.literal("copying"), v.literal("failed")),
    phase: v.union(
      v.literal("count"),
      v.literal("copy"),
      v.literal("verify_source"),
      v.literal("verify_target"),
    ),
    cursor: v.optional(v.string()),
    objectsCopied: v.number(),
    /** Stable denominator measured before the first copy pass. */
    objectsTotal: v.optional(v.number()),
    /** Cursor-independent progress within the current phase. */
    objectsProcessedInPhase: v.optional(v.number()),
    changesInPass: v.number(),
    readyToCutover: v.optional(v.boolean()),
    errorCode: v.optional(v.string()),
    startedBy: v.id("users"),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_workspace", ["workspaceId"]),

  /**
   * THE KEY(S) THAT OPEN ONE CONTEXT'S ENCRYPTED NOTES.
   *
   * See `docs/decisions/encryption.md`. **One *live* row per workspace, plus
   * zero or more retired ones** — this used to be exactly one row per
   * workspace, and grew a second shape when workspace-key rotation shipped:
   * `retiredAt` is `undefined` on the single current row and a timestamp on
   * every generation a rotation has moved past. Each row holds the workspace
   * data key as a `v2:` envelope from `functions/lib/crypto.ts` — the same
   * scheme, the same keyset, the same AAD binding and the same rotation pass
   * (`STORAGE_SECRET_ENCRYPTION_KEY`'s, not this table's own) as the bucket
   * credential beside it. Never in the clear here, never in Markdown, never in
   * the customer's bucket, never in a log — except the owner's own deliberate
   * export.
   *
   * **Its own table rather than a column on `storageBindings`, and that is not
   * tidiness.** A customer who rebinds storage — a new bucket, a new provider,
   * a reconnected Dropbox — replaces their binding row. A key living on it
   * would take every note they had already encrypted with it, silently, in the
   * one flow whose entire purpose is that the notes come with them. The key
   * that opens a context outlives the storage those notes happen to sit in.
   *
   * `generation` is the label a note's own frontmatter carries
   * (`context_encryption_key: ws:k1`) and each envelope recipient's `id`. It
   * is what makes a key rotation a resumable re-wrap — a listing finds what is
   * still on the old generation — rather than a re-encrypt of every note in
   * somebody's bucket.
   *
   * **A retired row is never deleted by this codebase.** A note this
   * deployment has not yet re-wrapped — including one restored from bucket
   * versioning, or written by a client syncing the bucket directly while a
   * rotation was mid-walk — still names an old generation, and purging that
   * generation's row would make such a note permanently unreadable. See
   * "Rotation" in `docs/decisions/encryption.md` for the grace-period policy
   * this leaves as a deliberate, manual, future operator action rather than an
   * automatic sweep.
   *
   * **Nothing may write different key material into an existing row.** A
   * second key over the first makes every note already encrypted under it
   * unreadable, and it would look exactly like a fix for "the key was
   * missing". The two writers that exist are `applyDataKeyRekey`, which
   * re-seals the *same* material under a new envelope key, conditional on the
   * exact bytes it read — the `STORAGE_SECRET_ENCRYPTION_KEY` rotation pass,
   * which must reach this column, because an envelope left behind on a
   * retired envelope key is that same unrecoverable loss arriving from the
   * other side — and `startWorkspaceKeyRotation`, which only ever *inserts* a
   * new row with fresh, random material and *patches* `retiredAt` on the row
   * it supersedes; it never rewrites `encryptedDataKey` on an existing row.
   */
  workspaceDataKeys: defineTable({
    workspaceId: v.id("workspaces"),
    generation: v.string(),
    encryptedDataKey: v.string(),
    /**
     * Set the moment a rotation supersedes this generation with a new one.
     * `undefined` on the workspace's current generation — the one `encryptNote`
     * writes with — and on every workspace that has never rotated, which is
     * every workspace before this field existed.
     */
    retiredAt: v.optional(v.number()),
    createdAt: v.number(),
  }).index("by_workspace", ["workspaceId"]),

  /**
   * ONE WORKSPACE-KEY ROTATION, IN PROGRESS OR DONE.
   *
   * See "Rotation" in `docs/decisions/encryption.md`. This table's only job is
   * the guard a rotation needs and a single `workspaceDataKeys` row cannot
   * give it: **at most one rotation may be in progress for a workspace at a
   * time.** `startWorkspaceKeyRotation` re-reads under its own mutation before
   * inserting a second one, exactly the same race-safety
   * `insertDataKeyIfAbsent` already relies on for a workspace's very first key.
   *
   * The actual re-wrap walk — which notes are done, which are left — is
   * **not** tracked here, and is not tracked anywhere else either: there is no
   * cursor, in this table, in the bucket, or in a file. Each note carries its
   * own generation in its own frontmatter, so "already done" is read off the
   * note rather than off a second piece of state that could go stale, and a
   * walk that is idempotent by construction (`rewrapWorkspaceRecipient` is
   * safe to call twice) needs no cursor to be resumable — only a boolean
   * saying whether one may be *started*. This table is that boolean, shared
   * across every Worker isolate and every client, which the bucket alone
   * cannot be: two racing gateways would both find no rotation under way and
   * both try to mint a new generation.
   *
   * What that costs is in `docs/decisions/encryption.md` under "Rotation" and
   * is real: every call re-lists the bucket, and reads every note it examines.
   */
  workspaceKeyRotations: defineTable({
    workspaceId: v.id("workspaces"),
    fromGeneration: v.string(),
    toGeneration: v.string(),
    status: v.union(v.literal("in_progress"), v.literal("done")),
    startedAt: v.number(),
    completedAt: v.optional(v.number()),
  }).index("by_workspace", ["workspaceId"]),
};
