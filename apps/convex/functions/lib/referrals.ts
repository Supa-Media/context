/**
 * Referrals: a person who is in lets a friend skip the waitlist.
 *
 * The decisions are Dev2's (2026-09-29), from the referrals artboard:
 *
 *  - **Three invites each**, unlocked once the person's setup is finished —
 *    one of their AI clients has actually called (a used grant). Staff can
 *    give anyone more. Somebody who was themselves let in by a referral waits
 *    seven days on top of that, so invites cannot snowball through fresh
 *    accounts.
 *  - **An invite is for one address and lasts 14 days.** While it is live, the
 *    address is let in (`isAdmitted` in `lib/waitlist.ts`), which is all an
 *    invite does: the person still types their address and is mailed a code.
 *  - The inviter can cancel a live invite and gets it back; so does an invite
 *    that expires unused. Staff can revoke a live invite; it stays used.
 *
 * ## Joined and expired are read, not stored
 *
 * An invite was used when an account for its address was created while it was
 * live. When several people invited the same address, the oldest live invite
 * gets the credit and the rest read as expired, so they come back to their
 * senders. `inviteStatuses` is that whole rule, and everything that shows or
 * counts an invite asks it.
 */

import type { GenericDatabaseReader } from "convex/server";
import type { DataModel, Doc, Id } from "../../_generated/dataModel";

type Db = GenericDatabaseReader<DataModel>;

/** The console's own grant (`functions/agentGrant.ts`): the person's own hand, not an AI client. */
const CONSOLE_CLIENT_ID = "context_console";

export const BASE_INVITES = 3;
export const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** How long somebody let in by a referral waits before they can invite. */
export const FRIEND_WAIT_MS = 7 * 24 * 60 * 60 * 1000;
/** Invites one person may send in a day, whatever their allowance. */
export const SENDS_PER_DAY = 10;
/** Invites the whole deployment may send in an hour. */
export const SITE_SENDS_PER_HOUR = 300;
/** How long after cancelling an invite Undo still brings it back. */
export const UNDO_WINDOW_MS = 10 * 60 * 1000;
/** Invites one person's list reads, at most. */
export const MAX_INVITES_READ = 200;

export type InviteStatus = "pending" | "joined" | "expired" | "cancelled" | "revoked";

/** Statuses that use up one of the inviter's invites. */
export function usesAnInvite(status: InviteStatus): boolean {
  return status === "pending" || status === "joined" || status === "revoked";
}

/**
 * The status of every invite to one address, given when (if ever) an account
 * for that address was created. Pure: the rule is here and nowhere else.
 */
export function inviteStatuses(
  invites: ReadonlyArray<Pick<Doc<"referralInvites">, "_id" | "status" | "createdAt" | "expiresAt">>,
  accountCreatedAt: number | null,
  now: number,
): Map<Id<"referralInvites">, InviteStatus> {
  const result = new Map<Id<"referralInvites">, InviteStatus>();
  // Oldest first, so the credit goes to whoever asked first.
  const ordered = [...invites].sort((a, b) => a.createdAt - b.createdAt);
  let credited = false;
  for (const invite of ordered) {
    if (invite.status === "cancelled" || invite.status === "revoked") {
      result.set(invite._id, invite.status);
      continue;
    }
    if (accountCreatedAt !== null) {
      const liveAtJoin = invite.createdAt <= accountCreatedAt && accountCreatedAt < invite.expiresAt;
      if (liveAtJoin && !credited) {
        credited = true;
        result.set(invite._id, "joined");
        continue;
      }
      // The address is in now, one way or another: nothing left to wait for.
      result.set(invite._id, "expired");
      continue;
    }
    result.set(invite._id, invite.expiresAt > now ? "pending" : "expired");
  }
  return result;
}

/** The account for an address, if there is one. */
export async function accountFor(db: Db, email: string): Promise<Doc<"users"> | null> {
  return await db
    .query("users")
    .withIndex("by_email", (q) => q.eq("email", email))
    .first();
}

