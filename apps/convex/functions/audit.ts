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
 *    reports how many top-level folders the bucket really has, and
 *    `file.move`, `file.copy`, `file.duplicate` and `file.archive` report
 *    `{ files: result.paths.length }`, which `keysUnder` expands at the
 *    *actor's* clearance. An owner archiving a `team` folder holding three
 *    team notes and three private ones writes `files: 6` where the member can
 *    list three. Both are the exact subtraction `getStorageBinding` withholds
 *    the note census to prevent, arriving through the trail instead. The count
 *    is withheld rather than dropped at the call site, so the owner's record
 *    keeps it.
 *  - **Anything another API answers at a higher role.** `listGrants` shows
 *    every grant only to a workspace `owner` -- an editor and a member alike
 *    see their own and nothing else. `grant.created` records `{ scopes, tier }` and
 *    `oauth.authorized` records `{ scope, grantedScope, tier }`, so leaving
 *    them on would let a read-only member read with what reach everybody
 *    else's AI clients connected: the same shape as the `ingestion.*` hole
 *    this gate was written to close, one rung lower.
 *
 *    **The scopes are what this removes, and not the fact of the grant.**
 *    `actorUserId`, `actorEmail`, `actorClientId` and `at` sit outside the
 *    gate, so a member still reads who connected a client, when, and -- by
 *    joining `grant.created` to `grant.revoked` on the client id -- whose was
 *    revoked and whether it was involuntary. Four of the six fields
 *    `listGrants` gates at `owner`. Closing that means gating those columns
 *    too, which is the same shape as the `paths` decision below and belongs
 *    with it.
 *
 * What is on it is what a member can already derive from the context they can
 * read: that a note was written or deleted, that a visibility changed and to
 * what, who joined and who left. Withholding those too would leave a trail
 * that answers nothing.
 *
 * The last two families were found by a review of the first version of this
 * list, which broke its own criteria with its own entries -- which is the
 * argument for the shape rather than against it: an entry has to be defended
 * on the details it actually carries, and adding one is where that happens.
 */
const MEMBER_VISIBLE_DETAIL_ACTIONS: ReadonlySet<string> = new Set([
  // `{ conflictCheck }` and `{ recoverable }`. No count, no identity.
  "file.create",
  "file.write",
  "file.delete",
  "folder.create",
  // `{ template, folderCount }`, where `folderCount === paths.length` exactly,
  // so today it says nothing the row does not already say. **Revisit it in the
  // same commit that ever withholds `paths`**: the scaffold's manifest is
  // `default_visibility: private`, so on its own this is an exact count of the
  // top-level folders of a context the member can list none of -- verbatim the
  // criterion that keeps `privacy.reset` off this list.
  "workspace.structure_applied",
  "visibility.note",
  "visibility.folder",
  "member.joined",
  "member.left",
  "share.team.created",
  // `{ onBehalfOfSelf }`, `{ reason: "refresh_token_reuse" }` or
  // `{ reason: "client_revocation" }` -- no scope, no client, no third party.
  // Kept deliberately rather than by omission: "a grant was revoked, and why"
  // is what a trail is for. Its two siblings are off the list below.
  "grant.revoked",
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
    // What that leaves visible on a withheld row: the action name, the actor
    // and their email, the client id, the timestamp, and `paths`.
    //
    // **`paths` IS AN OPEN LEAK AND THIS COMMENT IS NOT A DEFENCE OF IT.** An
    // earlier draft of this paragraph said "the folder is one a member can
    // list", which is false in general and was the worst thing in this file:
    // a reassurance a later reviewer would have trusted. Measured through the
    // real actions and the real privacy engine, a read-only member whose
    // `listFiles` on `1-projects` correctly returns **zero entries** gets the
    // hidden note's full path out of `listEvents` three times over -- from
    // `file.create`, from `visibility.note` (labelled `visibility: "private"`,
    // so they learn it is a note they were not meant to have), and from
    // `file.delete`, which records `keysUnder(...)` expanded at the *actor's*
    // clearance and therefore lists every private sibling by name. That is the
    // module header's own example -- "a path can be as revealing as a note
    // (`1-projects/acquisition-of-acme.md`)" -- handed to a member.
    //
    // It predates the detail gate and is not fixed by it, and it is left open
    // here deliberately rather than quietly: the fix is a design decision, not
    // a line. `canSee` needs the privacy manifest, which lives in the
    // customer's bucket, and a Convex `query` cannot reach storage -- so the
    // three candidates are making this an action (losing reactivity, and
    // spending a bucket read per trail load), stamping each row's visibility
    // at write time (which a later visibility change then makes wrong), or
    // withholding `paths` from non-owners entirely (which takes the trail's
    // subject away from it). Each is its own change with its own review.
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
