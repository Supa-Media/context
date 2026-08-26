import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { supaAuthTables } from "@supa-media/convex/schema";

/**
 * Control-plane schema for Context.
 *
 * METADATA ONLY. Note content lives exclusively in the customer's own bucket
 * (see CLAUDE.md, "The customer owns the storage"). Nothing in this file may
 * ever hold Markdown, note bodies, attachment bytes, or a second copy of
 * anyone's context. If a future table looks like it wants to cache note text,
 * that is the wrong table.
 *
 * ## Why not `supaTenantTables({ tenantName: "workspace" })`
 *
 * The framework's generic tenant tables give `workspaces` + `userWorkspaces`
 * with `slug: v.optional(v.string())`, `role: v.optional(v.string())`, and a
 * `workspaceId: v.string()` foreign key (the helper cannot emit `v.id()` for a
 * table name it only knows at runtime). Context needs the opposite of all
 * three: the slug is *required* and globally unique because it is how a
 * context is addressed (`@name/1-projects/foo.md`), the role is *required*
 * because write access is never implied, and the foreign keys must be real
 * `v.id()` references so a mis-scoped read is a type error rather than a
 * runtime surprise. Those are security properties, not cosmetics, so the
 * tables are declared explicitly here. `supaAuthTables` is still the framework
 * base — only the tenant half diverges. If the framework later grows a tenant
 * helper that can express required slugs and typed ids, this should move back
 * upstream.
 */
