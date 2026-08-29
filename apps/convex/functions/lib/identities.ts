/**
 * Resolving an addressed identifier to the account behind it.
 *
 * Sharing in this product is addressed by string — `@lk` or an email — and
 * never by user id, because resolving at write time turns an invite box into a
 * name-enumeration endpoint for the whole platform (see `lib/invitees.ts` and
 * the module comment in `functions/invitations.ts`). Resolution happens later,
 * on the way *in*: when somebody presents a token and claims to be who it was
 * addressed to.
 *
 * ## Why this is not in `lib/invitees.ts`
 *
 * That module is **pure and cannot reach a database**, and that is a security
 * property with a comment attached: a refusal about a malformed identifier must
 * not be able to depend on who exists. This module is the opposite half — it
 * does nothing *but* read the database — and mixing the two would put a `ctx`
 * within reach of the parser, which is exactly the arrangement the purity
 * comment exists to prevent under a later refactor.
 *
 * ## Why it is shared rather than copied
 *
 * `functions/invitations.ts` had this privately and `functions/shares.ts`
 * needs the same answer to the same question. Two copies of "is this caller the
 * person this capability was addressed to?" is two places for an authorization
 * check to drift, and the direction that drift fails is somebody reading a note
 * that was addressed to a name they merely resemble. Same reasoning as
 * `toolsForSession` being the one place authority is decided in the gateway.
 */

import type { Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import type { Invitee } from "./invitees";
import { findName } from "./nameClaims";

/**
 * The most members one lookup will scan.
 *
 * Mirrors `MAX_MEMBERS_RETURNED` in `functions/workspaces.ts`. Used only to
 * find a workspace's single owner, which is always the first row written.
 */
const MAX_MEMBERS_SCANNED = 200;

/**
 * The account behind an identifier, or `null`.
 *
 * `null` covers "no such name", "no such mailbox", "that name belongs to a
 * shared context rather than a person", and "that account never verified its
 * address" — because every caller of this function must treat all four
 * identically, and returning a reason would invite somebody to branch on it.
 *
 * ## Why a `@name` can resolve through a personal context
 *
 * The `names` table has a `kind: "user"` variant, but nothing claims one today:
 * the only writer is `createWorkspace`, which claims `kind: "workspace"`. What
 * a person actually has is a **personal** workspace whose slug is their handle
 * — `@seyi` is the name of Seyi's own context — which is precisely what
 * CLAUDE.md means by usernames and workspace slugs sharing one namespace.
 *
 * So a handle resolves to a person in two steps: a `user` claim if one exists,
 * otherwise the sole `owner` of a `personal` workspace with that slug. The
 * `personal` check is the important half — `@shared-thing` is a context, not a
 * person, and inviting a context into a context is a mount, which is
 * deliberately not built.
 *
 * Every ambiguity fails closed. Two accounts on one address, or a workspace
 * with anything other than exactly one owner, resolves to `null` rather than to
 * a guess: this function decides who may reach a context, and the one thing it
 * must never do is pick.
 */
export async function resolveAddressedUser(
  ctx: QueryCtx,
  addressee: Invitee,
): Promise<Id<"users"> | null> {
  if (addressee.kind === "email") {
    const matches = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", addressee.value))
      .take(2);
    if (matches.length !== 1) return null;
    const user = matches[0];
    // An unverified address proves nothing about who holds the mailbox, and a
    // capability addressed to a mailbox is meaningless without that proof.
    if (user.emailVerificationTime === undefined) return null;
    return user._id;
  }

  const claim = await findName(ctx, addressee.value);
  if (claim === null) return null;
  if (claim.kind === "user") return claim.userId ?? null;
  if (claim.workspaceId === undefined) return null;

  const workspace = await ctx.db.get(claim.workspaceId);
  if (workspace === null || workspace.kind !== "personal") return null;

  const members = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspace._id))
    .take(MAX_MEMBERS_SCANNED);
  const owners = members.filter((member) => member.role === "owner");
  return owners.length === 1 ? owners[0].userId : null;
}

/**
 * The most identifiers or rows one of these lookups will gather.
 *
 * An unbounded `.collect()` is a read whose cost is set by whoever can insert
 * rows. Mirrors `MAX_INVITATIONS_RETURNED` in `functions/invitations.ts`.
 */
const MAX_IDENTIFIERS_SCANNED = 200;

/**
 * Every identifier this account answers to.
 *
 * The reverse of `resolveAddressedUser`, and deliberately **not** its authority.
 * This gathers candidates so a listing can be narrowed with an index instead of
 * scanned; every row it finds must still be put back through
 * `resolveAddressedUser` before anything is shown, because only that function
 * decides who an identifier belongs to. Gathering that this disagrees with is
 * dropped by the caller, never trusted.
 *
 * Two ways a handle points at a person today: a `names` claim of `kind: "user"`,
 * and — the one that actually occurs — the slug of a **personal** workspace they
 * own. A verified address is the third. An unverified one is not an identifier
 * at all: it proves nothing about who holds the mailbox.
 */
export async function identifiersForUser(
  ctx: QueryCtx,
  userId: Id<"users">,
): Promise<Invitee[]> {
  const me = await ctx.db.get(userId);
  if (me === null) return [];

  const identifiers: Invitee[] = [];
  if (me.email !== undefined && me.emailVerificationTime !== undefined) {
    identifiers.push({ kind: "email", value: me.email.toLowerCase() });
  }

  const claims = await ctx.db
    .query("names")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(MAX_IDENTIFIERS_SCANNED);
  for (const claim of claims) {
    if (claim.kind === "user") identifiers.push({ kind: "name", value: claim.name });
  }

  const memberships = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(MAX_IDENTIFIERS_SCANNED);
  for (const membership of memberships) {
    if (membership.role !== "owner") continue;
    const workspace = await ctx.db.get(membership.workspaceId);
    if (workspace === null || workspace.kind !== "personal") continue;
    identifiers.push({ kind: "name", value: workspace.slug });
  }

  return identifiers;
}
