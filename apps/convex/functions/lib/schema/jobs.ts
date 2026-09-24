import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Durable work in flight: cross-context moves, gateway jobs, and the email
 * worker's short-lived credential tickets.
 *
 * One slice of the control-plane schema, spread into `defineSchema` by
 * `apps/convex/schema.ts` in declaration order. Metadata only — see that
 * file's header.
 */
export const jobTables = {
  /**
   * A move of a note or a folder out of one context and into another.
   *
   * ## Why this is a row rather than one action
   *
   * Every other console file operation finishes inside the request that asked
   * for it, and a folder past `FOLDER_OPERATION_CAP` is refused rather than
   * half-done. That is the right trade when the whole move is one bucket's
   * rename. A cross-context move is not: the bytes travel out of one
   * customer's bucket, through the control plane, into another's, one bounded
   * batch at a time, and a folder of nine thousand notes is simply more
   * batches. The row is what makes "more batches" survive the request that
   * started it — the scheduler picks the next one up, and the console watches
   * a counter instead of a spinner that will time out.
   *
   * ## What it holds, and why paths are on it
   *
   * Both ends' workspace ids, both paths, phase, counts, and the keys the move
   * would not carry. `gatewayJobs` beside this deliberately holds no path at
   * all, and the difference is not an oversight: that row is minted for a
   * queue ticket and read again with nobody present, so the least it can know
   * the better. This row exists only because a person pressed Move, it is
   * readable only by an owner of the context the move came out of, and the
   * audit trail already records `file.move` with both paths for every
   * same-context move. A move job that could not name what was moving could
   * not tell that person which of their folders is still going.
   *
   * **Never note content.** The bodies exist only in flight, inside the action
   * that carries one batch across.
   */
  contextMoves: defineTable({
    sourceWorkspaceId: v.id("workspaces"),
    destinationWorkspaceId: v.id("workspaces"),
    /** Who pressed Move. Owner of the source at the time, re-checked on resume. */
    actorUserId: v.id("users"),
    /** Path in the source context. A note, or a folder and everything under it. */
    from: v.string(),
    /** Path in the destination context. Never merged onto something already there. */
    to: v.string(),
    status: v.union(
      v.literal("moving"),
      v.literal("complete"),
      v.literal("failed"),
    ),
    /** Objects landed in the destination and removed from the source. */
    movedObjects: v.number(),
    movedBytes: v.number(),
    /**
     * Keys this move will not carry, with the reason, so the console can name
     * them. Capped at `CONTEXT_MOVE_SKIP_CAP` — past that the move stops and
     * says so rather than growing this without limit.
     */
    skipped: v.array(v.object({
      path: v.string(),
      reason: v.union(v.literal("encrypted")),
    })),
    /** Set on `failed`, and written for a person rather than a log. */
    error: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    completedAt: v.optional(v.number()),
    /**
     * When the owner read the outcome and said so, on any device.
     *
     * A finished row outlives the screen that was watching it — it stays
     * listable for a day so a move does not vanish from somebody else's
     * console at ninety-nine percent. Without this the console had nowhere
     * durable to put "I have read that", so the notice came back on every
     * launch for the rest of the day, and its Dismiss button only ever
     * reached memory that the next launch threw away.
     *
     * Set for a `complete` row only. A `failed` one's notice carries the
     * Resume button that is the clean way to finish it, so it can be put
     * aside for a session but never answered for good —
     * `dismissContextMove` is where that argument lives.
     */
    dismissedAt: v.optional(v.number()),
  })
    .index("by_source_updatedAt", ["sourceWorkspaceId", "updatedAt"])
    .index("by_destination_updatedAt", ["destinationWorkspaceId", "updatedAt"])
    .index("by_actor_updatedAt", ["actorUserId", "updatedAt"]),

  /**
   * Durable gateway work, never note content.
   *
   * A row is minted only while a live user token is present; later Cloudflare
   * Queue attempts present an opaque ticket for that already-authorized row.
   * The ticket is stored hashed, and the payload is deliberately small: which
   * bounded gateway operation to resume, not the files or bytes it will touch.
   */
  gatewayJobs: defineTable({
    hashedTicket: v.string(),
    workspaceId: v.id("workspaces"),
    actorUserId: v.id("users"),
    actorClientId: v.string(),
    grantId: v.id("oauthGrants"),
    kind: v.union(v.literal("materialize_move")),
    moveId: v.optional(v.string()),
    status: v.union(
      v.literal("queued"),
      v.literal("running"),
      v.literal("complete"),
      v.literal("failed"),
    ),
    attempts: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    expiresAt: v.number(),
    leasedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    progressPhase: v.optional(v.union(v.literal("copying"), v.literal("deleting"))),
    progressCompleted: v.optional(v.number()),
    progressTotal: v.optional(v.number()),
  })
    .index("by_hashed_ticket", ["hashedTicket"])
    .index("by_workspace_status", ["workspaceId", "status"])
    .index("by_workspace_updatedAt", ["workspaceId", "updatedAt"])
    .index("by_expiresAt", ["expiresAt"]),

  /**
   * A short-lived capability the email worker presents to fetch a credential.
   *
   * ## What it is for
   *
   * `/gateway/binding` — the MCP gateway's credential route — requires two
   * proofs: the gateway secret, *and* an end user's OAuth access token, with the
   * workspace derived from the grant that token resolves to. That is what makes
   * a leaked gateway secret worth nothing on its own.
   *
   * **An inbound email has no user token.** Nobody is present and nothing was
   * authorized just now, so the two-proof shape cannot be reproduced. This table
   * is the narrowest replacement found for the second proof: instead of the
   * caller proving *who* it is acting for, the control plane hands it something
   * it minted, bound to one context, and refuses to be told which context to
   * open.
   *
   * The property that survives, and it is the important half: **nothing the
   * caller sends can select a row.** `/gateway/ingest/resolve` takes a name and
   * mints a ticket for whatever that name resolved to; `/gateway/ingest/binding`
   * takes only the ticket. There is no request field anywhere in the ingest
   * contract that names a context.
   *
   * The property that does not survive is stated plainly in
   * `infra/email-worker/src/controlPlane.ts`: a leaked `EMAIL_WORKER_SECRET`
   * yields one person's personal-context credential with no human in the loop.
   * It is bounded by personal contexts only, ingestion-enabled owners only, a
   * rate limit on resolve, and this table's TTL and single use.
   *
   * ## Why the ticket is stored hashed
   *
   * Same rule as `oauthGrants`: the plaintext exists in the worker's memory for
   * the seconds it takes to spend it, and nowhere else. A dump of this table is
   * inert — it names workspaces that were sent mail, which is already visible in
   * the audit trail, and cannot be replayed.
   *
   * ## Single use, twice over
   *
   * `bindingIssuedAt` and `recordedAt` are stamped on first use of their
   * respective routes and checked before the second. A ticket therefore buys at
   * most one credential and at most one accounting write. Rows past `expiresAt`
   * are refused on read whether or not anything has swept them.
   */
  ingestionTickets: defineTable({
    /** SHA-256 of the opaque ticket, lowercase hex. Never the plaintext. */
    hashedTicket: v.string(),
    /**
     * The personal context this ticket opens, fixed at mint time.
     *
     * The only way a row gets here is `resolvePersonalContextForIngestion`
     * answering a name lookup, so this is never a shared context and never
     * something a caller chose.
     */
    workspaceId: v.id("workspaces"),
    /** The SMTP-reported size resolve was told about. Accounting only. */
    sizeBytes: v.number(),
    createdAt: v.number(),
    expiresAt: v.number(),
    /** Set the first time this ticket is exchanged for a credential. */
    bindingIssuedAt: v.optional(v.number()),
    /** Set the first time this ticket is used for accounting. */
    recordedAt: v.optional(v.number()),
  })
    .index("by_hashed_ticket", ["hashedTicket"])
    .index("by_expiresAt", ["expiresAt"]),
};
