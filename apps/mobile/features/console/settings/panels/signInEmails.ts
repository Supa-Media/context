/**
 * What "Emails you sign in with" says for each answer the server gives. The
 * rules are the server's: `apps/convex/functions/signInEmails.ts`.
 */

export type StartStatus =
  | "sent"
  | "invalid_email"
  | "already_yours"
  | "has_own_workspace"
  | "too_many_emails"
  | "too_many";
export type ConfirmStatus = "added" | "moved" | "wrong" | "expired" | "has_own_workspace" | "too_many";

export const EMAILS_INTRO =
  "Sign in with any of these. Anything shared with one of them reaches you here. Mail goes to the one marked.";

export function startError(status: string): string | null {
  switch (status as StartStatus) {
    case "sent":
      return null;
    case "invalid_email":
      return "That doesn't look like an email address.";
    case "already_yours":
      return "That email is already on your account.";
    case "has_own_workspace":
      return "That email has its own Context account with a workspace. Sign in with it to use that workspace; it can't be joined to this one.";
    case "too_many_emails":
      return "That's as many emails as one account can have. Remove one first.";
    case "too_many":
      return "Too many codes for now. Wait a bit, then try again.";
    default:
      return "That didn't work. Try again.";
  }
}

export function confirmError(status: string): string | null {
  switch (status as ConfirmStatus) {
    case "added":
    case "moved":
      return null;
    case "wrong":
      return "That code didn't work. Check the email, or send a new code.";
    case "expired":
      return "That code has expired. Send a new one.";
    case "has_own_workspace":
      return startError("has_own_workspace");
    case "too_many":
      return startError("too_many");
    default:
      return "That didn't work. Try again.";
  }
}
