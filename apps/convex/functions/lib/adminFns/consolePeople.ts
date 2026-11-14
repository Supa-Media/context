/**
 * The staff console's People page, read in pages. Accounts with their
 * workspaces and how they came in; waitlist rows nobody holds yet; referral
 * invites; and the usage figures (AI spend, MCP clients) per account.
 *
 * Handlers only. `functions/consolePeople.ts` authorizes with `requireAdmin`
 * before calling each one.
 *
 * Each list is a Convex page (`paginate`), so no single query reads the whole
 * table: a few hundred accounts would exceed a query's read limit if one call
 * did it all. The usage figures are split out (`peopleUsageHandler`) because
 * they change constantly: an OAuth grant's `lastUsedAt` is patched on every MCP
 * call, so a page that also carried it would recompute on every call too.
 */

import { adCampaignLabel } from "@context/shared";
import { paginationResultValidator, type PaginationOptions } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import { handleForUser } from "../identities";
import { invitesOff, invitesTo, type InviteStatus } from "../referrals";
import { attachedEmailsOf } from "../signInEmails";
import { dayWindow, featureLabel, newBudget, usageBetween, usd } from "./aiCostsRead";
import { accountSpendOf, workspaceSpendOf } from "./aiCostsReport";
import { archivedUserIds, personOf } from "./people";

/**
 * The most rows one call of each page query reads. Convex allows about 4,096 reads per call; an
 * account costs roughly 15-20 (`personOf` + `cameFromFor`), a waitlist row at most 2, an invite
 * about 4. Requests for more are cut to these, whatever the client asks.
 */
export const PAGE_MAX = { accounts: 100, waitlist: 250, invites: 250 } as const;
const capped = (opts: PaginationOptions, max: number): PaginationOptions => ({ ...opts, numItems: Math.max(1, Math.min(opts.numItems, max)) });

/**
 * Grants one usage read may scan. Every grant in the table, not one account's:
 * the client list is per person, so the whole table is the only honest source.
 * Hitting it sets `truncated`, and the page says so.
 */
export const GRANT_SCAN = 10_000;
/** The AI spend window the page shows. */
const SPEND_DAYS = 30;
const MINUTE_MS = 60_000;

const roleValidator = v.union(v.literal("owner"), v.literal("editor"), v.literal("member"));

export const fromValidator = v.union(
  v.literal("waitlist"),
  v.literal("friend"),
  v.literal("ad"),
  v.literal("staff"),
  v.literal("direct"),
);

const waitlistFromValidator = v.union(v.literal("waitlist"), v.literal("ad"), v.literal("staff"));

export const accountRowValidator = v.object({
  userId: v.id("users"),
  name: v.union(v.string(), v.null()),
  handle: v.union(v.string(), v.null()),
  emails: v.array(v.string()),
  phone: v.union(v.string(), v.null()),
  textingPhones: v.array(v.string()),
  joinedAt: v.number(),
  archived: v.boolean(),
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
});

export const waitlistRowValidator = v.object({
  id: v.id("waitlist"),
  who: v.string(),
  email: v.union(v.string(), v.null()),
  phone: v.union(v.string(), v.null()),
  status: v.union(v.literal("waiting"), v.literal("admitted"), v.literal("removed")),
  joinedAt: v.number(),
  from: waitlistFromValidator,
  campaign: v.union(v.string(), v.null()),
  useFor: v.union(v.string(), v.null()),
  /** False only for a let-in phone row that nobody has been texted about. */
  told: v.boolean(),
});

export const inviteRowValidator = v.object({
  id: v.id("referralInvites"),
  to: v.string(),
  inviterHandle: v.union(v.string(), v.null()),
  sentAt: v.number(),
  /** `joined` rows are included so a page is never short; the client drops them. */
  status: v.union(
    v.literal("pending"),
    v.literal("joined"),
    v.literal("expired"),
    v.literal("cancelled"),
    v.literal("revoked"),
  ),
});

