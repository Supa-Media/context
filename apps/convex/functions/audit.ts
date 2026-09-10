/**
 * The audit trail — who did what, in which context.
 *
 * Two properties make this worth having:
 *  - It names the **acting identity**, not a scope. `actorScope: "team"` tells
 *    you nothing the moment "team" is four people.
 *  - It is **scoped to workspace members**, and within that, to what the
 *    reader's own clearance already reaches. A path can be as revealing as a
 *    note (`1-projects/acquisition-of-acme.md`), so membership alone is not
 *    the boundary — `listEvents` gates `paths` and `details` separately below.
 *
 * Writing is internal-only. A client-callable "record this event" is a way to
 * forge history, and an audit trail anyone can write to is not evidence.
 */

import { ConvexError, v } from "convex/values";
import { requireAuthId } from "@supa-media/convex/auth";
import { internalMutation, query } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { recordAudit } from "./lib/audit";
import {
  getMembership,
  workspaceNotFound,
  type WorkspaceRole,
} from "./lib/workspaceAuth";

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
 *    reports how many top-level folders the bucket really has;
 *    `workspace.structure_applied` reports `{ template, folderCount }`, where
 *    `folderCount === paths.length` exactly -- which cost nothing while
 *    `paths` was published and is an exact census the moment `paths` is not,
 *    because the scaffold's manifest is `default_visibility: private` and the
 *    member can list none of those folders. It came off this list in the
 *    commit that closed `paths`, which is the revisit its old entry asked
 *    for; and
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
 *  - **An exception flag turns a same-shape detail into a note-level
 *    existence signal.** `visibility.note`'s `{ visibility, exception }` was
 *    harmless while `paths` rode beside it on the same row -- `exception`
 *    was redundant with the path it was attached to. It stopped being
 *    harmless the moment `readsEveryPath` below gated `paths`: paired with
 *    `visibility: "private"` on a row whose path a member cannot resolve,
 *    `exception: true` still says this note's classification differs from
 *    its *folder's* default, which is a private note counted inside a folder
 *    whose default the member CAN read. That is `workspace.structure_
 *    applied`'s `folderCount` all over again -- the identical shape struck
 *    from this list above for exactly this reason -- rebuilt one action
 *    later. `visibility.note` comes off the list with it.
 *
 *    `visibility.folder` stays, and for a different reason than "it's fine":
 *    it carries no `exception` field, and its subject -- a folder's own
 *    default -- is something a member watching that folder already learns
 *    first-hand the instant their own `listFiles` on it changes. Publishing
 *    it a second time through the trail teaches a member nothing beyond what
 *    the folder itself already showed them. Both setters
 *    (`setNoteVisibility`, `setDirectoryVisibility`) are `owner`-only, so a
 *    member is never either row's actor -- keeping one and dropping the
 *    other costs a legitimate reader nothing about their own work either way.
 *
 * What is on it is what a member can already derive from the context they can
 * read: that a note was written or deleted, that a *folder's* visibility
 * changed and to what, who joined and who left. A member no longer learns
 * that some *note's* visibility changed, or to what -- see `visibility.note`
 * above. Withholding the rest too would leave a trail that answers nothing.
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
  // `{ conflictCheck }`, same as `file.write` — `removeNoteEncryption` is a
  // plaintext write like any other from an audit trail's point of view; the
  // note's own body never rides on this row either way.
  "file.decrypt",
  "file.delete",
  "folder.create",
  // `visibility.note` is deliberately NOT here -- see the family above. Its
  // `{ visibility, exception }` is an existence oracle now that `paths` is
  // gated; `visibility.folder` keeps no `exception` field and its subject is
  // one a member already sees first-hand in their own listing.
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
 * Whether this reader is shown a row's `paths`.
 *
 * **The rule: your own clearance, or your own hands.** A caller with `private`
 * clearance -- which is exactly `role === "owner"`, the boundary
 * `scopeForRole` in `functions/files.ts` already draws, pinned by a test in
 * `__tests__/audit.test.ts` so the two cannot drift -- reads every path. Every
 * other reader reads paths only on rows they are themselves the actor of.
 *
 * ## Why identity and not visibility
 *
 * The honest gate would be `canSee(path, scopeForRole(role), ...)`, the same
 * one `listFiles` runs. It is **not reachable from here**, and not for want of
 * trying: `canSee` needs the parsed `privacy.md`, `privacy.md` lives in the
 * customer's bucket, and reaching the bucket needs the decrypted storage
 * credential. `runFileOperation` is the sole member of `CREDENTIAL_BARRIERS`
 * (`__tests__/structure.test.ts`) precisely so that decrypt path stays in one
 * place, and a Convex `query` cannot call an action at all. The control plane
 * also holds no shadow copy of a note's visibility to consult instead -- by
 * design, non-negotiable #1 -- so there is nothing in this transaction that
 * knows whether `2-areas/acquisition-of-acme.md` is private. Inventing a way
 * through that barrier would trade a metadata leak for a credential one.
 *
 * What a query *can* know is who is asking and who acted. So the gate is the
 * strongest sound under-approximation of `canSee`: **a path is released only
 * when the reader demonstrably already had it.** The owner had it by
 * clearance. The actor had it by having typed it -- and a row's `paths` are
 * expanded by `keysUnder` at the *actor's* clearance, so a member's own row
 * can only ever name what the member could already list.
 *
 * **The actor leg is past-tense clearance, not current** -- worth saying
 * plainly rather than folding into "sound". An editor who wrote
 * `1-projects/plan.md` keeps reading their own `file.write` row's path after
 * the owner later marks that note `private`; they had it when they wrote it,
 * and this gate does not revoke it retroactively. The exposure is mild and
 * self-limiting: it is a path the editor already possesses outside the trail
 * (they wrote it), never grows (no later *owner* action on that path
 * re-exposes it to them -- the owner's own rows on it, including the
 * eventual `file.delete`, are gated by clearance and stay closed), and is
 * symmetric with the honest `canSee` this approximates, which would show the
 * same row at write time and only stops matching once the manifest changes
 * underneath it. The owner leg has no such gap: `role === "owner"` is
 * evaluated fresh on every call.
 *
 * The three alternatives, and why not:
 *
 *  - **Make `listEvents` an action.** Correct filtering, and it costs the
 *    console's reactivity plus a bucket read and a credential decrypt on every
 *    trail load. Worth reopening if the trail ever moves behind an action for
 *    other reasons; not worth widening the credential surface for a settings
 *    panel.
 *  - **Stamp each row's visibility at write time.** Cheap and wrong in the
 *    unsafe direction: a note written at `team` and later made `private`
 *    keeps a `team` stamp, so the leak survives exactly the act -- hiding
 *    something -- that makes it matter.
 *  - **Withhold `paths` from every non-owner including their own rows.**
 *    Marginally simpler, strictly worse: it takes away the half of the trail
 *    that answers "what did my client just do in my name", which is a
 *    member's main reason to open it, and buys nothing, because the reader
 *    supplied those paths themselves.
 *
 * ## What it costs
 *
 * A member no longer sees which note somebody else touched -- including
 * `team` notes they can read perfectly well. That is a real loss and the
 * reason this took a decision rather than a line: "who changed my shared
 * note" now stops at "who, and when". The trade is that the gate is *sound*
 * without a manifest, and the failure mode of getting it wrong is a member
 * seeing less than they might have rather than a member seeing a note they
 * were never shown. See `docs/decisions/privacy-and-sharing.md`.
 */
