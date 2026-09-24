import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Fixed-window counters, and the form notifications a limit held back.
 *
 * One slice of the control-plane schema, spread into `defineSchema` by
 * `apps/convex/schema.ts` in declaration order. Metadata only — see that
 * file's header.
 */
export const rateLimitTables = {
  /**
   * Fixed-window counters for the operations that must not be unbounded.
   *
   * Nine call sites now, and the two that shape this table are the ones a
   * **stranger** can drive: email ingestion resolve, and dynamic client
   * registration. See `lib/rateLimit.ts` for what the scheme does and does not
   * protect against.
   *
   * Holds no identity of its own: the key is a caller-built string, and the
   * row carries a count and a timestamp and nothing else.
   *
   * ## Why this table is swept, when the counters are tiny
   *
   * **The key is chosen by whoever is being limited**, so on an unauthenticated
   * route the keyspace is theirs and not ours. `ingestionGateway.ts` handles
   * that by counting *after* the lookups, which bounds its keys to names that
   * belong to real contexts. Registration cannot: it has nothing to look up,
   * so its key is derived from the caller's network, and somebody who holds
   * many networks holds many keys.
   *
   * Normalising an address to its /64 collapses the cheap part of that — one
   * customer's 2^64 addresses become one bucket — and the sweep bounds the
   * rest, by *rate* rather than by keyspace: a row whose window closed carries
   * no information, so it is garbage rather than state. Without the sweep the
   * limit intended to stop unbounded rows would add a second unbounded table,
   * which is measured in `__tests__/controlPlane.test.ts`.
   */
  rateLimits: defineTable({
    key: v.string(),
    windowStartedAt: v.number(),
    count: v.number(),
  })
    .index("by_key", ["key"])
    .index("by_windowStartedAt", ["windowStartedAt"]),

  /**
   * Answers a form notification limit held back, waiting to be counted out
   * loud.
   *
   * ## Why silence was not an option
   *
   * A published form can take answers far faster than anybody wants mail, so
   * the per-recipient limit in `functions/formNotify.ts` is not optional. What
   * a bare limit costs is the difference between "nothing arrived" and "a
   * burst arrived while you were over your limit" — and that difference is
   * invisible to the one person the form belongs to. So a refused notification
   * increments a count here and one message per window says what the count
   * was.
   *
   * ## What is deliberately not in this table
   *
   * **No answers, no field values, no response ids.** The digest says how many
   * and links to the note; the note is where the content is, and the control
   * plane holds metadata only (non-negotiable #1). A row here is a counter and
   * three identifiers, and it must stay one — the moment it holds what a
   * submission said, a rate limit has become a copy of the customer's content
   * living in our database.
   *
   * ## One row per (context, form, recipient)
   *
   * Not per response, which would make the table grow with the thing it exists
   * to bound. `pending` is reset by the send rather than the rows being
   * deleted, so a form that has been quiet for months is one stale row rather
   * than a sweep to write.
   *
   * `scheduledFor` is what stops a burst scheduling a hundred digests: it holds
   * the time the one outstanding digest job will fire, and is cleared when it
   * does. A row with `scheduledFor` set and `pending` at zero cannot happen
   * through this module's own writes and is harmless if it ever does — the job
   * finds nothing to say and sends nothing.
   */
  formNotifyDigests: defineTable({
    workspaceId: v.id("workspaces"),
    /** Who the digest is for. A member of `workspaceId`, re-checked at send. */
    recipientUserId: v.id("users"),
    /** The form's declared id, which is what the message names. */
    formId: v.string(),
    /** Where to send the reader. Overwritten by the latest held-back answer. */
    responsesPath: v.string(),
    /**
     * The form's own note, and the most recent answer this row counted.
     *
     * Identifiers, kept so the digest can run the **same** authorization the
     * notification it replaced would have run: read that one response as this
     * recipient, and send only if the manifest still allows it. A second
     * predicate for "may they be told" is how a digest goes out about a folder
     * that was made private while the burst was landing.
     *
     * `responseId` is a `r-xxxxxxxx` handle and `notePath` is a path — both
     * metadata, like `responsesPath` beside them. Neither is an answer, and
     * nothing an answer said is ever written here.
     */
    notePath: v.string(),
    responseId: v.string(),
    /**
     * The `notify:` value the held-back answers were for.
     *
     * Kept so the digest's re-check can be the *same* call the notification
     * would have made — `readResponseForNotification` refuses an argument that
     * disagrees with the block, and a digest that could not supply this would
     * have to skip that check or invent a second one.
     */
    notify: v.string(),
    /** How many answers have been held back since the last digest. */
    pending: v.number(),
    /** When the outstanding digest job fires, or absent when none is due. */
    scheduledFor: v.optional(v.number()),
  }).index("by_recipient_form", ["workspaceId", "recipientUserId", "formId"]),
};