export const peopleUsageValidator = v.object({
  invitesOff: v.boolean(),
  truncated: v.boolean(),
  spend: v.array(
    v.object({
      userId: v.id("users"),
      aiUsd: v.number(),
      aiByFeature: v.array(v.object({ label: v.string(), usd: v.number() })),
    }),
  ),
  clients: v.array(
    v.object({
      userId: v.id("users"),
      /** The newest use of any of this person's grants, active or revoked; rounded down to the minute. */
      lastSeenAt: v.union(v.number(), v.null()),
      /** Active grants only, newest use first. */
      clients: v.array(v.object({ name: v.string(), lastUsedAt: v.union(v.number(), v.null()) })),
    }),
  ),
});

export type AccountRow = typeof accountRowValidator.type;
export type WaitlistRow = typeof waitlistRowValidator.type;
export type InviteRow = typeof inviteRowValidator.type;
export type PeopleUsage = typeof peopleUsageValidator.type;
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

/** One page of accounts, newest first: identity, workspaces and how each came in. No usage. */
export async function accountsPageHandler(
  ctx: QueryCtx,
  paginationOpts: PaginationOptions,
): Promise<{ page: AccountRow[]; isDone: boolean; continueCursor: string }> {
  // One read of the archive list per page, shared by every row on it.
  const hidden = await archivedUserIds(ctx);
  const result = await ctx.db.query("users").order("desc").paginate(capped(paginationOpts, PAGE_MAX.accounts));
  const page: AccountRow[] = [];
  for (const user of result.page) {
    const person = await personOf(ctx, user, hidden.has(user._id));
    const came = await cameFromFor(ctx, user);
    page.push({
      userId: person.userId,
      name: person.name,
      handle: person.username,
      emails: person.emails,
      phone: person.phone,
      textingPhones: person.textingPhones,
      joinedAt: person.joinedAt,
      archived: person.archived,
      from: came.from,
      invitedBy: came.invitedBy,
      workspaces: person.workspaces.map((workspace) => ({
        slug: workspace.slug,
        kind: workspace.kind,
        role: workspace.role,
      })),
    });
  }
  return { page, isDone: result.isDone, continueCursor: result.continueCursor };
}

/**
 * Whether a waitlist row is told. Only a let-in phone row (no email) that has
 * no `admittedTextAt` and that no account holds can be untold: the same rule
 * `untoldRows` applies to the whole table, here checked one row at a time so
 * a page costs at most one lookup per row it shows.
 */
async function toldOf(ctx: QueryCtx, row: Doc<"waitlist">): Promise<boolean> {
  if (row.status !== "admitted" || row.phone === undefined || row.email !== undefined) return true;
  if (row.admittedTextAt !== undefined) return true;
  const holder = await ctx.db
    .query("users")
    .withIndex("by_phone", (q) => q.eq("phone", row.phone!))
    .first();
  return holder !== null;
}

/**
 * One page of waitlist rows, newest first. Rows an account already holds are
 * NOT removed here; the client dedupes against `accountsPage`.
 */
export async function waitlistPageHandler(
  ctx: QueryCtx,
  paginationOpts: PaginationOptions,
): Promise<{ page: WaitlistRow[]; isDone: boolean; continueCursor: string }> {
  const result = await ctx.db.query("waitlist").order("desc").paginate(capped(paginationOpts, PAGE_MAX.waitlist));
  const page: WaitlistRow[] = [];
  for (const row of result.page) {
    page.push({
      id: row._id,
      who: row.email ?? row.phone ?? "",
      email: row.email ?? null,
      phone: row.phone ?? null,
      status: row.status,
      joinedAt: row.joinedAt,
      from: waitlistFromOf(row),
      campaign: adCampaignLabel(row.campaign),
      useFor: row.useFor ?? null,
      told: await toldOf(ctx, row),
    });
  }
  return { page, isDone: result.isDone, continueCursor: result.continueCursor };
}

