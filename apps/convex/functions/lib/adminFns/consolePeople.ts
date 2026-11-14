/**
 * The staff console's People page: one list of everyone. Accounts with their
 * workspaces, clients, last sign-in, what they cost and how they came in;
 * waitlist rows nobody holds yet; and referral invites that did not join.
 *
 * Handlers only. `functions/consolePeople.ts` authorizes with `requireAdmin`
 * before calling `everyoneHandler`.
 *
 * Every scan is bounded with `.take(N)`. A scan that reaches its bound sets
 * `truncated`, and the page says so rather than showing a short list as whole.
 */

import { adCampaignLabel } from "@context/shared";
import { v } from "convex/values";
import type { Doc, Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import { handleForUser } from "../identities";
import { invitesOff, invitesTo, type InviteStatus } from "../referrals";
import { attachedEmailsOf } from "../signInEmails";
import { dayWindow, featureLabel, newBudget, usageBetween, usd } from "./aiCostsRead";
import { accountSpendOf, workspaceSpendOf } from "./aiCostsReport";
import { archivedUserIds, personOf } from "./people";
import { untoldRows } from "./waitlistUntold";

/** Accounts one page reads. */
export const ACCOUNT_SCAN = 2000;
/** Waitlist rows one page reads, newest first. */
export const WAITLIST_SCAN = 5000;
/** Referral invites one page reads, newest first. */
export const INVITE_SCAN = 2000;
/** OAuth grants read for one account. */
const GRANT_SCAN = 200;
/** The AI spend window the page shows. */
const SPEND_DAYS = 30;

const roleValidator = v.union(v.literal("owner"), v.literal("editor"), v.literal("member"));

export const fromValidator = v.union(
  v.literal("waitlist"),
  v.literal("friend"),
  v.literal("ad"),
  v.literal("staff"),
  v.literal("direct"),
);

const waitlistFromValidator = v.union(v.literal("waitlist"), v.literal("ad"), v.literal("staff"));

export const consolePersonValidator = v.object({
  userId: v.id("users"),
  name: v.union(v.string(), v.null()),
  handle: v.union(v.string(), v.null()),
  emails: v.array(v.string()),
  phone: v.union(v.string(), v.null()),
  textingPhones: v.array(v.string()),
  joinedAt: v.number(),
  archived: v.boolean(),
  /** The newest use of any of this person's grants, active or revoked. */
  lastSeenAt: v.union(v.number(), v.null()),
  from: fromValidator,
  /** The inviter's handle, when `from` is `friend`. */
  invitedBy: v.union(v.string(), v.null()),
  workspaces: v.array(
    v.object({
      slug: v.string(),
      kind: v.union(v.literal("personal"), v.literal("shared")),
      role: roleValidator,
    }),
  ),
  /** Active grants only, newest use first. */
  clients: v.array(v.object({ name: v.string(), lastUsedAt: v.union(v.number(), v.null()) })),
  aiUsd: v.number(),
  aiByFeature: v.array(v.object({ label: v.string(), usd: v.number() })),
});

export const consoleWaitlistValidator = v.object({
  id: v.id("waitlist"),
  who: v.string(),
  status: v.union(v.literal("waiting"), v.literal("admitted"), v.literal("removed")),
  joinedAt: v.number(),
  from: waitlistFromValidator,
  campaign: v.union(v.string(), v.null()),
  useFor: v.union(v.string(), v.null()),
  /** False only for a let-in phone row that nobody has been texted about. */
  told: v.boolean(),
});

export const consoleInviteValidator = v.object({
  id: v.id("referralInvites"),
  to: v.string(),
  inviterHandle: v.union(v.string(), v.null()),
  sentAt: v.number(),
  status: v.union(v.literal("pending"), v.literal("expired"), v.literal("cancelled"), v.literal("revoked")),
});

export const consolePeopleValidator = v.object({
  accounts: v.array(consolePersonValidator),
  waitlist: v.array(consoleWaitlistValidator),
  invites: v.array(consoleInviteValidator),
  invitesOff: v.boolean(),
  truncated: v.boolean(),
});

export type ConsolePeople = typeof consolePeopleValidator.type;
export type CameFrom = { from: typeof fromValidator.type; invitedBy: string | null };

/** How a waitlist row reads on the page: an ad, a staff addition, or a plain join. */
function waitlistFromOf(row: Doc<"waitlist">): typeof waitlistFromValidator.type {
  if (adCampaignLabel(row.campaign) !== null) return "ad";
  return row.source === "staff" ? "staff" : "waitlist";
}

const WAITLIST_RANK: Record<typeof waitlistFromValidator.type, number> = { ad: 3, staff: 2, waitlist: 1 };

/**
 * How one account came in. A referral that joined this account wins; otherwise
 * its best waitlist row (an ad over a staff addition over a plain join); else
 * `direct`. Read from the account's own addresses and phones, never from a
 * stored field, so it is the same answer on any page that asks.
 */
export async function cameFromFor(ctx: QueryCtx, user: Doc<"users">): Promise<CameFrom> {
  const now = Date.now();
  const emails = [
    ...new Set([
      ...(user.email === undefined ? [] : [user.email.toLowerCase()]),
      ...(await attachedEmailsOf(ctx, user._id)),
    ]),
  ];
  for (const email of emails) {
    const { invites, account, statuses } = await invitesTo(ctx.db, email, now);
    const joined = invites.find((invite) => statuses.get(invite._id) === "joined");
    if (joined !== undefined && account?._id === user._id) {
      return { from: "friend", invitedBy: await handleForUser(ctx, joined.inviterUserId) };
    }
  }

  const links = await ctx.db
    .query("phoneLinks")
    .withIndex("by_user", (q) => q.eq("userId", user._id))
    .take(10);
  const phones = [...new Set([...(user.phone === undefined ? [] : [user.phone]), ...links.map((link) => link.phone)])];
  const rows: Doc<"waitlist">[] = [];
  for (const email of emails) {
    const row = await ctx.db
      .query("waitlist")
      .withIndex("by_email", (q) => q.eq("email", email))
      .first();
    if (row !== null) rows.push(row);
  }
  for (const phone of phones) {
    const row = await ctx.db
      .query("waitlist")
      .withIndex("by_phone", (q) => q.eq("phone", phone))
      .first();
    if (row !== null) rows.push(row);
  }
  let best: typeof waitlistFromValidator.type | null = null;
  for (const row of rows) {
    const from = waitlistFromOf(row);
    if (best === null || WAITLIST_RANK[from] > WAITLIST_RANK[best]) best = from;
  }
  return { from: best ?? "direct", invitedBy: null };
}

/** Every account, waitlist row and referral invite the People page lists. */
export async function everyoneHandler(ctx: QueryCtx): Promise<ConsolePeople> {
  const now = Date.now();
  let truncated = false;

  // -- spend, per owner, over the window: the same split the AI costs report uses --
  const win = dayWindow(SPEND_DAYS, now);
  const budget = newBudget();
  const usage = await usageBetween(ctx, win.since, win.today, budget);
  const { accounts: spend } = await accountSpendOf(ctx, workspaceSpendOf(usage, win.today), budget);
  if (budget.truncated) truncated = true;

  // -- accounts ----------------------------------------------------------------
  const hidden = await archivedUserIds(ctx);
  const users = await ctx.db.query("users").order("desc").take(ACCOUNT_SCAN);
  if (users.length >= ACCOUNT_SCAN) truncated = true;
  const identities = new Set<string>();
  const accounts: ConsolePeople["accounts"] = [];
  for (const user of users) {
    const person = await personOf(ctx, user, hidden.has(user._id));
    for (const email of person.emails) identities.add(email);
    for (const phone of [...(person.phone === null ? [] : [person.phone]), ...person.textingPhones]) {
      identities.add(phone);
    }

    const grants = await ctx.db
      .query("oauthGrants")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .take(GRANT_SCAN);
    if (grants.length >= GRANT_SCAN) truncated = true;
    let lastSeenAt: number | null = null;
    for (const grant of grants) {
      if (grant.lastUsedAt !== undefined && (lastSeenAt === null || grant.lastUsedAt > lastSeenAt)) {
        lastSeenAt = grant.lastUsedAt;
      }
    }
    const active = grants
      .filter((grant) => grant.status === "active")
      .sort((a, b) => (b.lastUsedAt ?? -1) - (a.lastUsedAt ?? -1));
    const clients: ConsolePeople["accounts"][number]["clients"] = [];
    for (const grant of active) {
      const client = await ctx.db
        .query("oauthClients")
        .withIndex("by_clientId", (q) => q.eq("clientId", grant.clientId))
        .first();
      clients.push({ name: client?.clientName ?? grant.clientId, lastUsedAt: grant.lastUsedAt ?? null });
    }

    const came = await cameFromFor(ctx, user);
    const account = spend.get(String(user._id));
    accounts.push({
      userId: person.userId,
      name: person.name,
      handle: person.username,
      emails: person.emails,
      phone: person.phone,
      textingPhones: person.textingPhones,
      joinedAt: person.joinedAt,
      archived: person.archived,
      lastSeenAt,
      from: came.from,
      invitedBy: came.invitedBy,
      workspaces: person.workspaces.map((workspace) => ({
        slug: workspace.slug,
        kind: workspace.kind,
        role: workspace.role,
      })),
      clients,
      aiUsd: account === undefined ? 0 : usd(account.micro),
      aiByFeature: account === undefined
        ? []
        : [...account.byFeature.entries()]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .map(([feature, micro]) => ({ label: featureLabel(feature), usd: usd(micro) })),
    });
  }

  // -- waitlist: rows nobody holds yet -------------------------------------------
  const untold = new Set<Id<"waitlist">>((await untoldRows(ctx)).map((row) => row._id));
  const rows = await ctx.db.query("waitlist").order("desc").take(WAITLIST_SCAN);
  if (rows.length >= WAITLIST_SCAN) truncated = true;
  const waitlist: ConsolePeople["waitlist"] = [];
  for (const row of rows) {
    if (identities.has(row.email ?? "") || identities.has(row.phone ?? "")) continue;
    waitlist.push({
      id: row._id,
      who: row.email ?? row.phone ?? "",
      status: row.status,
      joinedAt: row.joinedAt,
      from: waitlistFromOf(row),
      campaign: adCampaignLabel(row.campaign),
      useFor: row.useFor ?? null,
      told: !untold.has(row._id),
    });
  }

  // -- invites that did not join ------------------------------------------------
  const sent = await ctx.db
    .query("referralInvites")
    .withIndex("by_createdAt")
    .order("desc")
    .take(INVITE_SCAN);
  if (sent.length >= INVITE_SCAN) truncated = true;
  const statusesByEmail = new Map<string, Map<Id<"referralInvites">, InviteStatus>>();
  const handles = new Map<Id<"users">, string | null>();
  const invites: ConsolePeople["invites"] = [];
  for (const invite of sent) {
    let statuses = statusesByEmail.get(invite.email);
    if (statuses === undefined) {
      statuses = (await invitesTo(ctx.db, invite.email, now)).statuses;
      statusesByEmail.set(invite.email, statuses);
    }
    const status = statuses.get(invite._id) ?? "expired";
    if (status === "joined") continue;
    let inviterHandle = handles.get(invite.inviterUserId);
    if (inviterHandle === undefined) {
      inviterHandle = await handleForUser(ctx, invite.inviterUserId);
      handles.set(invite.inviterUserId, inviterHandle);
    }
    invites.push({ id: invite._id, to: invite.email, inviterHandle, sentAt: invite.createdAt, status });
  }

  return {
    accounts,
    waitlist,
    invites,
    invitesOff: await invitesOff(ctx.db),
    truncated,
  };
}
