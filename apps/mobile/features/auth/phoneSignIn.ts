/**
 * What the phone sign-in says for each answer the server gives.
 *
 * The rule (who is texted, who a phone signs in to) is the server's:
 * `apps/convex/functions/phoneSignIn.ts`. This is only the words.
 */

export type StartStatus = "sent" | "new" | "invalid_phone" | "too_many" | "unavailable" | "failed";

export const PHONE_SIGN_IN_HEADING = "Sign in or join";
export const NEW_NUMBER_HEADING = "What's your email?";
export const NEW_NUMBER_WHY =
  "Mail goes here, like invites and updates. After this, your phone is all you need to sign in.";
export const CODE_FAILED = "That code didn't work. Check the text, or send a new code.";

export function startError(status: StartStatus): string | null {
  switch (status) {
    case "sent":
    case "new":
    case "unavailable":
      return null;
    case "invalid_phone":
      return "Enter the number with its country code, like +1 555 555 0100.";
    case "too_many":
      return "Too many tries for now. Wait a bit, or use email instead.";
    case "failed":
      return "We couldn't send a text just now. Try again, or use email instead.";
  }
}
