/**
 * The audit trail — who did what, in which context.
 *
 * Two properties make this worth having:
 *  - It names the **acting identity**, not a scope. `actorScope: "team"` tells
 *    you nothing the moment "team" is four people.
 *  - It is **scoped to workspace members**. Paths are metadata, but a path can
 *    be as revealing as a note (`1-projects/acquisition-of-acme.md`), so the
 *    trail is readable exactly by the people who can already read the context.
 *
 * Writing is internal-only. A client-callable "record this event" is a way to
 * forge history, and an audit trail anyone can write to is not evidence.
 */

import { ConvexError, v } from "convex/values";
import { requireAuthId } from "@supa-media/convex/auth";
import { internalMutation, query } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { recordAudit } from "./lib/audit";
import { getMembership, workspaceNotFound } from "./lib/workspaceAuth";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Validate `limit` in the handler, because a validator cannot.
 *
 * `v.number()` is float64, and float64 includes `NaN`, `Infinity`, and
 * fractions — all of which Convex will happily encode and send. The old
 * `Math.min(Math.max(limit, 1), MAX)` clamp turns `NaN` into `NaN`, and
 * `.take(NaN)` throws a `TypeError`: a plain `Error` with a `null` payload,
 * which the client scrubs to "Server Error". That is exactly the dead end
 * `lib/workspaceAuth.ts` forbids, reached by way of an argument nobody thought
 * of as attacker-controlled.
 *
 * Rejecting rather than clamping, because a client asking for 1e9 rows or for
 * `NaN` has a bug, and silently serving it 200 rows hides the bug instead of
 * surfacing it.
 */
function requireLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new ConvexError({
      code: "INVALID_LIMIT",
      message: `limit must be a whole number between 1 and ${MAX_LIMIT}.`,
    });
  }
  return limit;
}

/**
 * Record an event. Internal only.
 *
 * The `details` validator permits a flat record of scalars and nothing deeper,
 * which makes it structurally impossible to hand it a note body by accident.
 * Never pass a secret, a token, or note content.
 */
export const recordEvent = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    actorUserId: v.optional(v.id("users")),
    actorClientId: v.optional(v.string()),
    action: v.string(),
    paths: v.optional(v.array(v.string())),
    details: v.optional(
      v.record(
        v.string(),
        v.union(v.string(), v.number(), v.boolean(), v.null()),
      ),
    ),
  },
  returns: v.id("auditEvents"),
  handler: async (ctx, args) => {
    return await recordAudit(ctx, {
      workspaceId: args.workspaceId,
      actorUserId: args.actorUserId,
      actorClientId: args.actorClientId,
      action: args.action,
      paths: args.paths,
      details: args.details,
    });
  },
});

/**
 * Read a workspace's audit trail, newest first.
 *
 * Any member may read it, including read-only members: the point of an audit
 * trail is that the people whose notes are involved can see what touched them.
 * A non-member gets `WORKSPACE_NOT_FOUND` — the same error as for a workspace
 * that does not exist, so this endpoint cannot be used to probe which
 * workspace ids are real.
 */
export const listEvents = query({
  args: {
    workspaceId: v.id("workspaces"),
    limit: v.optional(v.number()),
  },
  returns: v.array(
    v.object({
      eventId: v.id("auditEvents"),
      actorUserId: v.optional(v.id("users")),
      actorEmail: v.optional(v.string()),
      actorClientId: v.optional(v.string()),
      action: v.string(),
      paths: v.array(v.string()),
      at: v.number(),
      details: v.optional(
        v.record(
          v.string(),
          v.union(v.string(), v.number(), v.boolean(), v.null()),
        ),
      ),
    }),
  ),
  handler: async (ctx, args) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;

    // Membership first, and through the one helper that builds this error, so
    // "not yours" and "does not exist" cannot drift apart.
    const membership = await getMembership(ctx, args.workspaceId, userId);
    if (membership === null) throw workspaceNotFound();

    const limit = requireLimit(args.limit);

    const events = await ctx.db
      .query("auditEvents")
      .withIndex("by_workspace_at", (q) => q.eq("workspaceId", args.workspaceId))
      .order("desc")
      .take(limit);

    const rows = [];
    for (const event of events) {
      // Resolve the actor to something a human recognizes. An audit line that
      // reads "j57f2… wrote 1-projects/foo.md" is not an answer to "who did
      // this?", which is the only question the trail exists to answer.
      const actor =
        event.actorUserId === undefined
          ? null
          : await ctx.db.get(event.actorUserId);
      rows.push({
        eventId: event._id,
        actorUserId: event.actorUserId,
        actorEmail: actor?.email,
        actorClientId: event.actorClientId,
        action: event.action,
        paths: event.paths,
        at: event.at,
        details: event.details,
      });
    }
    return rows;
  },
});
