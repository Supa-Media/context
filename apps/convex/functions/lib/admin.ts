/**
 * Who may operate Context.LC itself, as opposed to their own context.
 *
 * Everything else in this control plane authorizes against *membership*: you
 * may read this workspace because you are in it. This module is the one place
 * that answers a different question — "is this person staff?" — and it exists
 * because the admin console reads figures across every tenant and writes the
 * integration credentials the platform runs on. That is a strictly larger
 * capability than any workspace role, so it is granted by a strictly different
 * mechanism.
 *
 * ## The allowlist is an environment variable, and that is the security design
 *
 * The obvious implementation is `users.isAdmin: boolean`. It is also a
 * privilege-escalation path: the admin console can write to the database, so a
 * bug anywhere in it — a mis-scoped patch, an unvalidated argument, a future
 * "edit user" screen — lets an admin (or anything that reaches an admin's
 * session) mint another admin, and lets a database compromise mint one
 * silently. A boolean in the table the console edits is a lock whose key is
 * kept inside the box.
 *
 * `ADMIN_EMAILS` lives in the Convex environment instead. Nothing this
 * codebase can execute writes it; changing who is staff is a deploy-time act
 * by somebody holding the deployment credential, and it leaves a trail
 * somewhere the console cannot reach. The cost is that granting admin is not
 * self-service, which for a set of people the size of a founding team is the
 * right trade and not a limitation worth engineering away.
 *
 * ## Unset means nobody, and never everybody
 *
 * A missing or empty `ADMIN_EMAILS` authorizes no one. This is the direction a
 * misconfiguration must fail in: the other one publishes every tenant's usage
 * figures and the platform's credential store to whoever signs up first. There
 * is deliberately no development-mode bypass — a bypass that exists is a
 * bypass that ships.
 *
 * ## Exact addresses only
 *
 * No domain rule, no wildcard, no suffix match. This is the same reasoning
 * `ingestionSettings` carries for capture addresses: every one of those is a
 * way to write a policy that admits more than its author meant, and
 * `@supa.media` as a domain rule would enrol every future address at that
 * domain, including ones created by somebody else.
 *
 * ## The address must be verified
 *
 * An unverified email proves nothing about who holds the mailbox, so matching
 * one against the allowlist would let anyone who can type a staff address into
 * a signup form become staff. `identities.ts` already refuses unverified
 * addresses when resolving a share addressee; this is the same rule for a
 * larger capability.
 */

import { getAuthUserId } from "@convex-dev/auth/server";
import type { Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";

/** Comma- or whitespace-separated exact addresses. Unset means nobody. */
export const ADMIN_EMAILS_ENV_VAR = "ADMIN_EMAILS";

/**
 * Thrown for both "not signed in" and "signed in, not staff".
 *
 * One message for both on purpose. A distinct "you are not an admin" reply
 * tells an authenticated stranger that the endpoint exists and that their
 * account is the only thing standing between them and it, which is a small
 * gift to somebody enumerating the surface. The repository is public, so the
 * route is not a secret — but confirming an account's standing against it is
 * still an oracle, and there is no reason to run one.
 */
export class NotAdminError extends Error {
  constructor() {
    super("Not found");
    this.name = "NotAdminError";
  }
}

/**
 * Parse the allowlist.
 *
 * Addresses are lowercased and trimmed; empty entries are dropped rather than
 * becoming an entry that matches an account with no address. Splitting on both
 * commas and whitespace means a value pasted across two lines, or with a
 * trailing comma, does what its author obviously meant.
 */
export function parseAdminEmails(
  raw: string | undefined | null,
): ReadonlySet<string> {
  if (typeof raw !== "string") return new Set();
  const entries = raw
    .split(/[\s,]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  return new Set(entries);
}

/**
 * Is this address staff?
 *
 * Takes the address rather than a user row so the decision is a pure function
 * that tests can drive directly. The *verification* half lives in
 * `requireAdmin`, because it needs the row.
 */
export function isAdminEmail(
  email: string | undefined | null,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (typeof email !== "string" || email.length === 0) return false;
  const allowed = parseAdminEmails(env[ADMIN_EMAILS_ENV_VAR]);
  if (allowed.size === 0) return false;
  return allowed.has(email.trim().toLowerCase());
}

export interface AdminActor {
  userId: Id<"users">;
  /** Normalized, and always one of the allowlisted addresses. */
  email: string;
}

/**
 * Authorize a staff caller, or throw.
 *
 * Every admin function starts with this line. It is deliberately not optional
 * and deliberately not a wrapper that a new endpoint could forget to apply:
 * `__tests__/adminSurface.test.ts` walks the admin module and fails on any
 * exported function whose handler does not reach it.
 */
export async function requireAdmin(
  ctx: QueryCtx,
  env: Record<string, string | undefined> = process.env,
): Promise<AdminActor> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) throw new NotAdminError();

  const user = await ctx.db.get(userId);
  if (user === null) throw new NotAdminError();

  // An unverified address proves nothing about who holds the mailbox. Without
  // this line, signing up as an allowlisted address is enough to become staff.
  if (user.emailVerificationTime === undefined) throw new NotAdminError();
  if (!isAdminEmail(user.email, env)) throw new NotAdminError();

  return { userId, email: user.email!.trim().toLowerCase() };
}

/**
 * Whether the caller is staff, without throwing.
 *
 * For the console's own navigation only — so the app can decide whether to
 * render a link to `/admin`. It is never the authorization for anything: every
 * admin read and write calls `requireAdmin` server-side, and a client that
 * lies to itself about this boolean gets an empty screen and a thrown query.
 */
export async function viewerIsAdmin(
  ctx: QueryCtx,
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  try {
    await requireAdmin(ctx, env);
    return true;
  } catch {
    return false;
  }
}
