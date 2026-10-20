import type { StartStatus } from "../../auth/phoneSignIn";

/** What went wrong, in Tex's words: the shared copy offers an email route tex.lc does not have. */
export function texJoinError(status: StartStatus | null): string | null {
  switch (status) {
    case null:
    case "sent":
    case "joined":
    case "already":
      return null;
    case "invalid_phone":
      return "That number doesn't look right. Check it and the country beside it.";
    case "too_many":
      return "Too many tries for now. Wait a few minutes and try again.";
    case "unavailable":
      return "Joining is paused for a moment. Try again shortly.";
    case "paused":
      return "Signing in with this number is paused. Sign in with your email to turn it back on.";
    default:
      return "That didn't go through. Try again.";
  }
}
