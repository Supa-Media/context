import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * What the platform itself holds: render assets, tree signals, the audit
 * trails, search index bookkeeping, and integration secrets.
 *
 * One slice of the control-plane schema, spread into `defineSchema` by
 * `apps/convex/schema.ts` in declaration order. Metadata only — see that
 * file's header.
 */
export const platformTables = {
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
  /**
   * Assets the *product* needs, in our own storage rather than a customer's.
   *
   * Exactly one row today: the card renderer's wasm. It is here because Convex
   * bundles JavaScript and not a package's `.wasm`, so a `require.resolve` of it
   * deploys cleanly and throws at runtime — and 3.15 MB of base64 in a source
   * module is the alternative.
   *
   * **Nothing customer-owned belongs in this table.** Their bytes live in their
   * bucket; that is non-negotiable #1. This is a build artifact of ours that
   * happens to need somewhere to sit.
   */
  renderAssets: defineTable({
    kind: v.literal("resvgWasm"),
    storageId: v.id("_storage"),
    updatedAt: v.number(),
  }),

  /**
   * A wasm install in progress, in pieces. Empty except during one.
   *
   * Exists because `convex run` cannot take 3.15 MB of base64 in an argument
   * and has no stdin form — see `installWasm`. Rows are deleted the moment they
   * are assembled.
   */
  renderAssetChunks: defineTable({
    index: v.number(),
    total: v.number(),
    chunk: v.bytes(),
  }),

  /**
   * When each audience of a workspace last saw its file tree change. See
   * `lib/treeAudiences.ts` for why it is per audience, and `treeSignals.ts`.
   *
   * No path, no count, no content: one timestamp per (workspace, audience),
   * where an audience is `private`, `team` or an `@name`. It is a hint that a
   * client's tree is stale — the client then asks the bucket, through the same
   * filters as every read — never a record of what changed.
   */
  treeSignals: defineTable({
    workspaceId: v.id("workspaces"),
    audience: v.string(),
    at: v.number(),
  }).index("by_workspace_audience", ["workspaceId", "audience"]),

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

  /**
   * Whether a context's search is served from a database Supa Media owns, and
   * which one.
   *
   * ## A row exists only because somebody asked for one
   *
   * **There is no row for a context that has not opted in.** Not a row with
   * `optedIn: false` — no row. That is the difference between a table of
   * every customer's preference and a table of the customers who said yes,
   * and it is the shape that makes "we hold a derived copy of your notes only
   * where you asked us to" checkable by counting rows.
   *
   * A row appears when an owner turns the switch on and is **deleted**, along
   * with the database it names, when they turn it off. A switch labelled off
   * that leaves the derived copy in place is the switch not working.
   *
   * ## What this is not
   *
   * Not a storage binding. `storageBindings` points at the customer's own
   * bucket, holds their credential, and is the canonical store; this points at
   * a database *we* own holding a disposable derivative, and holds no customer
   * credential at all. Deleting every row here costs a rebuild and loses
   * nothing (CLAUDE.md, "Plain files stay canonical"). Deleting a storage
   * binding disconnects somebody's workspace.
   *
   * The reasoning for the two-condition gate is in `functions/lib/fastSearch.ts`.
   */
  searchIndexes: defineTable({
    workspaceId: v.id("workspaces"),
    /**
     * Which product contract created this derivative.
     *
     * Rows written before Premium launched have no generation and are never
     * served. A paid opt-in replaces their remote coordinates and provisions a
     * fresh database in the customer-data account; the files remain canonical.
     */
    generation: v.optional(v.literal("premium-v1")),
    /**
     * The owner's answer, and the reason the row exists.
     *
     * Stored rather than implied by the row's existence because the two come
     * apart for exactly one moment: an opt-out that has written the row's
     * intent but not yet finished deleting the remote database. A reader
     * during that window must serve the R2 index, and `optedIn: false` is how
     * it knows to.
     */
    optedIn: v.boolean(),
    /** Who turned it on, and when. Recorded because it is a consent decision. */
    optedInBy: v.id("users"),
    optedInAt: v.number(),
    /**
     * `provisioning` → creating the remote database and applying the schema.
     * `backfilling` → schema applied, notes still being projected.
     * `ready`       → serving.
     * `failed`      → provisioning did not complete; `error` says why.
     * `releasing`   → opted out, database not yet deleted. Serves nothing.
     */
    status: v.union(
      v.literal("provisioning"),
      v.literal("backfilling"),
      v.literal("ready"),
      v.literal("failed"),
      v.literal("releasing"),
    ),
    /**
     * Cloudflare's uuid for the database, once it exists.
     *
     * Configuration, not a secret: reaching it still requires the API token,
     * which lives in `appSecrets` and never here. Absent until created, and
     * the thing a release has to delete — a row that loses this before the
     * remote database is gone is a database nothing will ever clean up, which
     * is why `releasing` keeps it until the delete succeeds.
     */
    databaseId: v.optional(v.string()),
    databaseName: v.optional(v.string()),
    /** The projection schema version applied, for forward migrations. */
    schemaVersion: v.optional(v.number()),
    /** Ours, from a closed set — never a provider's text. */
    errorCode: v.optional(v.string()),
    /** Operator-facing detail, shown to the owner. Never a credential. */
    error: v.optional(v.string()),
    /** Backfill progress, so the settings screen can be honest about it. */
    notesIndexed: v.optional(v.number()),
    notesPending: v.optional(v.number()),
    /**
     * Where provisioning the managed bucket has got to, for the one context
     * this plan is for.
     *
     * On the plan rather than on the binding, because until it succeeds there
     * *is* no binding — and the screen that has to say "creating your storage"
     * is looking at somebody who has paid and has nothing yet. Absent is the
     * ordinary state: a context that never bought managed storage has no
     * answer here and needs none.
     *
     * `failed` is the state that has to exist. Without it the console can only
     * wait, and a person who paid two minutes ago cannot tell a slow webhook
     * from a bucket that will never appear.
     */
    managedProvisioning: v.optional(
      v.union(v.literal("running"), v.literal("ready"), v.literal("failed")),
    ),
    /**
     * Why it failed, from **our** closed set — never Cloudflare's text, which
     * can name an account. The console maps it to a sentence and a next step.
     */
    managedProvisioningError: v.optional(v.string()),
    /** When the last attempt ended, so a retry can be rate-limited by a human. */
    managedProvisioningAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspace", ["workspaceId"])
    /** For the sweep that finishes releases and retries failures. */
    .index("by_status", ["status"]),

  /**
   * What staff did on the platform, as opposed to what a member did in a
   * context.
   *
   * Deliberately **not** `auditEvents`. That table is a customer-facing record
   * scoped to one workspace, readable by that workspace's members and shown in
   * their console; an admin setting a Stripe key belongs to neither a
   * workspace nor a customer, and folding it in would either make
   * `workspaceId` optional — weakening every per-workspace query that relies
   * on it being present — or attribute a platform act to whichever context
   * happened to be on screen.
   *
   * The rule the two tables share: **paths and names, never values.** A row
   * here records that `SEARCH_D1_API_TOKEN` was set and by whom. It never
   * records what it was set to, and the fingerprint is the most this table
   * will ever carry of a secret.
   */
  adminAuditEvents: defineTable({
    actorUserId: v.id("users"),
    /** The address that matched the allowlist, kept for a readable trail. */
    actorEmail: v.string(),
    /** A closed vocabulary — see `functions/admin.ts`. */
    action: v.string(),
    /** The secret's name, a metric name, a workspace slug. Never a value. */
    subject: v.optional(v.string()),
    at: v.number(),
    details: v.optional(
      v.record(
        v.string(),
        v.union(v.string(), v.number(), v.boolean(), v.null()),
      ),
    ),
  })
    .index("by_at", ["at"])
    .index("by_actor_at", ["actorUserId", "at"]),

  /**
   * Integration credentials the platform itself holds.
   *
   * Not a customer's credential — those are `storageBindings`, bound to a
   * workspace and openable in that workspace's row alone. These belong to
   * Context.LC: the Cloudflare token that provisions search databases, a
   * payment provider's key, a mail provider's key. One row per name.
   *
   * ## What may never live here
   *
   * **`STORAGE_SECRET_ENCRYPTION_KEY` and `GATEWAY_SECRET` stay environment
   * variables, permanently.** The first is the key these envelopes are sealed
   * with, so storing it here is a safe whose combination is written inside it;
   * the second is what proves a caller is the gateway, and the gateway must be
   * able to authenticate before any database read is trusted. Anything that
   * has to exist *before* this table can be read cannot be kept in it.
   * `functions/admin.ts` enforces that as a refused name rather than a comment.
   *
   * ## Write-only, structurally
   *
   * `encryptedValue` is an AES-GCM envelope bound to the `integration` scope
   * (`lib/crypto.ts`). No public function may reach `decryptSecret` — that is
   * `__tests__/structure.test.ts`, and it is what makes "the console can set a
   * secret but never read one back" a property of the codebase rather than a
   * habit of its screens. The admin UI renders `fingerprint`, which is
   * computed at write time from the plaintext and is not reversible.
   */
  appSecrets: defineTable({
    /**
     * The environment-variable-style name, e.g. `SEARCH_D1_API_TOKEN`.
     * Uppercase, digits and underscores; validated on write, unique by index.
     */
    name: v.string(),
    /**
     * `v2:<key-id>:<iv>:<ciphertext>`, bound to the `integration` scope.
     *
     * Named `encrypted*` deliberately, and not for style:
     * `__tests__/structure.test.ts` derives `SCHEMA_ENCRYPTED_FIELDS` by
     * matching that prefix, and forbids any of them appearing in a public
     * function's `returns:` validator "with nobody needing to remember". A
     * column called `value` sits outside that promise — inert today, since
     * these functions declare no return validator, and a trap the moment one
     * does.
     */
    encryptedValue: v.string(),
    /**
     * First 8 hex characters of SHA-256 over the plaintext.
     *
     * Enough to confirm that the value you pasted is the value that landed,
     * and to tell two credentials apart, without being the credential. Not a
     * prefix or a last-four of the secret itself: those are fragments of the
     * real thing, and this needs to be safe to render on a screen and put in
     * a log line.
     */
    fingerprint: v.string(),
    /** What this is for, shown in the console. Never the value. */
    description: v.optional(v.string()),
    updatedBy: v.id("users"),
    updatedAt: v.number(),
    createdAt: v.number(),
  }).index("by_name", ["name"]),
};
