/**
 * Founding Premium: the first accounts are Premium at no charge.
 *
 * Decided by the owner (Dev2), 2026-10-17: "Our first 100 people are going to
 * be considered premium … because they're using the app and we need the
 * data." `docs/decisions/billing.md`, "Founding Premium".
 *
 * ## Granted once, to the account, in creation order
 *
 * A grant is a `foundingPremium` row, never deleted. Every new account
 * schedules the walk below (`auth.ts`, `onUserCreated`; scheduled so it can
 * never fail a sign-in), which grants every account still owed one, oldest
 * first, so accounts made before this shipped come ahead of the one signing
 * up now. An operator can run the same walk (`functions/foundingPremium.ts`,
 * `catchUp`) to reach them before the next sign-up. The cap counts rows, and
 * Convex mutations are serializable, so the 101st grant cannot be written: two sign-ups racing for
 * the last slot conflict and one retries to find it gone. Because the row
 * outlives its account, nobody's standing moves when somebody else leaves.
 *
 * ## What it gives: an active plan on the personal workspace
 *
 * Every Premium gate in this control plane reads one thing — the workspace's
 * plan is `active` (the built-in model and Tex's dreams through `jev/meter`,
 * usage, websites, custom domains). So a founding grant makes
 * its personal workspace's plan `active` with `founding: true`, through the
 * same activation the staging upgrade uses, and adds no second notion of
 * Premium for a gate to forget. A plan, here as everywhere, belongs to the
 * workspace: a shared workspace the founder makes later pays as it would.
 *
 * Nothing is charged: no checkout, no Stripe customer, and `startCheckout`
 * refuses a plan that is already active. A founder who was already paying is
 * marked founding and left as they are, because cancelling somebody's
 * subscription is theirs to do in the portal; once they do, `foundingStatus`
 * keeps the plan active. Nothing here deletes anything or touches the exit.
 */

import type { Doc, Id } from "../../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import { PERSONAS } from "../../stagingPersonas";
import { recordAudit } from "../audit";
import { isAdminEmail } from "../admin";
import { planIsPaying, type PlanStatus } from "../premium";
import { APP_REVIEW_PHONE, REVIEWER_EMAIL } from "../reviewerAccount";
import { TEST_ACCOUNT_EMAIL } from "../testAccount";
import { planFor, statusOf } from "./plan";
import { activateWithoutStripe } from "./upgradeSelection";

/** How many accounts are founding. The only place the number lives. */
export const FOUNDING_PREMIUM_ACCOUNTS = 100;

type Env = Record<string, string | undefined>;

/**
 * Staff, the production CUJ account, the directory reviewer and the staging
 * personas take no founding slot. Read from the address alone, unverified on
 * purpose: excluding is the safe direction, and costs a stranger who types
 * one of these addresses only a free plan.
 */
export function excludedFromFounding(
  user: Pick<Doc<"users">, "email" | "phone">,
  env: Env = process.env,
): boolean {
  if (user.phone === APP_REVIEW_PHONE) return true;
  const email = user.email?.trim().toLowerCase();
  if (email === undefined || email === "") return false;
  if (email === TEST_ACCOUNT_EMAIL || email === REVIEWER_EMAIL) return true;
  if (PERSONAS.some((persona) => email === `${persona}@supa.media`)) return true;
  return isAdminEmail(email, env);
}

export async function foundingGrantOf(
  ctx: QueryCtx,
  userId: Id<"users">,
): Promise<Doc<"foundingPremium"> | null> {
  return await ctx.db
    .query("foundingPremium")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
}

/** What a Stripe event may set on this plan: never less than active on a founding one. */
export function foundingStatus(
  plan: Pick<Doc<"workspacePlans">, "founding">,
  status: PlanStatus,
): PlanStatus {
  return plan.founding === true && !planIsPaying(status) ? "active" : status;
}

/**
 * Make one of a founder's personal workspaces Premium. Idempotent: a plan
 * already founding is left alone, and one paying through Stripe is only
 * marked (see the header).
 */
export async function applyFoundingPremium(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  userId: Id<"users">,
): Promise<void> {
  const plan = await planFor(ctx, workspaceId);
  if (plan?.founding === true) return;
  if (plan !== null && planIsPaying(statusOf(plan))) {
    await ctx.db.patch(plan._id, { founding: true, updatedAt: Date.now() });
  } else {
    await activateWithoutStripe(ctx, workspaceId, { founding: true });
  }
  await recordAudit(ctx, {
    workspaceId,
    actorUserId: userId,
    action: "billing.founding_plan_activated",
    details: { alreadyPaying: plan !== null && planIsPaying(statusOf(plan)) },
  });
}

async function applyToPersonalWorkspaces(ctx: MutationCtx, userId: Id<"users">): Promise<void> {
  const memberships = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(500);
  for (const membership of memberships) {
    if (membership.role !== "owner") continue;
    const workspace = await ctx.db.get(membership.workspaceId);
    if (workspace?.kind === "personal" && workspace.createdBy === userId) {
      await applyFoundingPremium(ctx, workspace._id, userId);
    }
  }
}

/**
 * Grant founding Premium to every account still owed one, oldest first, until
 * the cap. Resumes after the newest account already granted, so the walk is
 * short once it has run. Returns how many grants it wrote.
 */
export async function catchUpFoundingPremium(
  ctx: MutationCtx,
  env: Env = process.env,
): Promise<number> {
  const last = await ctx.db.query("foundingPremium").withIndex("by_seq").order("desc").first();
  let seq = last?.seq ?? 0;
  if (seq >= FOUNDING_PREMIUM_ACCOUNTS) return 0;
  const users =
    last === null
      ? ctx.db.query("users")
      : ctx.db.query("users").withIndex("by_creation_time", (q) => q.gt("_creationTime", last.accountCreatedAt));
  let granted = 0;
  for await (const user of users) {
    if (seq >= FOUNDING_PREMIUM_ACCOUNTS) break;
    if (excludedFromFounding(user, env)) continue;
    if ((await foundingGrantOf(ctx, user._id)) !== null) continue;
    seq += 1;
    await ctx.db.insert("foundingPremium", {
      userId: user._id,
      seq,
      accountCreatedAt: user._creationTime,
      grantedAt: Date.now(),
    });
    await applyToPersonalWorkspaces(ctx, user._id);
    granted += 1;
  }
  return granted;
}
