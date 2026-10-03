import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Who asked to be let in, and who has been.
 *
 * One slice of the control-plane schema, spread into `defineSchema` by
 * `apps/convex/schema.ts`. Metadata only — see that file's header. An address
 * and a one-line answer to "what would you use it for?" are about a person,
 * never about their notes.
 *
 * Context is invite-only (Dev2, 2026-09-28): a stranger cannot be mailed a
 * sign-in code or given an account until staff let their address in. The
 * rule itself is `lib/waitlist.ts`'s `isAdmitted`; this table is only one of
 * the things it reads. An existing account, a pending invitation to a
 * workspace and the staff allowlist admit an address without any row here.
 */
export const waitlistTables = {
  waitlist: defineTable({
    /** Lowercased and trimmed — `normalizeEmail` from `@context/shared`. */
    email: v.string(),
    /**
     * `waiting` until staff act. `admitted` may be mailed a code. `removed` is
     * staff saying no for now: the person still reads "you're already on the
     * list", so a removal is never announced to them.
     */
    status: v.union(v.literal("waiting"), v.literal("admitted"), v.literal("removed")),
    joinedAt: v.number(),
    /** Where the address was typed, or `staff` for one added from the console. */
    source: v.union(v.literal("homepage"), v.literal("login"), v.literal("staff")),
    /** The optional one-line answer, at most `USE_FOR_MAX` characters. */
    useFor: v.optional(v.string()),
    admittedAt: v.optional(v.number()),
    admittedBy: v.optional(v.id("users")),
    /**
     * When each message was claimed for sending. Set in the same transaction
     * that schedules the send, so one row produces at most one of each.
     */
    joinedMailAt: v.optional(v.number()),
    admittedMailAt: v.optional(v.number()),
  })
    .index("by_email", ["email"])
    .index("by_status_joinedAt", ["status", "joinedAt"]),

  /**
   * Staff who asked to be emailed about each new waitlist signup and each new
   * account (Dev2, 2026-10-03). One row per staff member who turned it on, from
   * the console's Waitlist tab. The address is read from the user row at send
   * time and must still be on `ADMIN_EMAILS`, so somebody taken off staff stops
   * getting alerts without anybody remembering to switch them off.
   */
  signupAlertSubscribers: defineTable({
    userId: v.id("users"),
    createdAt: v.number(),
  }).index("by_user", ["userId"]),
};
