import { twilioVerifyKeys } from "@supa-media/convex/auth";
import type { Doc, Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { REVIEWER_EMAIL } from "./reviewerAccount";
import { TEST_ACCOUNT_EMAIL } from "./testAccount";
import { stagingStorageIsFree } from "./managedStorage";

/**
 * The phone check: every account confirms a phone number once, with a texted
 * code, before the app opens (Dev2, 2026-10-09). It proves a real person is
 * behind the account, and it is the key a second sign-in email will later be
 * matched on. Since the same day it also **signs in**
 * (`functions/phoneSignIn.ts`), so what is recorded here is a credential: one
 * phone is one account (`phoneHeldByAnother`), and the only path that can move
 * a phone between accounts clears it (`functions/textLinks.ts`).
 *
 * ## Off unless both halves are there
 *
 * `PHONE_CHECK=required` turns it on, and only when the Twilio Verify keys are
 * set too. A switch without keys would block every person behind a screen
 * whose code can never arrive, so that combination stays off.
 *
 * ## Who is never asked
 *
 * Accounts nobody can hand a phone to: the connector-directory reviewer, the
 * production test account, the staging personas (on the isolated staging
 * deployment only), and the addresses in `PHONE_CHECK_EXEMPT_EMAILS`. An
 * exempt entry also covers its `+tag` addresses, because test inboxes use them.
 *
 * ## What counts as confirmed
 *
 * A phone Twilio approved (`users.phone` with `phoneVerificationTime`), or a
 * phone linked for texting (`phoneLinks`), which proved the same thing by the
 * person texting a code from it.
 */

type Environment = Record<string, string | undefined>;

export const PHONE_CHECK_ENV = "PHONE_CHECK";
export const PHONE_CHECK_EXEMPT_ENV = "PHONE_CHECK_EXEMPT_EMAILS";

/** E.164: a plus, a non-zero country digit, 7 to 15 digits in all. */
const E164 = /^\+[1-9]\d{6,14}$/;

/**
 * The Twilio Verify keys, with the texted code signed "Context". The Verify
 * service may be shared with another app, whose name it carries, and Twilio
 * writes that name into the text ("Your <name> verification code"), so the
 * name is sent with every code. `TWILIO_VERIFY_FRIENDLY_NAME` still wins, for
 * a self-hosted deployment with a name of its own.
 */
export function contextVerifyKeys(env: Environment = process.env) {
  const keys = twilioVerifyKeys(env);
  return keys === null ? null : { friendlyName: "Context", ...keys };
}

export function phoneCheckRequired(env: Environment = process.env): boolean {
  return env[PHONE_CHECK_ENV]?.trim().toLowerCase() === "required" && twilioVerifyKeys(env) !== null;
}

/**
 * A typed number as E.164, or `null`. Spaces, dashes, dots and brackets go;
 * a leading `00` is the international prefix. A number with no country code
 * is refused rather than guessed at.
 */
export function normalizePhone(raw: string): string | null {
  let value = raw.trim().replace(/[\s().-]/g, "");
  if (value.startsWith("00")) value = `+${value.slice(2)}`;
  return E164.test(value) ? value : null;
}

/** `name+tag@host` → `name@host`, lower case. */
function withoutTag(email: string): string {
  const lower = email.trim().toLowerCase();
  const at = lower.lastIndexOf("@");
  if (at <= 0) return lower;
  const local = lower.slice(0, at);
  const plus = local.indexOf("+");
  return `${plus === -1 ? local : local.slice(0, plus)}${lower.slice(at)}`;
}

export function isExemptEmail(email: string | undefined, env: Environment = process.env): boolean {
  if (email === undefined || email.trim() === "") return false;
  const exact = email.trim().toLowerCase();
  if (exact === REVIEWER_EMAIL || exact === TEST_ACCOUNT_EMAIL) return true;
  const listed = (env[PHONE_CHECK_EXEMPT_ENV] ?? "")
    .split(/[\s,]+/)
    .map(withoutTag)
    .filter((entry) => entry.includes("@"));
  if (listed.includes(withoutTag(exact))) return true;
  // The staging personas are `<persona>@supa.media`, seeded by
  // `stagingPersonas.prepare`, and only on the isolated staging deployment.
  return stagingStorageIsFree() && /^(alpha|beta|gamma|delta|epsilon)@supa\.media$/.test(exact);
}

/** Whether this person has a confirmed phone, by either route. */
export async function hasConfirmedPhone(ctx: QueryCtx, user: Doc<"users">): Promise<boolean> {
  if (user.phone !== undefined && user.phoneVerificationTime !== undefined) return true;
  const link = await ctx.db
    .query("phoneLinks")
    .withIndex("by_user", (q) => q.eq("userId", user._id))
    .first();
  return link !== null;
}

/**
 * Whether `phone` is already confirmed by somebody else. One phone, one
 * account: that is what lets a phone stand for a person.
 */
export async function phoneHeldByAnother(
  ctx: QueryCtx,
  phone: string,
  userId: Id<"users">,
): Promise<boolean> {
  const users = await ctx.db
    .query("users")
    .withIndex("by_phone", (q) => q.eq("phone", phone))
    .take(10);
  if (users.some((user) => user._id !== userId && user.phoneVerificationTime !== undefined)) return true;
  const links = await ctx.db
    .query("phoneLinks")
    .withIndex("by_phone", (q) => q.eq("phone", phone))
    .take(10);
  return links.some((link) => link.userId !== userId);
}
