/**
 * Invite-only sign-in: who is let in.
 *
 * Context is invite-only (Dev2, 2026-09-28). Anybody can put their address on
 * the waitlist; only an address that is **admitted** is mailed a sign-in code
 * or given a new account. That refusal is made on the server, through
 * `createSupaAuth`'s `admission` hooks in `apps/convex/auth.ts` — the page
 * drawing "you're on the list" is the explanation, never the lock.
 *
 * ## What admits an address
 *
 * `isAdmitted` is the whole rule, and every caller asks it rather than a piece
 * of it:
 *
 *  - `OPEN_SIGNUP=true` on the deployment admits everyone. For a self-hoster
 *    who wants the old open behaviour; unset, the deployment is invite-only.
 *  - An account that already exists. Turning the gate on never locks out
 *    anybody who was already here.
 *  - The staff allowlist (`ADMIN_EMAILS`), so a fresh deployment can always
 *    let its own operator in.
 *  - A pending, unexpired invitation to a workspace. A member inviting a
 *    teammate is letting them in; making them queue as well would break
 *    sharing.
 *  - A waitlist row staff have admitted.
 *  - A live referral: somebody who is in named this address in the last 14
 *    days (`lib/referrals.ts`).
 *
 * ## Saying who is on the list is deliberate
 *
 * `enter` tells the person typing whether an address is let in, waiting, or
 * new, and so anybody can learn that about an address. Dev2 chose that
 * (2026-09-29) over answering only by email: it is an early-access list, and
 * the person on it seeing "you're on the list" at once is worth more than
 * hiding a fact that small. It says nothing about workspaces, and a removed
 * row reads exactly like a waiting one.
 */

import { normalizeEmail } from "@context/shared";
import type { GenericDatabaseReader } from "convex/server";
import type { DataModel } from "../../_generated/dataModel";
import { isAdminEmail } from "./admin";
import { parseInvitee } from "./invitees";
import { hasLiveInvite } from "./referrals";

type Db = GenericDatabaseReader<DataModel>;

export const OPEN_SIGNUP_ENV_VAR = "OPEN_SIGNUP";

/** The longest answer to "what would you use it for?" that is kept. */
export const USE_FOR_MAX = 280;

/** The address, normalized and validated as the invitation box does, or `null`. */
export function waitlistEmail(raw: string): string | null {
  const parsed = parseInvitee(raw);
  if (!parsed.ok || parsed.invitee.kind !== "email") return null;
  return parsed.invitee.value;
}

export function signupIsOpen(env: Record<string, string | undefined> = process.env): boolean {
  return env[OPEN_SIGNUP_ENV_VAR] === "true";
}

/** Is this address let in? See the module comment for the whole rule. */
export async function isAdmitted(
  db: Db,
  rawEmail: string,
  env: Record<string, string | undefined> = process.env,
  now: number = Date.now(),
): Promise<boolean> {
  if (await isAdmittedWithoutReferral(db, rawEmail, env, now)) return true;
  const email = normalizeEmail(rawEmail);
  return email.length > 0 && (await hasLiveInvite(db, email, now));
}

/**
 * Every clause of `isAdmitted` but a friend's referral.
 *
 * For sending one: an address this already admits needs no invite, and the
 * inviter is told so (the waitlist field says as much to anybody). An address
 * that only *another* person's referral admits must read like any other, or
 * sending would reveal who else invited them.
 */
export async function isAdmittedWithoutReferral(
  db: Db,
  rawEmail: string,
  env: Record<string, string | undefined> = process.env,
  now: number = Date.now(),
): Promise<boolean> {
  if (signupIsOpen(env)) return true;
  const email = normalizeEmail(rawEmail);
  if (email.length === 0) return false;
  if (isAdminEmail(email, env)) return true;

  // `createSupaAuth` stored addresses verbatim before sign-in normalized them,
  // so an old mixed-case account is looked up by its own spelling too.
  for (const spelling of new Set([email, rawEmail.trim()])) {
    const user = await db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", spelling))
      .first();
    if (user !== null) return true;
  }

  const row = await db
    .query("waitlist")
    .withIndex("by_email", (q) => q.eq("email", email))
    .unique();
  if (row?.status === "admitted") return true;

  const invitations = await db
    .query("workspaceInvitations")
    .withIndex("by_invitee", (q) => q.eq("inviteeKind", "email").eq("invitee", email))
    .take(50);
  return invitations.some((row) => row.status === "pending" && row.expiresAt > now);
}

/**
 * The new-account half of the gate, for `createSupaAuth`'s `canCreateUser`.
 *
 * The fixed-code test accounts (`test-email*` providers: the CUJ account and
 * the connector-directory reviewer) are admitted by construction. Each of
 * those providers refuses every address but its own, so this cannot be used
 * to walk a stranger past the list.
 */
export async function mayCreateUser(
  db: Db,
  who: { provider: string; email?: string },
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  if (who.provider === "test-email" || who.provider.startsWith("test-email-")) return true;
  if (typeof who.email !== "string") return signupIsOpen(env);
  return isAdmitted(db, who.email, env);
}