const schema = defineSchema({
  ...supaAuthTables,

  /**
   * ONE global namespace shared by usernames and workspace slugs.
   *
   * `@lk` (a person) and `@shared-thing` (a workspace) are addressed
   * identically in `@name/path`, so they cannot be allowed to collide. Keeping
   * both kinds in a single table makes that structural: a claim is a row, and
   * the uniqueness check is one lookup rather than two that could race past
   * each other.
   *
   * `name` is always the normalized form (see `functions/lib/names.ts`).
   */
  names: defineTable({
    name: v.string(),
    kind: v.union(v.literal("user"), v.literal("workspace")),
    /** Set when `kind === "user"`. */
    userId: v.optional(v.id("users")),
    /** Set when `kind === "workspace"`. */
    workspaceId: v.optional(v.id("workspaces")),
    claimedBy: v.id("users"),
    claimedAt: v.number(),
  })
    .index("by_name", ["name"])
    .index("by_workspace", ["workspaceId"])
    .index("by_user", ["userId"]),

  /**
   * A workspace is the unit that owns a context: one storage binding, one
   * privacy manifest, one audit trail, one set of grants.
   *
   * A personal context is a workspace with a single `owner` member. A shared
   * context is the same row with more members. There is deliberately no
   * separate "personal context" table — see CLAUDE.md, "The workspace model".
   */
  workspaces: defineTable({
    /** Normalized, globally unique, also present as a row in `names`. */
    slug: v.string(),
    displayName: v.string(),
    createdBy: v.id("users"),
    kind: v.union(v.literal("personal"), v.literal("shared")),
    /**
     * Which folder scaffold the gateway lays down on first connect. Purely a
     * setup hint — the tools operate on paths, not on a fixed taxonomy, and a
     * `custom` workspace is not second-class.
     */
    structureTemplate: v.union(v.literal("para"), v.literal("custom")),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_slug", ["slug"]),

  /**
   * Membership carries an explicit role. Read access and write access to
   * someone else's context are different grants; write is never implied.
   *
   * owner  — full control, including storage rebinding and revoking anyone's grant
   * editor — read + write notes
   * member — read only
   */
  workspaceMembers: defineTable({
    workspaceId: v.id("workspaces"),
    userId: v.id("users"),
    role: v.union(v.literal("owner"), v.literal("editor"), v.literal("member")),
    invitedBy: v.optional(v.id("users")),
    joinedAt: v.number(),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_user", ["userId"])
    .index("by_workspace_user", ["workspaceId", "userId"]),

  /**
   * The customer's bucket credential.
   *
   * KEYED BY `workspaceId`, NEVER `userId`. A binding belongs to the context,
   * not to the person who happened to paste the key — otherwise every shared
   * context becomes a migration instead of a row.
   *
   * `rootPrefix` is optional and is applied at the storage-adapter boundary
   * only. It is NOT tenancy: we never namespace keys inside a customer bucket,
   * so a bucket that already looks like a Context brain connects unchanged.
   *
   * `encryptedSecretAccessKey` is an opaque envelope produced by
   * `functions/lib/crypto.ts` (`v2:<key-id>:<iv-b64>:<ciphertext-b64>`). The
   * plaintext secret is never stored, never returned by a public function, and
   * is decrypted only by an internal function serving the gateway. The
   * envelope is bound to this row's `workspaceId` as AES-GCM additional
   * authenticated data, so moving it to another workspace's row makes it
   * undecryptable rather than portable.
   */
  storageBindings: defineTable({
    workspaceId: v.id("workspaces"),
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
    encryptedSecretAccessKey: v.string(),
    /**
     * Probed at connect time, not assumed. R2 and AWS S3 support conditional
     * writes; B2 and Wasabi do not reliably. We degrade honestly rather than
     * silently dropping conflict detection.
     */
    capabilities: v.object({ conditionalWrite: v.boolean() }),
    status: v.union(
      v.literal("unverified"),
      v.literal("connected"),
      v.literal("error"),
    ),
    lastVerifiedAt: v.optional(v.number()),
    /**
     * Provider-side failure text, truncated and scrubbed on the way in by
     * `recordVerification` — see the redaction there for exactly what is
     * enforced and what is only convention. Any member of the workspace can
     * read this field, so treat it as published.
     */
    lastError: v.optional(v.string()),
    boundBy: v.id("users"),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_workspace", ["workspaceId"]),

  /**
   * Fixed-window counters for the operations that must not be unbounded.
   *
   * Today that is workspace creation, because a workspace claims a name out of
   * a global namespace that has no release path — see `lib/rateLimit.ts` for
   * what this scheme does and does not protect against.
   *
   * Holds no identity of its own: the key is a caller-built string, and the
   * row carries a count and a timestamp and nothing else.
   */
  rateLimits: defineTable({
    key: v.string(),
    windowStartedAt: v.number(),
    count: v.number(),
  }).index("by_key", ["key"]),

  /**
   * MCP clients registered dynamically (RFC 7591). A client is a piece of
   * software, not a person and not a tenant — it grants nothing on its own.
   * Authority lives in `oauthGrants`.
   */
  oauthClients: defineTable({
    clientId: v.string(),
    clientName: v.string(),
    redirectUris: v.array(v.string()),
    /** `null` for public clients (PKCE, no secret to store). */
    hashedClientSecret: v.union(v.string(), v.null()),
    createdAt: v.number(),
  }).index("by_clientId", ["clientId"]),

  /**
   * One row per connected AI client, per user, per workspace — individually
   * revocable. Revoking ChatGPT must not log Claude out, which is why the
   * grant, not the user session, is the unit of authority.
   */
  oauthGrants: defineTable({
    workspaceId: v.id("workspaces"),
    userId: v.id("users"),
    clientId: v.string(),
    scopes: v.array(v.string()),
    /** Hash only. A raw refresh token never touches this database. */
    hashedRefreshToken: v.string(),
    status: v.union(v.literal("active"), v.literal("revoked")),
    lastUsedAt: v.optional(v.number()),
    createdAt: v.number(),
    revokedAt: v.optional(v.number()),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_user", ["userId"])
    .index("by_workspace_user", ["workspaceId", "userId"])
    .index("by_refresh_token", ["hashedRefreshToken"]),

  /**
   * Who did what, in which context.
   *
   * `actorUserId` records the acting identity, not just the scope — once
   * "team" is four people, `actorScope: "team"` tells you nothing. Both actor
   * fields are optional because some events have only one (a system job has no
   * client; a browser session has no client id).
   *
   * `details` is deliberately a flat record of scalars: it structurally cannot
   * carry a nested note body, and callers must never put a secret in it.
   */
  auditEvents: defineTable({
    workspaceId: v.id("workspaces"),
    actorUserId: v.optional(v.id("users")),
    actorClientId: v.optional(v.string()),
    action: v.string(),
    /** Bucket-relative paths the action touched. Paths, never content. */
    paths: v.array(v.string()),
    at: v.number(),
    details: v.optional(
      v.record(
        v.string(),
        v.union(v.string(), v.number(), v.boolean(), v.null()),
      ),
    ),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_workspace_at", ["workspaceId", "at"]),
});

export default schema;
