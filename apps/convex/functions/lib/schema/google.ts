import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * A connected Google account, its sync runs, and its consent round trips.
 *
 * One slice of the control-plane schema, spread into `defineSchema` by
 * `apps/convex/schema.ts` in declaration order. Metadata only — see that
 * file's header.
 */
export const googleTables = {
  /**
   * ONE CONNECTED GOOGLE ACCOUNT. See `docs/decisions/communications.md`.
   *
   * **Generalized from a Gmail-only `mailConnections` row (2026-09-07) to one
   * Google account carrying one OAuth grant and any number of enabled
   * `products`** — Gmail, and (built by sibling work on this same shape)
   * Calendar and Chat. One consent, one refresh token, one place the account
   * identity lives; each product gets its own nested settings-and-cursor
   * object rather than its own table, because they share the grant, the
   * owner, and the disconnect/revoke story, and only differ in what they sync
   * and where their cursor lives.
   *
   * KEYED BY `workspaceId`, NEVER `userId` — same rule as `storageBindings`,
   * for the same reason: the connection belongs to the context, not to
   * whoever happened to click Connect. **Only a `kind: "personal"` workspace
   * may hold one** (`identity-and-access.md`, "Mail lands in a personal
   * context and nowhere else", which this generalizes to every product here)
   * — enforced in `functions/googleConnect.ts`, not here, because a schema
   * cannot see a sibling table's field.
   *
   * This is metadata about the connection, never product content. Gmail
   * messages are rendered by `packages/communications` straight into the
   * customer's own bucket at `0-inbox/email/<gmail.mailboxSlug>/`; nothing
   * here ever holds a subject, a body, a sender, or a calendar event's text.
   *
   * `encryptedRefreshToken` is a `v2:` envelope from `functions/lib/crypto.ts`,
   * bound to this row's `workspaceId` as AAD — identical scheme to
   * `storageBindings.encryptedRefreshToken`, and it rides the same rotation
   * pass (`listGoogleConnectionRekeyCandidates` / `applyGoogleConnectionRekey`
   * in `functions/storage.ts`). **The token stays at the top level, never
   * nested under a product**, because it is one grant covering every enabled
   * product — nesting it would either duplicate one token three ways or make
   * the rotation walk hunt through per-product objects for a column that is
   * the same secret in each. The gateway is handed a short-lived access token
   * to talk to Google and the refresh token never leaves the control plane —
   * same reasoning as the Dropbox grant one table over.
   */
  googleConnections: defineTable({
    workspaceId: v.id("workspaces"),
    provider: v.literal("google"),
    /** The address as the person knows it. Never a path segment; see `gmail.mailboxSlug`. */
    address: v.string(),
    encryptedRefreshToken: v.string(),
    encryptedAccessToken: v.optional(v.string()),
    accessTokenExpiresAt: v.optional(v.number()),
    /**
     * Every scope Google actually granted for this account, verbatim from the
     * token response — never assumed from what was requested. A downgraded
     * consent (the person unchecked something) is visible here rather than
     * discovered as a 403 three months later. Per-product scope slices live
     * on each product's own object below (`gmail.scopes`), computed from this
     * same verbatim list — two views of one fact, never two facts.
     */
    scopes: v.array(v.string()),
    /**
     * Whose Google account this is. Not a secret — it is what lets the console
     * show which account is connected and notice a reconnect landing on a
     * *different* account, the same role `dropboxAccountId` plays.
     */
    googleAccountId: v.string(),
    /**
     * Which products this connection actually syncs. A product appearing here
     * with no matching nested object below is a connection mid-setup, never a
     * steady state a reader should trust — `functions/googleConnect.ts` writes
     * both in the same mutation.
     */
    products: v.array(
      v.union(v.literal("gmail"), v.literal("calendar"), v.literal("chat")),
    ),
    /**
     * Gmail's own settings and cursor. Present iff `"gmail"` is in `products`.
     * See `docs/decisions/communications.md` for what each field argues.
     */
    gmail: v.optional(
      v.object({
        /**
         * The scopes relevant to Gmail specifically, sliced from the
         * account's own `scopes` at connect time — recorded per product,
         * verbatim, per the same rule the top-level field states.
         */
        scopes: v.array(v.string()),
        /**
         * `chooseMailboxSlug(address, taken)` from `packages/communications`,
         * decided once at connect time and never recomputed — recomputing it
         * against a different `taken` set would rename the folder a person's
         * mail is already in.
         */
        mailboxSlug: v.string(),
        /**
         * How far back the first backfill reaches, in days. Per-connection and
         * fixed at connect time: changing it later is a second backfill, not a
         * setting flip, so this is what a reconnect or "sync more" reads to
         * decide how far to widen.
         */
        backfillDays: v.number(),
        /**
         * Which Gmail system labels are synced. `spam` and `trash` are
         * deliberately never valid values here — v1 excludes both
         * unconditionally, argued in `docs/decisions/communications.md` — so
         * the type itself is the enforcement, not a runtime check elsewhere.
         */
        folders: v.array(v.union(v.literal("inbox"), v.literal("sent"))),
        /** Off by default. See "Retention: raw MIME is off by default". */
        storeRawMime: v.boolean(),
        /**
         * `"store"` is the working default per the owner's 2026-09-07
         * decision — an attachment a message references should land
         * somewhere referenceable in the bucket. `"metadata-only"` stays
         * available as the quota-conscious opt-out. See
         * `docs/decisions/communications.md`, "Attachments are fetched into
         * the bucket, retained on a timer".
         */
        attachmentMode: v.union(v.literal("metadata-only"), v.literal("store")),
        /**
         * Days an attachment's bytes stay in the bucket after being written,
         * or `"forever"` to never expire it. Per-connection, because the
         * right answer for a receipts inbox and a newsletter inbox differ.
         * Absent only for a row written before this field existed, and
         * `sweepExpiredAttachments` treats absent the same as the documented
         * 90-day default.
         */
        attachmentRetentionDays: v.optional(
          v.union(v.number(), v.literal("forever")),
        ),
        /**
         * Customer-visible folder where this mailbox's day notes and
         * attachments land. Absent on rows written before integration settings
         * existed, in which case the old canonical folder is used.
         */
        destinationFolder: v.optional(v.string()),
        /**
         * A hard ceiling on bytes this connection may write into the bucket
         * — note text and stored attachment bytes both — independent of the
         * customer's overall storage. Backfill and sync both refuse to write
         * past it rather than silently exceeding what the estimator showed
         * before the first fetch.
         */
        quotaBytes: v.number(),
        /**
         * Gmail's sync cursor (`historyId`), advanced after every page this
         * connection has fully processed. Absent until the first backfill
         * completes. A `404` from `history.list` means Gmail expired it —
         * sync treats that as `gapDetected` and falls back to a full
         * reconcile over `backfillDays`, per `docs/decisions/communications.md`.
         */
        historyId: v.optional(v.string()),
        lastSyncedAt: v.optional(v.number()),
      }),
    ),
    /**
     * Calendar's settings and incremental-sync cursor. Event content and the
     * per-account materialized cache stay in customer storage; this row keeps
     * only the `events.list` token and the owner-local date of the last full
     * rolling-horizon refresh.
     */
    calendar: v.optional(
      v.object({
        scopes: v.array(v.string()),
        destinationFolder: v.optional(v.string()),
        syncToken: v.optional(v.string()),
        /** Owner-local date of the last full horizon refresh. */
        lastFullSyncDate: v.optional(v.string()),
        lastSyncedAt: v.optional(v.number()),
      }),
    ),
    /**
     * Chat's own settings and cursor. Both `chat.messages.readonly` and
     * `chat.spaces.readonly` are restricted and sensitive scopes respectively
     * (`docs/decisions/communications.md`), so the CASA assessment gating
     * Gmail gates this too.
     *
     * Shaped differently from the `historyToken` placeholder this field
     * started as, because Chat's own sync module
     * (`apps/mcp/src/communications/googleChat/sync.js`) predates this table
     * and already settled the real shape: Chat pages `spaces.messages.list`
     * by `create_time` **per space**, so one account-wide cursor cannot
     * represent it — `cursors` is a map, keyed by the space's resource name,
     * and one space's failure never stalls another's. `spaceSettings` is a
     * console-facing per-space include/exclude/pause choice, absent for a
     * space that has never been touched (which reads as `"included"` —
     * `docs/decisions/communications.md`, "Default private", the same
     * "absent means the default" rule). `nonceSeed` is not a credential —
     * leaking it only weakens this connection's fence nonce
     * (`packages/communications/src/note.js`, "the nonce is why the fence is
     * worth anything"), never Google account access — so it is generated once
     * at connect time and stored in the clear rather than sealed, and
     * survives a reconnect for the same reason `gmail.mailboxSlug` does.
     */
    chat: v.optional(
      v.object({
        scopes: v.array(v.string()),
        spaceSettings: v.optional(
          v.record(
            v.string(),
            v.union(v.literal("excluded"), v.literal("paused")),
          ),
        ),
        cursors: v.optional(v.record(v.string(), v.string())),
        destinationFolder: v.optional(v.string()),
        nonceSeed: v.string(),
        lastSyncedAt: v.optional(v.number()),
      }),
    ),
    health: v.union(
      v.literal("connecting"),
      v.literal("backfilling"),
      v.literal("active"),
      v.literal("error"),
      v.literal("reconnect_required"),
    ),
    lastError: v.optional(v.string()),
    errorCode: v.optional(v.string()),
    /**
     * HOW OFTEN THIS ACCOUNT IS POLLED, AND WHEN IT IS NEXT DUE.
     *
     * The fields below are the whole scheduling state of the forward sync
     * loop (`functions/googleSync.ts`), and they are **per account, not per
     * product**: one Google account is one grant, so one pass mints one
     * access token and walks whichever products the row enables. A per-product
     * schedule would mint the same credential three times an hour to ask three
     * questions of the same account.
     *
     * They sit at the top level rather than inside `gmail` for that reason and
     * for one more: `nextSyncAt` is indexed, and an index over a field nested
     * inside an optional object is a shape this schema does not otherwise use.
     *
     *  - `syncIntervalMinutes` — the owner's choice, floored at
     *    `MIN_SYNC_INTERVAL_MINUTES` server-side. Absent means the default
     *    (`DEFAULT_SYNC_INTERVAL_MINUTES`), so a row written before this
     *    existed is scheduled rather than stalled.
     *  - `lastSyncAt` — when a pass last **finished**, successfully or not.
     *    Absent means this connection has never synced, which the console
     *    must be able to say out loud: "connected" and "syncing" looking
     *    identical is the defect this loop exists to close.
     *  - `nextSyncAt` — `lastSyncAt + interval`, materialized so the sweep can
     *    ask the index for due rows instead of reading every connection.
     *    Absent means due now, which is what a never-synced row is.
     *  - `syncStartedAt` — set when a pass is claimed, cleared when it
     *    reports. It is the not-overtaking guard: a pass still running is
     *    never started a second time until it has been silent long enough to
     *    be considered lost.
     *  - `lastSyncFailure*` — the last failure this connection had, kept
     *    **after** a later pass succeeds. `lastError` / `errorCode` describe
     *    the connection's health right now and are cleared by a good pass;
     *    somebody asking "did this break overnight?" is asking a different
     *    question, and clearing the answer is how it stopped being askable.
     */
    syncIntervalMinutes: v.optional(v.number()),
    lastSyncAt: v.optional(v.number()),
    nextSyncAt: v.optional(v.number()),
    syncStartedAt: v.optional(v.number()),
    lastSyncFailureAt: v.optional(v.number()),
    lastSyncFailureCode: v.optional(v.string()),
    lastSyncFailure: v.optional(v.string()),
    /**
     * The last pass ran out of history pages before it ran out of history.
     *
     * Gmail's `history.list` is paged and the walk is bounded, so a connection
     * whose cursor is weeks old cannot be caught up in one pass. The cursor
     * still moves — to the last record actually walked, never to the mailbox
     * head — and this says the interval must not be waited out, because the
     * pass already knows there is more. `isDue` reads it; a pass that finishes
     * clears it, which is what stops a connection being due forever.
     */
    syncCatchUp: v.optional(v.boolean()),
    /**
     * Consecutive failed passes, cleared by the first good one.
     *
     * The backoff ladder's input. A flat retry means a mailbox Google is
     * rate-limiting is asked again ~96 times a day, which is the request
     * pattern most likely to keep it rate-limited.
     */
    syncFailures: v.optional(v.number()),
    /**
     * Bytes the forward loop has written into the bucket for this connection.
     *
     * `gmail.quotaBytes` is a lifetime ceiling on what one connection may
     * write, and a ceiling with nothing counting against it is decoration. The
     * historical backfill counted on its run row; a forward loop has no run,
     * so the total lives here and every pass is handed it as
     * `bytesAlreadyUsed`.
     */
    syncBytesWritten: v.optional(v.number()),
    /**
     * Set by disconnect. The row is kept — never deleted outright — so a
     * disconnected connection's sync job can be told apart from one that
     * simply has not synced yet, and so the notes it already wrote are
     * traceable to a connection the console can still show as "disconnected"
     * rather than an account that quietly stopped and left no explanation.
     * The notes themselves are never touched by a disconnect.
     */
    disconnectedAt: v.optional(v.number()),
    boundBy: v.id("users"),
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
    /** One shared-note writer per workspace at a time. */
    .index("by_workspace_sync_started", ["workspaceId", "syncStartedAt"])
    /** One connection per address per context — the uniqueness `chooseMailboxSlug` assumes for Gmail. */
    .index("by_workspace_address", ["workspaceId", "address"])
    /**
     * The sweep's index: connections that are still connected, oldest due
     * first.
     *
     * `disconnectedAt` leads so a disconnected row is outside the range
     * entirely rather than filtered out after being read — a disconnected
     * connection with an old `nextSyncAt` would otherwise sit at the head of
     * every bounded batch forever and starve the live ones behind it.
     *
     * A row with no `nextSyncAt` sorts before every number, so a never-synced
     * connection is at the front of the queue rather than invisible to it.
     */
    .index("by_sync_due", ["disconnectedAt", "nextSyncAt"]),

  /**
   * User-visible Google sync work.
   *
   * A connection row says which account and products are authorized. It is not
   * a job ledger: calling an account "backfilling" because OAuth completed is
   * the production confusion this table closes. A run row is the thing a person
   * started, the unit a worker advances, and the progress the console renders.
   *
   * Counts are deliberately coarse. The actual message bodies live only in the
   * customer's bucket; Convex records service, days, bytes and safe error
   * codes, never mail subjects, chat text, calendar titles, or object paths.
   */
  googleSyncRuns: defineTable({
    workspaceId: v.id("workspaces"),
    connectionId: v.id("googleConnections"),
    requestedBy: v.id("users"),
    mode: v.literal("backfill"),
    services: v.array(
      v.union(v.literal("gmail"), v.literal("calendar"), v.literal("chat")),
    ),
    status: v.union(
      v.literal("queued"),
      v.literal("running"),
      v.literal("complete"),
      v.literal("failed"),
    ),
    requestedBackfillDays: v.number(),
    totalUnits: v.number(),
    completedUnits: v.number(),
    itemsFound: v.optional(v.number()),
    daysWithMail: v.optional(v.number()),
    bytesWritten: v.optional(v.number()),
    destinationFolder: v.optional(v.string()),
    currentService: v.optional(
      v.union(v.literal("gmail"), v.literal("calendar"), v.literal("chat")),
    ),
    currentUnit: v.optional(v.string()),
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    errorCode: v.optional(v.string()),
    transientFailures: v.optional(v.number()),
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
    .index("by_connection_created", ["connectionId", "createdAt"])
    .index("by_connection_status", ["connectionId", "status"]),

  /**
   * ONE IN-FLIGHT GOOGLE OAUTH ATTEMPT. Same shape and the same reasoning as
   * `dropboxConnectAttempts` — see that table's comment for the full argument;
   * this restates only what differs.
   *
   * `backfillDays` and `folders` are Gmail's own connect-time choices and
   * travel here rather than being asked for on the callback screen, because
   * the callback may carry no session (see `dropboxConnect.ts`'s
   * `completeDropboxConnect` for why that is a security argument and not a
   * shortcut) — so the choice the person made *before* leaving for Google's
   * consent screen has to survive the round trip somewhere that is not the
   * browser. A future Calendar-or-Chat-only connect attempt carries no Gmail
   * fields at all; they stay optional for exactly that reason.
   */
  googleConnectAttempts: defineTable({
    hashedState: v.string(),
    /**
     * SHA-256 of the value that never travels through Google.
     *
     * `dropboxConnectAttempts.hashedCompletion` carries the argument in full;
     * this flow was written from that one and needs the same binding. Optional
     * only because attempts parked before it existed have none, and those are
     * refused rather than trusted.
     */
    hashedCompletion: v.optional(v.string()),
    encryptedVerifier: v.string(),
    workspaceId: v.id("workspaces"),
    startedBy: v.id("users"),
    redirectUri: v.string(),
    /**
     * Which public callback is allowed to spend this shared-table attempt.
     * Optional only for rows parked before this discriminator existed; those
     * remain product-callback compatible and are refused by the combined Google
     * callback.
     */
    flow: v.optional(
      v.union(
        v.literal("gmail"),
        v.literal("calendar"),
        v.literal("chat"),
        v.literal("google"),
      ),
    ),
    products: v.array(
      v.union(v.literal("gmail"), v.literal("calendar"), v.literal("chat")),
    ),
    backfillDays: v.optional(v.number()),
    folders: v.optional(
      v.array(v.union(v.literal("inbox"), v.literal("sent"))),
    ),
    /**
     * The attachment choices made before leaving for Google's consent
     * screen, carried the same way `backfillDays`/`folders` are — see this
     * table's own comment. `attachmentRetentionDays` and
     * `attachmentRetentionForever` split "forever" out of the number rather
     * than union-typing the stored field, because Convex indexes and
     * comparisons on a column are simplest when its type does not vary row
     * to row; `googleConnect.ts` is the only reader and reassembles the
     * `number | "forever"` shape on the way out.
     */
    attachmentMode: v.optional(
      v.union(v.literal("metadata-only"), v.literal("store")),
    ),
    attachmentRetentionDays: v.optional(v.number()),
    attachmentRetentionForever: v.optional(v.boolean()),
    expiresAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_hashed_state", ["hashedState"])
    .index("by_expiresAt", ["expiresAt"]),
};
