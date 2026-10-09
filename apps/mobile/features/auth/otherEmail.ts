/**
 * What "Do you already use Context with another email?" says (board s7).
 *
 * The rule (who is asked, what a hand-off may move) is the server's:
 * `apps/convex/functions/otherEmail.ts`. This is only the words, kept here so
 * they can be read and tested without a screen.
 */

export type FinishStatus = "added" | "expired" | "same_account" | "has_own_workspace" | "too_many_emails";

export const OTHER_EMAIL_TITLE = "Do you already use Context with another email?";

export function notOnAccount(email: string): string {
  return `${email} isn't on an account yet.`;
}

export const SEND_FAILED =
  "We couldn't send a code to that email. Check it, or go back and choose “No, I'm new here”.";
export const CODE_FAILED = "That code didn't work. Codes last ten minutes, so send a new one if it's been a while.";

/** What went wrong once the other account is signed in, or null when it worked. */
export function finishError(status: FinishStatus, email: string): string | null {
  switch (status) {
    case "added":
      return null;
    case "expired":
      return `That took too long, so ${email} wasn't added. You can add it in Settings › Account.`;
    case "same_account":
      return `That's the email you just used. Enter the other email you use Context with.`;
    case "has_own_workspace":
      return `${email} has its own workspace now, so it stays a separate account.`;
    case "too_many_emails":
      return "That account already has as many emails as it can hold. Remove one in Settings › Account.";
  }
}

/** Whether the app should stop at the question. Unknown is never a stop. */
export function asksForOtherEmail(answer: { ask: boolean } | undefined): boolean {
  return answer?.ask === true;
}
