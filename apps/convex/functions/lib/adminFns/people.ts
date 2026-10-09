/**
 * The staff console's People tab: who somebody is, and their phone.
 *
 * Dev2 (2026-10-09), before sign-in moves to phone numbers: "let me go in and
 * put in people's phone numbers and see the associated emails, their
 * usernames, the workspaces they have access to, and I can update people's
 * phone numbers". Staff know almost everybody's number, so typing it here is
 * what lets those people skip the texted code.
 *
 * Handlers only. Each exported function in `functions/admin.ts` authorizes
 * with `requireAdmin` inline before calling one of these — see that file's
 * header and `__tests__/adminSurface.test.ts`.
 *
 * A phone typed here counts as confirmed, as one confirmed by text does: the
 * person staff vouch for is the one they know. One phone is still one person,
 * so a number another account holds is refused, never moved.
 */

import { v } from "convex/values";
import type { Doc, Id } from "../../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import type { AdminActor } from "../admin";
import { normalizePhone, phoneHeldByAnother } from "../phoneCheck";
import { attachedEmailsOf } from "../signInEmails";
import { recordAdminAudit } from "./audit";

/** People one search returns. */
export const PEOPLE_PAGE = 50;
/** Accounts a search reads through; far above a private beta's size. */
const SCAN_LIMIT = 5000;
/** Workspaces listed per person. */
const WORKSPACE_LIMIT = 100;

const roleValidator = v.union(v.literal("owner"), v.literal("editor"), v.literal("member"));

export const personValidator = v.object({
  userId: v.id("users"),
  name: v.union(v.string(), v.null()),
  username: v.union(v.string(), v.null()),
  /** The address mail goes to first, then every other one they sign in with. */
  emails: v.array(v.string()),
  phone: v.union(v.string(), v.null()),
  /** Phones linked for texting the assistant, which also stand for this person. */
  textingPhones: v.array(v.string()),
  joinedAt: v.number(),
  workspaces: v.array(
    v.object({
      slug: v.string(),
      name: v.string(),
      kind: v.union(v.literal("personal"), v.literal("shared")),
      role: roleValidator,
    }),
  ),
});

export type Person = typeof personValidator.type;

export const setPhoneResultValidator = v.object({
  status: v.union(v.literal("saved"), v.literal("removed"), v.literal("invalid"), v.literal("taken"), v.literal("not_found")),
  phone: v.optional(v.string()),
  /** Who holds the number, when it is taken: their main address. */
  heldBy: v.optional(v.string()),
});

type SetPhoneResult = typeof setPhoneResultValidator.type;

async function usernameOf(ctx: QueryCtx, userId: Id<"users">): Promise<string | null> {
  const row = await ctx.db
    .query("names")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .filter((q) => q.eq(q.field("kind"), "user"))
    .first();
  return row?.name ?? null;
}

async function personOf(ctx: QueryCtx, user: Doc<"users">): Promise<Person> {
  const emails = [
    ...(user.email === undefined ? [] : [user.email.toLowerCase()]),
    ...(await attachedEmailsOf(ctx, user._id)),
  ];
  const links = await ctx.db
    .query("phoneLinks")
    .withIndex("by_user", (q) => q.eq("userId", user._id))
    .take(10);
  const memberships = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_user", (q) => q.eq("userId", user._id))
    .take(WORKSPACE_LIMIT);
  const workspaces: Person["workspaces"] = [];
  for (const membership of memberships) {
    const workspace = await ctx.db.get(membership.workspaceId);
    if (workspace === null) continue;
    workspaces.push({
      slug: workspace.slug,
      name: workspace.displayName,
      kind: workspace.kind,
      role: membership.role,
    });
  }
  return {
    userId: user._id,
    name: user.name ?? null,
    username: await usernameOf(ctx, user._id),
    emails: [...new Set(emails)],
    phone: user.phone ?? null,
    textingPhones: links.map((link) => link.phone),
    joinedAt: user._creationTime,
    workspaces,
  };
}

/** The digits of a typed number, when it reads as one (`+1 555-0100` → `15550100`). */
function phoneDigits(search: string): string | null {
  if (!/^[+\d\s().-]+$/.test(search)) return null;
  const digits = search.replace(/\D/g, "");
  return digits.length >= 3 ? digits : null;
}

