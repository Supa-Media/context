/**
 * MADE-UP GROUP CHATS FOR THE LAB (Dev, 2026-11-24: "a place in labs where I can test out all these things and simulate a
 * fake group chat": everyone on Context, a mix of people on Context and not, guests invited by number, people who own
 * or belong to different workspaces, Tex dropped into a chat already going).
 *
 * A made-up chat runs on a pull request's preview only, because only there are made-up accounts and workspaces safe to
 * make, and only there do Tex's real group rules (`textGroups.ts` `applyGroupTurn`: reach, blockers, the person who
 * brought Tex in, the one introduction) run on them unchanged. This file makes the people and their memberships a chat
 * asks for; it decides nothing about what the chat may reach, which stays in `lib/textGroupReach.ts` alone.
 *
 * `makeWorld` is idempotent per test chat (`key`): called again with the chat's people (someone joined), it adds whoever
 * is new and puts every made-up person's roles as asked. Each person is made once per test chat, so two test chats
 * never share a person, and their roles never fight.
 *
 *  - "on": an account (a user, a personal workspace whose slug is their handle, and their number on the one list,
 *    `phoneLinks`), a member of each seeded shared workspace (`lib/personaSeed.ts`) it names, at that role.
 *  - "invited": no account, a pending phone invitation to the one workspace it names.
 *  - "off": no account, a number nobody has.
 *
 * Numbers are the texts simulator's (`+1 AAA 555 01NN`, `packages/tex/worker/simulatorLog.ts` `SIMULATED_PHONE`): never
 * a real line. Guarded by `isIsolatedPreview` on every call: production and staging answer `refused` and write nothing.
 */

import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internalMutation } from "./lib/rowWatch/mutations";
import { isIsolatedPreview } from "./lib/previewDeployment";
import { claimName, findName } from "./lib/nameClaims";
import { groupKeyOf } from "./textGroups";
import { isPhoneNumber, personalWorkspaceOf } from "./textLinks";

/** The seeded shared workspaces a made-up person can be put in (`lib/personaSeed.ts` `FIXTURES`). */
export const WORLD_WORKSPACES = ["lumio", "maison-solenne", "common-ground"] as const;
export type WorldSlug = (typeof WORLD_WORKSPACES)[number];
export const MAX_WORLD_PEOPLE = 8;
const MAX_NAME = 40;
const KEY = /^[0-9a-f]{16,64}$/;
const SIM_PHONE = /^\+1[2-9]\d{2}55501\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

const role = v.union(v.literal("owner"), v.literal("editor"), v.literal("member"));
const personValidator = v.object({
  name: v.string(),
  account: v.union(v.literal("on"), v.literal("off"), v.literal("invited")),
  /** "on": each seeded workspace they are in, and their role there. */
  roles: v.optional(v.record(v.string(), role)),
  /** "invited": the workspace whose phone invitation they hold, and its role. */
  invited: v.optional(v.object({ slug: v.string(), role: v.union(v.literal("editor"), v.literal("member")) })),
});
const speaksUp = v.union(v.literal("off"), v.literal("quiet"), v.literal("attentive"), v.literal("followAlong"), v.literal("helpful"));

export type WorldPerson = { name: string; account: "on" | "off" | "invited"; roles?: Record<string, "owner" | "editor" | "member">; invited?: { slug: string; role: "editor" | "member" } };
export type WorldAnswer =
  | { status: "ok"; groupKey: string; people: { name: string; account: WorldPerson["account"]; phone: string; handle: string | null }[] }
  | { status: "refused"; error: string }
  | { status: "bad_request"; error: string };

/** A display name, on one line, or null. */
export function cleanPersonName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
  return /^[\p{L}\p{N}][\p{L}\p{N} .'\-]*$/u.test(name) ? name : null;
}

/** What a made-up chat's people ask for, checked whole: the first thing wrong, or null. */
export function worldProblem(people: readonly WorldPerson[]): string | null {
  if (people.length < 1 || people.length > MAX_WORLD_PEOPLE) return `a made-up chat has 1 to ${MAX_WORLD_PEOPLE} people besides Tex`;
  const names = new Set<string>();
  for (const person of people) {
    const name = cleanPersonName(person.name);
    if (name === null) return "each person needs a name: letters, numbers, spaces, . ' -";
    if (["tex", "context", "you"].includes(name.toLowerCase())) return `"${name}" is Tex's or the Lab's name`;
    if (names.has(name.toLowerCase())) return `two people are called ${name}`;
    names.add(name.toLowerCase());
    for (const [slug] of Object.entries(person.roles ?? {})) if (!(WORLD_WORKSPACES as readonly string[]).includes(slug)) return `no made-up workspace is called ${slug}`;
    if (person.account !== "on" && Object.keys(person.roles ?? {}).length > 0) return `${name} has no account, so has no role in a workspace`;
    if (person.account === "invited" && (person.invited === undefined || !(WORLD_WORKSPACES as readonly string[]).includes(person.invited.slug))) return `${name} is invited by number: name the workspace`;
    if (person.account !== "invited" && person.invited !== undefined) return `only someone invited by number has an invitation`;
  }
  return null;
}

