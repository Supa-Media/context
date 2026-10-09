/**
 * What the phone check screen says for each answer the server gives.
 *
 * The rule itself (who is asked, what counts as confirmed, one phone per
 * account) is the server's: `apps/convex/functions/lib/phoneCheck.ts`. This is
 * only the words, kept here so they can be read and tested without a screen.
 */

export type SendStatus = "sent" | "invalid_phone" | "taken" | "too_many" | "failed" | "not_needed";
export type ConfirmStatus = "confirmed" | "wrong" | "taken" | "too_many" | "failed";

export const PHONE_CHECK_TITLE = "Add your phone number";
export const PHONE_CHECK_WHY =
  "We text you a code once to check it's yours. From then on, your phone is how you sign in.";

/**
 * One person, one account, however many emails (Dev2, 2026-10-09): a number
 * that already signs in elsewhere is the person's account, so the way on is
 * to sign in with it and add this email there, which folds an empty account
 * in (`functions/signInEmails.ts`).
 */
const TAKEN =
  "That number already signs in to a Context account. Sign in with your phone instead, then add this email in Settings › Profile › Emails you sign in with.";
const TOO_MANY = "Too many tries for now. Wait a bit, then try again.";
const FAILED = "We couldn't send a text just now. Try again in a minute.";

export function sendError(status: SendStatus): string | null {
  switch (status) {
    case "sent":
    case "not_needed":
      return null;
    case "invalid_phone":
      return "Enter the number with its country code, like +1 555 555 0100.";
    case "taken":
      return TAKEN;
    case "too_many":
      return TOO_MANY;
    case "failed":
      return FAILED;
  }
}

export function confirmError(status: ConfirmStatus): string | null {
  switch (status) {
    case "confirmed":
      return null;
    case "wrong":
      return "That code didn't work. Check the text, or send a new code.";
    case "taken":
      return TAKEN;
    case "too_many":
      return TOO_MANY;
    case "failed":
      return "We couldn't check the code just now. Try again in a minute.";
  }
}

/** Whether the app should stop at the phone screen. Unknown is never a stop. */
export function blocksForPhone(answer: { required: boolean } | undefined): boolean {
  return answer?.required === true;
}
