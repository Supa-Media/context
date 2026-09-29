import type { EmailSignInStep } from "./useEmailSignIn";

/**
 * `/join/<token>` as state: what the page a friend opens from an invite email
 * shows, worked out from `referrals.preview` and the one email field's step.
 *
 * Kept pure so the page's decisions are tested without drawing it. The field
 * itself is `/login`'s (`useEmailSignIn`, `LoginScreen`); nothing here asks
 * the server anything.
 *
 * The server admits exactly the address the invite went to while the invite is
 * live. So on a working invite, `waitlist.enter` answering `joined` or
 * `already` means the address typed is somebody else's: that is a mistake to
 * point out, not a waitlist success to celebrate. (The stranger's address has
 * been put on the list by then; that is fine, and saying so here would only
 * muddy which email to use.)
 */

/** What `api.functions.referrals.preview` answers, or `undefined` while it loads. */
export type JoinPreview = { works: boolean; inviterHandle: string | null } | undefined;

/** How `/login`'s screen is dressed when it is drawn for an invite link. */
export type JoinVariant = { kind: "invite"; inviterHandle: string | null } | { kind: "expired" };

export type JoinScreenState = { kind: "loading" } | JoinVariant;

/** What the one field shows at a step, for `/login` (no variant) or `/join`. */
export type SignInView = "request" | "verify" | "waitlist" | "wrongEmail";

export const WRONG_EMAIL = "This invite is for a different email. Use the one it went to.";
export const JOIN_HELPER = "Use the email the invite went to. You'll get a sign-in code here.";
export const EXPIRED_TITLE = "This invite no longer works";
export const EXPIRED_BODY = "Ask whoever invited you for a new one, or join the waitlist below.";

/**
 * The page for a token. A missing token is a link that no longer works, said
 * without asking the server; an unknown, expired, revoked or cancelled one is
 * the server's `works: false`, and all read the same.
 */
export function joinScreenFor(token: string | undefined, preview: JoinPreview): JoinScreenState {
  if (token === undefined || token.trim().length === 0) return { kind: "expired" };
  if (preview === undefined) return { kind: "loading" };
  if (!preview.works) return { kind: "expired" };
  return { kind: "invite", inviterHandle: preview.inviterHandle };
}

/**
 * What the field draws. Only a working invite turns "not let in" into the
 * wrong-email error; `/login` and a dead invite keep the waitlist answer.
 */
export function signInView(variant: JoinVariant | undefined, step: EmailSignInStep): SignInView {
  if (step === "request" || step === "verify") return step;
  return variant?.kind === "invite" ? "wrongEmail" : "waitlist";
}

/** "@maya invited you", and a line that still reads without a handle. */
export function invitedLine(inviterHandle: string | null): string {
  const handle = inviterHandle?.trim().replace(/^@+/, "") ?? "";
  return handle.length === 0 ? "You were invited" : `@${handle} invited you`;
}

/** The letter in the inviter's face placeholder. */
export function inviterInitial(inviterHandle: string | null): string {
  const handle = inviterHandle?.trim().replace(/^@+/, "") ?? "";
  return handle.length === 0 ? "•" : handle[0]!.toUpperCase();
}
