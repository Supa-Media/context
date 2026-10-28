/**
 * The staff console's second factor, as `requireAdmin` asks it
 * (`functions/staffSecondFactor.ts` holds the enrollment and the code checks;
 * docs/decisions/identity-and-access/staff-second-factor.md argues it).
 *
 * The email code that signs a person in is one factor: whoever reads that
 * mailbox. A second email code would be the same factor again, so the second
 * one is an authenticator app (TOTP), checked per session.
 *
 * Rollout, so nobody is locked out by a deploy:
 *  - **Enrolled staff always step up.** Once a person has confirmed a key by
 *    typing a code from it, every staff page asks their session for a code,
 *    whatever the deployment says. Enrolling only binds the person who just
 *    proved they hold the key.
 *  - **`STAFF_SECOND_FACTOR=required` closes the door on the rest.** Staff
 *    with no confirmed key can then only enroll. Until it is set they keep
 *    working and the console asks them to enroll. Set it once
 *    `staffSecondFactor:census` says every staff account is enrolled.
 *  - **A lost phone is a deploy-time act**, like `ADMIN_EMAILS` itself:
 *    `npx convex run functions/staffSecondFactor:resetForEmail` by somebody
 *    holding the deploy key. Nothing the console runs can remove a factor.
 */

import type { Doc, Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { requireEncryptionKey } from "./crypto";
import { liveSessionOf } from "./emailProof";

export const STAFF_SECOND_FACTOR_ENV_VAR = "STAFF_SECOND_FACTOR";
/** How long one code opens the staff pages for one session. */
export const STAFF_STEP_UP_MS = 12 * 60 * 60 * 1000;
/** Wrong codes allowed per window before the account waits out the window. */
export const STAFF_WRONG_TRIES = 5;
export const STAFF_TRIES_WINDOW_MS = 15 * 60 * 1000;

const KEY_LABEL = "context/staff-second-factor/v1";

export function secondFactorRequired(env: Record<string, string | undefined> = process.env): boolean {
  return env[STAFF_SECOND_FACTOR_ENV_VAR]?.trim().toLowerCase() === "required";
}

async function hmac(key: BufferSource, message: string): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(message)));
}

/**
 * The authenticator key for one enrollment: 20 bytes derived from the storage
 * key, the account and the row's nonce, so no table holds it. Null on a
 * deployment with no storage key, which then has no second factor to offer.
 * Rotating the storage key changes every key: staff re-enroll after one.
 */
export async function staffFactorKey(userId: Id<"users">, nonce: string): Promise<Uint8Array | null> {
  let material: string;
  try {
    material = requireEncryptionKey();
  } catch {
    return null;
  }
  const derived = await hmac(new TextEncoder().encode(material), KEY_LABEL);
  return (await hmac(derived as BufferSource, `${userId}:${nonce}`)).slice(0, 20);
}

export async function staffFactorOf(ctx: QueryCtx, userId: Id<"users">): Promise<Doc<"staffSecondFactors"> | null> {
  return await ctx.db
    .query("staffSecondFactors")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
}

/** Whether this request's live session typed a code recently enough. */
export async function hasStaffStepUp(ctx: QueryCtx, userId: Id<"users">): Promise<boolean> {
  const sessionId = await liveSessionOf(ctx, userId);
  if (sessionId === null) return false;
  const stepUp = await ctx.db
    .query("staffStepUps")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .unique();
  return stepUp !== null && stepUp.userId === userId && stepUp.until > Date.now();
}

export type StaffFactorStanding = "enroll" | "step_up" | "open";

/**
 * What a staff account must do before staff pages open: `open`, `step_up`
 * (enrolled, this session has no live code), or `enroll` (no confirmed key
 * while the deployment requires one). Staff without a key on a deployment
 * that does not require one are `open`; the console asks them to enroll.
 */
export async function staffFactorStanding(
  ctx: QueryCtx,
  userId: Id<"users">,
  env: Record<string, string | undefined> = process.env,
): Promise<StaffFactorStanding> {
  const factor = await staffFactorOf(ctx, userId);
  if (factor?.confirmedAt !== undefined) return (await hasStaffStepUp(ctx, userId)) ? "open" : "step_up";
  return secondFactorRequired(env) ? "enroll" : "open";
}
