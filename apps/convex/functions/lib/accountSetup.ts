/**
 * Helpers for finishing account setup (`functions/accountSetup.ts`).
 *
 * A person who joined a shared workspace through their email domain has no
 * workspace of their own; the app asks for a name once and makes a personal
 * workspace from it. The pure parts (the name offered, the slug it starts
 * from) live here, unit-tested without a database.
 */

import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { checkAvailability } from "./nameClaims";
import { NAME_MAX_LENGTH } from "./names";
import { attachedEmailsOf } from "./signInEmails";
import { confirmedEmailsOf } from "./emailProof";
import { isFreshSingleEmailAccount } from "./freshSignup";

/** The slug stem for a name with nothing usable in it. */
const FALLBACK_STEM = "person";
/** Suffixed tries after the plain slug, before a random one. */
const SUFFIX_TRIES = 20;
const RANDOM_LENGTH = 6;

/** The name shown first on the setup screen: the account's own, else one from the email. */
export function suggestedNameFor(name: string | undefined, email: string | null): string {
  const own = name?.trim() ?? "";
  if (own.length > 0) return own;
  if (email === null) return "";
  const local = email.slice(0, Math.max(0, email.lastIndexOf("@")));
  return local
    .split(/[._]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * The slug a display name starts from: lower case, every run of characters
 * outside `a-z0-9` becomes one hyphen, no hyphen at either end, no longer
 * than a name may be. Never empty.
 */
export function slugBase(displayName: string): string {
  const slug = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, NAME_MAX_LENGTH)
    .replace(/-+$/, "");
  return slug.length > 0 ? slug : FALLBACK_STEM;
}

/** `stem` cut short enough that `suffix` still fits in a name, without a trailing hyphen. */
function withSuffix(stem: string, suffix: string): string {
  const cut = stem.slice(0, NAME_MAX_LENGTH - suffix.length).replace(/-+$/, "");
  return `${cut.length > 0 ? cut : FALLBACK_STEM}${suffix}`;
}

function randomSuffix(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(RANDOM_LENGTH));
  return `-${Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("")}`;
}

/**
 * A slug for a new personal workspace named `displayName`, free and not
 * reserved: the plain slug, then `-2` … `-20`, then a short random suffix.
 * Availability is the one the name picker uses (`checkAvailability`), so a
 * reserved word can never be claimed here.
 */
export async function availableSlug(ctx: MutationCtx | QueryCtx, displayName: string): Promise<string> {
  const stem = slugBase(displayName);
  if ((await checkAvailability(ctx, stem)).available) return stem;
  for (let n = 2; n <= SUFFIX_TRIES; n++) {
    const candidate = withSuffix(stem, `-${n}`);
    if ((await checkAvailability(ctx, candidate)).available) return candidate;
  }
  // Still no luck after the numbered tries: a random one is all but certain.
  return withSuffix(stem, randomSuffix());
}

/** The personal workspace this person owns, if any. Bounded: nobody owns more than the cap. */
export async function ownedPersonalWorkspace(
  ctx: QueryCtx,
  userId: Id<"users">,
): Promise<Doc<"workspaces"> | null> {
  const memberships = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(500);
  for (const membership of memberships) {
    if (membership.role !== "owner") continue;
    const workspace = await ctx.db.get(membership.workspaceId);
    if (workspace !== null && workspace.kind === "personal") return workspace;
  }
  return null;
}

/** Whether this person is in some workspace through an email domain. */
export async function joinedThroughDomain(ctx: QueryCtx, userId: Id<"users">): Promise<boolean> {
  const memberships = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(500);
  return memberships.some((membership) => membership.viaDomain !== undefined);
}

/**
 * Whether somebody who just came in through a work domain still owes a
 * personal email (Dev, 2026-10-20: "they need their number first and then
 * their personal gmail"). Asked after setup makes their own workspace, because
 * connecting Gmail binds to it; `app/(app)/_layout.tsx` holds every page until
 * it is answered.
 *
 * Only inside the fresh sign-up window (`freshSignup.ts`), the same window in
 * which the address goes on without proof, typed or from Google. An older
 * account with only a work address is never walled off by a step it could not
 * finish without a code to that address, and is asked in Account settings
 * instead, as it always was.
 */
export async function needsPersonalEmail(
  ctx: QueryCtx,
  user: { _id: Id<"users">; _creationTime: number },
  now: number = Date.now(),
): Promise<boolean> {
  if (!(await joinedThroughDomain(ctx, user._id))) return false;
  return isFreshSingleEmailAccount({
    createdAt: user._creationTime,
    now,
    confirmedCount: (await confirmedEmailsOf(ctx, user._id)).length,
    attachedCount: (await attachedEmailsOf(ctx, user._id)).length,
  });
}

/** The domains this person joined workspaces through, lower case. */
export async function joinedDomains(ctx: QueryCtx, userId: Id<"users">): Promise<Set<string>> {
  const memberships = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(500);
  return new Set(memberships.flatMap((membership) => (membership.viaDomain === undefined ? [] : [membership.viaDomain])));
}
