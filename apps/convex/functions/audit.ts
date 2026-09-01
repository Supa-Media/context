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
 * The actions whose `details` a non-owner member may read.
 *
 * An **allow-list**, because the alternative publishes by default. The first
 * version of this gate withheld details for actions named `ingestion.*`, which
 * is the deny-list shape `OVERRIDABLE_STORAGE_CODES` in the console is written
 * inside-out to avoid: an action added next year would have arrived readable by
 * every member, having been classified by nobody.
 *
 * It missed one that already existed. `share.created` records the address or
 * handle the owner shared a note with -- somebody who need not be a member of
 * anything, and who is owner-only through `listShares`. The same for
 * `member.invited` and `invitation.revoked`, which name a person who has not
 * answered yet and may never.
 *
 * Three families are off the list and each for its own reason:
 *
 *  - **A third party's identity.** `share.created`, `share.revoked`,
 *    `member.invited`, `invitation.revoked`, and the `targetUserId` on
 *    `member.removed` / `member.role_changed`.
 *  - **Owner-only configuration.** `ingestion.*` carries the allow-list's
 *    cardinality, whether it is open to any sender, and where captures land;
 *    `storage.*` carries the bucket, the endpoint and the provider's error
 *    codes. Both are owner-only through their own APIs, and a trail that
 *    republished them would be the hole rather than a second copy of the rule.
 *  - **Anything countable over what a member cannot see.** `privacy.reset`
 *    reports how many top-level folders the bucket really has, which is an
 *    exact private-folder total by subtraction for somebody shown a subset --
 *    the census's own reason for being owner-only.
 *
 * What is on it is what a member can already derive from the context they can
 * read: their colleagues' file operations, visibility changes, joins and
 * leaves, the scaffold, and the connections people made to the workspace.
 * Withholding those too would leave a trail that answers nothing.
 */
const MEMBER_VISIBLE_DETAIL_ACTIONS: ReadonlySet<string> = new Set([
  "file.create",
  "file.write",
  "file.move",
  "file.copy",
  "file.duplicate",
  "file.archive",
  "file.delete",
  "folder.create",
  "workspace.structure_applied",
  "visibility.note",
  "visibility.folder",
  "member.joined",
  "member.left",
  "share.team.created",
  "grant.created",
  "grant.revoked",
  "oauth.authorized",
]);

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

    // **A row's `details` are the owner's unless the action is on the
    // allow-list above.** The rule is inverted from the obvious direction on
    // purpose: an action nobody classified is withheld rather than published,
    // so the failure mode of forgetting to think about a new event is a member
    // seeing less than they could have rather than more than they should.
    //
    // The event itself always stays. "Something changed the capture policy /
    // shared this note / invited somebody, and who" is the question the trail
    // exists to answer, and a member losing the row entirely would lose that.
    //
    // What that leaves visible on a withheld row, stated rather than implied,
    // because the previous version of this comment said only "details is
    // withheld" and left the rest to be discovered: the action name, the actor
    // and their email, the client id, the timestamp, and `paths`. So a member
    // still learns that a capture folder was set and which folder it is
    // (`ingestion.settings.updated` records `paths: [targetFolder]`), and that
    // a note was shared and which note. Withholding `paths` would take the
    // trail's subject away from it, and the folder is one a member can list.
    // The address it was shared with is what they do not get.
    const readsEveryDetail = membership.role === "owner";

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
        details:
          readsEveryDetail || MEMBER_VISIBLE_DETAIL_ACTIONS.has(event.action)
            ? event.details
            : undefined,
      });
    }
    return rows;
  },
});