/** A number of the simulator's from a seed: `+1 AAA 555 01NN`, AAA 200 to 999. */
export function simPhoneOf(seed: number): string {
  const n = Math.abs(Math.trunc(seed)) % (800 * 100);
  return `+1${200 + Math.floor(n / 100)}55501${String(n % 100).padStart(2, "0")}`;
}

/** A short stable number from text (FNV-1a), for a person's number and handle. */
export function seedOf(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

/** The handle a made-up person asks for: their first name, lowercased, and a few letters of the chat. */
export function handleFor(name: string, key: string, attempt: number): string {
  const first = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim().split(" ")[0] || "person";
  return `${first.slice(0, 20)}-${key.slice(attempt * 4, attempt * 4 + 4)}`;
}

async function freePhone(ctx: MutationCtx, seed: number, taken: Set<string>): Promise<string> {
  for (let i = 0; i < 50; i += 1) {
    const phone = simPhoneOf(seed + i * 7919);
    if (taken.has(phone)) continue;
    const linked = await ctx.db.query("phoneLinks").withIndex("by_phone", (q) => q.eq("phone", phone)).first();
    if (linked === null) return phone;
  }
  throw new Error("no free simulator number");
}

/** The made-up person's account for this chat, made the first time: user, personal workspace (their handle) and number. */
async function accountFor(ctx: MutationCtx, key: string, name: string, phone: string, now: number): Promise<{ userId: Id<"users">; handle: string | null }> {
  const email = `lab-${key.slice(0, 12)}-${seedOf(name.toLowerCase()).toString(16)}@lab-world.invalid`;
  const existing = await ctx.db.query("users").withIndex("by_email", (q) => q.eq("email", email)).unique();
  const userId = existing?._id ?? (await ctx.db.insert("users", { email, emailVerificationTime: now, name, isActive: true, createdAt: now }));
  if ((await ctx.db.query("phoneLinks").withIndex("by_user", (q) => q.eq("userId", userId)).first()) === null) {
    await ctx.db.insert("phoneLinks", { userId, phone, linkedAt: now, via: "text" });
  }
  const own = await personalWorkspaceOf(ctx, userId);
  if (own !== null) return { userId, handle: (await ctx.db.get(own))?.slug ?? null };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const slug = handleFor(name, key, attempt);
    if ((await findName(ctx, slug)) !== null) continue;
    const workspaceId = await ctx.db.insert("workspaces", { slug, displayName: name, createdBy: userId, kind: "personal", structureTemplate: "para", createdAt: now, updatedAt: now });
    try {
      await claimName(ctx, slug, userId, { kind: "workspace", workspaceId });
    } catch {
      await ctx.db.delete(workspaceId);
      continue;
    }
    await ctx.db.insert("workspaceMembers", { workspaceId, userId, role: "owner", joinedAt: now });
    return { userId, handle: slug };
  }
  return { userId, handle: null };
}

/** Puts a made-up person in each seeded workspace at the role asked, and out of the others. */
async function setRoles(ctx: MutationCtx, userId: Id<"users">, roles: Record<string, "owner" | "editor" | "member">, seeded: Map<WorldSlug, Doc<"workspaces">>, now: number): Promise<void> {
  for (const [slug, workspace] of seeded) {
    const asked = roles[slug];
    const member = await ctx.db.query("workspaceMembers").withIndex("by_workspace_user", (q) => q.eq("workspaceId", workspace._id).eq("userId", userId)).unique();
    if (asked !== undefined && member === null) await ctx.db.insert("workspaceMembers", { workspaceId: workspace._id, userId, role: asked, joinedAt: now });
    else if (asked !== undefined && member !== null && member.role !== asked) await ctx.db.patch(member._id, { role: asked });
    else if (asked === undefined && member !== null) await ctx.db.delete(member._id);
  }
}