/** One page of referral invites, newest first, each with its status (joined included). */
export async function invitesPageHandler(
  ctx: QueryCtx,
  paginationOpts: PaginationOptions,
): Promise<{ page: InviteRow[]; isDone: boolean; continueCursor: string }> {
  const now = Date.now();
  const result = await ctx.db
    .query("referralInvites")
    .withIndex("by_createdAt")
    .order("desc")
    .paginate(capped(paginationOpts, PAGE_MAX.invites));
  // Statuses are per address, so one address's invites are read once per page.
  const statusesByEmail = new Map<string, Map<Id<"referralInvites">, InviteStatus>>();
  const handles = new Map<Id<"users">, string | null>();
  const page: InviteRow[] = [];
  for (const invite of result.page) {
    let statuses = statusesByEmail.get(invite.email);
    if (statuses === undefined) {
      statuses = (await invitesTo(ctx.db, invite.email, now)).statuses;
      statusesByEmail.set(invite.email, statuses);
    }
    let inviterHandle = handles.get(invite.inviterUserId);
    if (inviterHandle === undefined) {
      inviterHandle = await handleForUser(ctx, invite.inviterUserId);
      handles.set(invite.inviterUserId, inviterHandle);
    }
    page.push({
      id: invite._id,
      to: invite.email,
      inviterHandle,
      sentAt: invite.createdAt,
      status: statuses.get(invite._id) ?? "expired",
    });
  }
  return { page, isDone: result.isDone, continueCursor: result.continueCursor };
}

/** Round down to the minute. A grant's `lastUsedAt` moves on every MCP call; a minute is the coarsest unit the page needs. */
function minuteOf(time: number): number {
  return Math.floor(time / MINUTE_MS) * MINUTE_MS;
}

/**
 * The usage figures: each owner's AI spend over the window (the same split the
 * AI costs report uses), and each person's MCP clients. Times are rounded down
 * to the minute, so this answer changes only when a minute ticks, not on every
 * MCP call that patches a grant.
 */
export async function peopleUsageHandler(ctx: QueryCtx): Promise<PeopleUsage> {
  const now = Date.now();
  let truncated = false;

  // -- AI spend, per owner --------------------------------------------------------
  const win = dayWindow(SPEND_DAYS, now);
  const budget = newBudget();
  const usage = await usageBetween(ctx, win.since, win.today, budget);
  const { accounts } = await accountSpendOf(ctx, workspaceSpendOf(usage, win.today), budget);
  if (budget.truncated) truncated = true;
  const spend: PeopleUsage["spend"] = [...accounts.values()].map((account) => ({
    userId: account.id,
    aiUsd: usd(account.micro),
    aiByFeature: [...account.byFeature.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([feature, micro]) => ({ label: featureLabel(feature), usd: usd(micro) })),
  }));

  // -- MCP clients, per person: one bounded scan of every grant -------------------
  const grants = await ctx.db.query("oauthGrants").take(GRANT_SCAN);
  if (grants.length >= GRANT_SCAN) truncated = true;
  const people = new Map<Id<"users">, { lastSeenAt: number | null; active: Doc<"oauthGrants">[] }>();
  for (const grant of grants) {
    const person = people.get(grant.userId) ?? { lastSeenAt: null, active: [] };
    if (grant.lastUsedAt !== undefined) {
      const seen = minuteOf(grant.lastUsedAt);
      if (person.lastSeenAt === null || seen > person.lastSeenAt) person.lastSeenAt = seen;
    }
    if (grant.status === "active") person.active.push(grant);
    people.set(grant.userId, person);
  }
  // A client's name is looked up once however many people hold it.
  const names = new Map<string, string>();
  const clients: PeopleUsage["clients"] = [];
  for (const [userId, person] of people) {
    const active = [...person.active].sort((a, b) => (b.lastUsedAt ?? -1) - (a.lastUsedAt ?? -1));
    const named: PeopleUsage["clients"][number]["clients"] = [];
    for (const grant of active) {
      let name = names.get(grant.clientId);
      if (name === undefined) {
        const client = await ctx.db
          .query("oauthClients")
          .withIndex("by_clientId", (q) => q.eq("clientId", grant.clientId))
          .first();
        name = client?.clientName ?? grant.clientId;
        names.set(grant.clientId, name);
      }
      named.push({ name, lastUsedAt: grant.lastUsedAt === undefined ? null : minuteOf(grant.lastUsedAt) });
    }
    clients.push({ userId, lastSeenAt: person.lastSeenAt, clients: named });
  }

  return {
    invitesOff: await invitesOff(ctx.db),
    truncated,
    spend,
    clients,
  };
}

/** The paginated return shape every People list uses. */
export const accountsPageValidator = paginationResultValidator(accountRowValidator);
export const waitlistPageValidator = paginationResultValidator(waitlistRowValidator);
export const invitesPageValidator = paginationResultValidator(inviteRowValidator);