/** Every invite to one address, with its status. */
export async function invitesTo(db: Db, email: string, now: number) {
  const invites = await db
    .query("referralInvites")
    .withIndex("by_email", (q) => q.eq("email", email))
    .take(MAX_INVITES_READ);
  const account = await accountFor(db, email);
  const statuses = inviteStatuses(invites, account?._creationTime ?? null, now);
  return { invites, account, statuses };
}

/** Does a live invite let this address in right now? For `isAdmitted`. */
export async function hasLiveInvite(db: Db, email: string, now: number): Promise<boolean> {
  const invites = await db
    .query("referralInvites")
    .withIndex("by_email", (q) => q.eq("email", email))
    .take(MAX_INVITES_READ);
  return invites.some((invite) => invite.status === "pending" && invite.expiresAt > now);
}

/** The invite that let this person in, if one did. */
export async function creditedInvite(db: Db, user: Doc<"users">, now: number) {
  if (typeof user.email !== "string") return null;
  const { invites, statuses } = await invitesTo(db, user.email, now);
  return invites.find((invite) => statuses.get(invite._id) === "joined") ?? null;
}

export async function invitesOff(db: Db): Promise<boolean> {
  const row = await db.query("referralSettings").first();
  return row?.invitesOff === true;
}

/** Has one of this person's own AI clients ever called? */
async function hasUsedClient(db: Db, userId: Id<"users">): Promise<boolean> {
  const grants = await db
    .query("oauthGrants")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(100);
  return grants.some(
    (grant) => grant.clientId !== CONSOLE_CLIENT_ID && typeof grant.lastUsedAt === "number" && grant.lastUsedAt > 0,
  );
}

export type LockedReason = "setup" | "new";

export interface Allowance {
  /** Null when the person may invite; otherwise why not yet. */
  locked: LockedReason | null;
  /** When `locked === "new"`, the moment it lifts. */
  unlocksAt: number | null;
  total: number;
  used: number;
  left: number;
}

/** One person's sent invites, newest first, each with its status. */
export async function sentBy(db: Db, userId: Id<"users">, now: number) {
  const sent = await db
    .query("referralInvites")
    .withIndex("by_inviter", (q) => q.eq("inviterUserId", userId))
    .order("desc")
    .take(MAX_INVITES_READ);
  const rows: Array<{ invite: Doc<"referralInvites">; status: InviteStatus; joinedUserId: Id<"users"> | null }> = [];
  for (const invite of sent) {
    const { statuses, account } = await invitesTo(db, invite.email, now);
    const status = statuses.get(invite._id) ?? "expired";
    rows.push({ invite, status, joinedUserId: status === "joined" ? account?._id ?? null : null });
  }
  return rows;
}

/**
 * What one person may still send.
 *
 * Staff-given invites also unlock: giving somebody more is staff vouching for
 * them, so it would be odd for the gift to sit behind the same wait.
 */
export async function allowanceFor(db: Db, userId: Id<"users">, now: number): Promise<Allowance> {
  const user = await db.get(userId);
  const grant = await db
    .query("referralAllowances")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
  const extra = grant?.extra ?? 0;
  const rows = await sentBy(db, userId, now);
  const used = rows.filter((row) => usesAnInvite(row.status)).length;
  const total = BASE_INVITES + extra;

  let locked: LockedReason | null = null;
  let unlocksAt: number | null = null;
  if (extra === 0 && user !== null) {
    if (!(await hasUsedClient(db, userId))) {
      locked = "setup";
    } else if ((await creditedInvite(db, user, now)) !== null) {
      const at = user._creationTime + FRIEND_WAIT_MS;
      if (at > now) {
        locked = "new";
        unlocksAt = at;
      }
    }
  }
  return { locked, unlocksAt, total, used, left: Math.max(0, total - used) };
}

export const COMMUNITY_KINDS = ["discord", "github", "x", "newsletter", "other"] as const;
export type CommunityKind = (typeof COMMUNITY_KINDS)[number];
export const MAX_COMMUNITY_LINKS = 20;
export const MAX_LINK_LABEL = 60;

/** An https URL, trimmed, or null. Nothing else is ever handed to a page. */
export function communityUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 500) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return null;
  return url.toString();
}