/** A pending phone invitation for `phone` to `workspace` at `role`, the only pending one for that number there. */
async function inviteByNumber(ctx: MutationCtx, workspace: Doc<"workspaces">, phone: string, inviteRole: "editor" | "member", now: number): Promise<void> {
  const pending = await ctx.db.query("workspaceInvitations").withIndex("by_workspace_status", (q) => q.eq("workspaceId", workspace._id).eq("status", "pending")).collect();
  const mine = pending.filter((row) => row.inviteeKind === "phone" && row.invitee === phone);
  if (mine.length === 1 && mine[0].role === inviteRole && mine[0].expiresAt > now + DAY_MS) return;
  for (const row of mine) await ctx.db.patch(row._id, { status: "revoked", respondedAt: now });
  await ctx.db.insert("workspaceInvitations", { workspaceId: workspace._id, inviteeKind: "phone", invitee: phone, role: inviteRole, invitedBy: workspace.createdBy, token: crypto.randomUUID(), status: "pending", expiresAt: now + 7 * DAY_MS, createdAt: now });
}

/** Makes (or brings up to date) one test chat's made-up people, and its chat's row as set up. */
export const makeWorld = internalMutation({
  args: {
    key: v.string(),
    line: v.string(),
    groupId: v.string(),
    people: v.array(personValidator),
    /** Index into `people` of the person who brought Tex in; none leaves it to the first account holder who tags Tex. */
    sponsor: v.optional(v.number()),
    speaksUp: v.optional(speaksUp),
    /** Tex already said hello here: no introduction on its first turn. */
    introduced: v.optional(v.boolean()),
  },
  returns: v.any(),
  handler: async (ctx, args): Promise<WorldAnswer> => {
    if (!isIsolatedPreview()) return { status: "refused", error: "Made-up group chats run only on a pull request's preview." };
    if (!KEY.test(args.key) || !isPhoneNumber(args.line) || args.groupId.length === 0 || args.groupId.length > 200) return { status: "bad_request", error: "bad chat" };
    const problem = worldProblem(args.people);
    if (problem !== null) return { status: "bad_request", error: problem };
    const now = Date.now();
    const seeded = new Map<WorldSlug, Doc<"workspaces">>();
    for (const slug of WORLD_WORKSPACES) {
      const claim = await findName(ctx, slug);
      const workspace = claim?.workspaceId ? await ctx.db.get(claim.workspaceId) : null;
      if (workspace === null || workspace.kind !== "shared") return { status: "refused", error: `the preview has no ${slug} workspace yet: its seed hasn't run` };
      seeded.set(slug, workspace);
    }
    const taken = new Set<string>();
    const people: { name: string; account: WorldPerson["account"]; phone: string; handle: string | null }[] = [];
    const users: (Id<"users"> | null)[] = [];
    for (const person of args.people) {
      const name = cleanPersonName(person.name)!;
      const phone = await freePhone(ctx, seedOf(`${args.key}:${name.toLowerCase()}`), taken);
      taken.add(phone);
      if (person.account === "on") {
        const { userId, handle } = await accountFor(ctx, args.key, name, phone, now);
        await setRoles(ctx, userId, person.roles ?? {}, seeded, now);
        const linked = await ctx.db.query("phoneLinks").withIndex("by_user", (q) => q.eq("userId", userId)).first();
        people.push({ name, account: "on", phone: linked?.phone ?? phone, handle });
        users.push(userId);
      } else {
        if (person.account === "invited" && person.invited !== undefined) await inviteByNumber(ctx, seeded.get(person.invited.slug as WorldSlug)!, phone, person.invited.role, now);
        people.push({ name, account: person.account, phone, handle: null });
        users.push(null);
      }
    }
    if (people.some((p) => !SIM_PHONE.test(p.phone))) return { status: "refused", error: "a made-up person got a number outside the simulator's" };
    const groupKey = await groupKeyOf(args.line, args.groupId);
    const row = await ctx.db.query("textGroups").withIndex("by_key", (q) => q.eq("groupKey", groupKey)).unique();
    const id = row?._id ?? (await ctx.db.insert("textGroups", { groupKey, lastSeenAt: now }));
    const sponsor = args.sponsor !== undefined ? users[args.sponsor] ?? null : null;
    // Set up once, when the chat is made: a later call (someone joining) leaves what the chat's own texts changed.
    if (row === null) {
      await ctx.db.patch(id, {
        ...(args.speaksUp !== undefined ? { speaksUp: args.speaksUp, speaksUpSetBy: "lab", speaksUpSetAt: now } : {}),
        ...(args.introduced === true ? { introducedAt: now } : {}),
        ...(sponsor !== null ? { sponsorId: sponsor } : {}),
      });
    }
    return { status: "ok", groupKey, people };
  },
});