/**
 * Everybody matching `search`: a name, an address, an @username or a phone,
 * any part of it. Empty means the newest accounts.
 */
export async function listPeopleHandler(ctx: QueryCtx, search: string): Promise<Person[]> {
  const query = search.trim().toLowerCase();
  if (query === "") {
    const newest = await ctx.db.query("users").order("desc").take(PEOPLE_PAGE);
    return await Promise.all(newest.map((user) => personOf(ctx, user)));
  }

  const found = new Set<Id<"users">>();
  const digits = phoneDigits(query);
  const users = await ctx.db.query("users").order("desc").take(SCAN_LIMIT);
  for (const user of users) {
    const text = [user.email ?? "", user.name ?? ""].join("\n").toLowerCase();
    if (text.includes(query)) found.add(user._id);
    else if (digits !== null && (user.phone ?? "").includes(digits)) found.add(user._id);
  }
  if (digits !== null) {
    for (const link of await ctx.db.query("phoneLinks").take(SCAN_LIMIT)) {
      if (link.phone.includes(digits)) found.add(link.userId);
    }
  }
  for (const row of await ctx.db.query("signInEmails").take(SCAN_LIMIT)) {
    if (row.email.includes(query)) found.add(row.userId);
  }
  const handle = query.replace(/^@/, "");
  if (handle !== "") {
    const names = await ctx.db
      .query("names")
      .withIndex("by_name", (q) => q.gte("name", handle).lt("name", `${handle}￿`))
      .take(PEOPLE_PAGE);
    for (const row of names) if (row.kind === "user" && row.userId !== undefined) found.add(row.userId);
  }

  const people: Person[] = [];
  for (const userId of found) {
    if (people.length >= PEOPLE_PAGE) break;
    const user = await ctx.db.get(userId);
    if (user !== null) people.push(await personOf(ctx, user));
  }
  return people.sort((a, b) => b.joinedAt - a.joinedAt);
}

/** Last four digits only: the console's own trail never keeps whole numbers. */
function lastFour(phone: string): string {
  return phone.slice(-4);
}

/**
 * Set, change or remove somebody's phone. `phone: null` removes it; a phone
 * linked for texting stays, since the person proved that one themselves.
 */
export async function setPhoneHandler(
  ctx: MutationCtx,
  actor: AdminActor,
  userId: Id<"users">,
  typed: string | null,
): Promise<SetPhoneResult> {
  const user = await ctx.db.get(userId);
  if (user === null) return { status: "not_found" };

  if (typed === null || typed.trim() === "") {
    if (user.phone === undefined && user.phoneVerificationTime === undefined) return { status: "removed" };
    await ctx.db.patch(userId, { phone: undefined, phoneVerificationTime: undefined });
    await recordAdminAudit(ctx, actor, "person.phone_removed", userId, {
      was: user.phone === undefined ? null : lastFour(user.phone),
    });
    return { status: "removed" };
  }

  const phone = normalizePhone(typed);
  if (phone === null) return { status: "invalid" };
  if (await phoneHeldByAnother(ctx, phone, userId)) {
    return { status: "taken", phone, heldBy: await holderOf(ctx, phone, userId) };
  }
  if (user.phone === phone && user.phoneVerificationTime !== undefined) return { status: "saved", phone };
  await ctx.db.patch(userId, { phone, phoneVerificationTime: Date.now() });
  await recordAdminAudit(ctx, actor, "person.phone_set", userId, {
    phone: lastFour(phone),
    was: user.phone === undefined ? null : lastFour(user.phone),
  });
  return { status: "saved", phone };
}

/** The main address of whoever else holds `phone`, for the refusal's sentence. */
async function holderOf(ctx: QueryCtx, phone: string, userId: Id<"users">): Promise<string | undefined> {
  const user = await ctx.db
    .query("users")
    .withIndex("by_phone", (q) => q.eq("phone", phone))
    .filter((q) => q.neq(q.field("_id"), userId))
    .first();
  if (user !== null) return user.email;
  const link = await ctx.db
    .query("phoneLinks")
    .withIndex("by_phone", (q) => q.eq("phone", phone))
    .filter((q) => q.neq(q.field("userId"), userId))
    .first();
  return link === null ? undefined : ((await ctx.db.get(link.userId))?.email ?? undefined);
}
