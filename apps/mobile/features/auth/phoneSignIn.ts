/**
 * What the phone sign-in says for each answer the server gives.
 *
 * The rule (who is texted, who a phone signs in to) is the server's:
 * `apps/convex/functions/phoneSignIn.ts`. This is only the words.
 */

export type StartStatus = "sent" | "joined" | "already" | "invalid_phone" | "too_many" | "unavailable" | "paused" | "failed";

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
    case "paused":
      return "Signing in with this number is paused. Use email instead.";
    case "failed":
      return "We couldn't send a text just now. Try again, or use email instead.";
  }
}