function readsEveryPath(role: WorkspaceRole): boolean {
  return role === "owner";
}

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
      /**
       * Whether `paths` above was withheld from this reader.
       *
       * **Always present, and computed from the reader alone** -- their role
       * and whether they are this row's actor -- never from what the row
       * actually holds. So it is a fact the caller already knows about
       * themselves, restated per row, and carries nothing about the note. In
       * particular a withheld row with three paths and a withheld row with
       * none are byte-identical here, which is what stops the marker itself
       * from becoming the census that `paths` was.
       *
       * `paths: []` alone would have been the wrong shape: it says "this
       * touched nothing", which is false, and a trail that lies is worse than
       * one with holes. The flag makes the hole legible instead, so a console
       * can render "a note you cannot see" rather than silently nothing.
       *
       * **That rendering is only correct for actions that carry paths in the
       * first place.** `pathsWithheld` is `true` on rows like `member.joined`
       * or `mail.rekeyed` too -- it is computed from the reader alone, so it
       * cannot tell "a path exists and is hidden" apart from "there was never
       * a path here" any more than it can tell one hidden path from three. A
       * renderer must gate "a note you cannot see" on the row's own `action`
       * being one that carries paths before it reads this flag that way --
       * `action` is public on every row, so branching on it adds nothing a
       * member could not already see.
       */
      pathsWithheld: v.boolean(),
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
    // and their email, the client id, and the timestamp.
    //
    // **`paths` is gated separately, and by a different question** -- see
    // `readsEveryPath` above for the whole argument. In one line: `details`
    // are classified per action because an action's details are the same shape
    // for everybody, while a path is classified per *note*, and the thing that
    // classifies a note is a manifest this transaction cannot read. So paths
    // are released on the two grounds a query can actually verify -- the
    // reader has `private` clearance, or the reader is the actor who supplied
    // them.
    const readsEveryDetail = membership.role === "owner";

    // Deliberately NOT `readsEveryDetail`, even though both are `owner` today.
    // They are two different rules that happen to agree, and folding them into
    // one boolean is how a future change to either silently moves the other.
    const everyPath = readsEveryPath(membership.role);

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

      // Note what this does NOT consult: `event.paths`, `event.action`, or
      // anything else on the row. A reader who is neither the owner nor this
      // row's actor gets the same answer whatever the row holds, which is the
      // property that keeps the marker from being an oracle. A row with no
      // actor -- ingestion, a scheduled job -- is nobody's own row, so it
      // falls to the clearance leg, which is the closed direction.
      const pathsWithheld =
        !everyPath &&
        !(event.actorUserId !== undefined && event.actorUserId === userId);

      rows.push({
        eventId: event._id,
        actorUserId: event.actorUserId,
        actorEmail: actor?.email,
        actorClientId: event.actorClientId,
        action: event.action,
        paths: pathsWithheld ? [] : event.paths,
        pathsWithheld,
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
