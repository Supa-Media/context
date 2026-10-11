/**
 * What the phone sign-in says for each answer the server gives.
 *
 * The rule (who is texted, who a phone signs in to) is the server's:
 * `apps/convex/functions/phoneSignIn.ts`. This is only the words.
 */

export type StartStatus = "sent" | "joined" | "already" | "invalid_phone" | "too_many" | "unavailable" | "failed";

export const PHONE_SIGN_IN_HEADING = "Sign in or join";
export const JOINED_HEADING = "You're on the list.";
export const ALREADY_HEADING = "You're already on the list.";
export const WAITLIST_WHY = "Context is invite only for now. When you're let in, this number is how you sign in.";
export const CODE_FAILED = "That code didn't work. Check the text, or send a new code.";

export function startError(status: StartStatus): string | null {
  switch (status) {
    case "sent":
    case "joined":
    case "already":
    case "unavailable":
      return null;
    case "invalid_phone":
      return "That number doesn't look right. Check it and the country beside it.";
    case "too_many":
      return "Too many tries for now. Wait a bit, or use email instead.";
    case "failed":
      return "We couldn't send a text just now. Try again, or use email instead.";
  }
}

/**
 * Said wherever somebody signs in or joins with email instead of a phone
 * (Dev2, 2026-10-09): a phone is still required (the phone check), and an
 * email that already has an account gets the number added to it, so a person
 * keeps one account whichever way they came in.
 */
export const EMAIL_STILL_NEEDS_PHONE =
  "You'll still need a phone number: after you sign in, we'll text you a code to add one. If this email already has an account, the number is added to it.";
