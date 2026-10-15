/**
 * The words for account safety (boards k1-k4). The rules are the server's:
 * `apps/convex/functions/emailProof.ts`, `signInAlerts.ts`, `emailRecovery.ts`.
 */

export function proofError(status: string): string | null {
  switch (status) {
    case "sent":
    case "confirmed":
      return null;
    case "wrong":
      return "That code didn't work. Check the email, or send a new code.";
    case "expired":
      return "That code has expired. Send a new one.";
    case "too_many":
      return "Too many codes for now. Wait a bit and try again.";
    case "no_email":
      return "Your account has no email to send a code to yet. Add one first.";
    case "signed_out":
      return "This device was signed out. Sign in again.";
    default:
      return "We couldn't send a code just now. Try again.";
  }
}

export function recoveryError(status: string): string | null {
  switch (status) {
    case "sent":
    case "started":
      return null;
    case "invalid_email":
      return "That email doesn't look right.";
    case "taken":
      return "That email belongs to another account.";
    case "waiting":
      return "A new email is already waiting out its seven days.";
    case "too_many_emails":
      return "This account already has as many emails as it can hold.";
    case "too_many":
      return "Too many codes for now. Wait a bit and try again.";
    case "not_needed":
      return "Your account has no email yet, so add one in Account settings: no wait is needed.";
    case "wrong":
      return "That code didn't work. Check the email and try again.";
    case "expired":
      return "That code has expired. Start again.";
    default:
      return "That didn't work. Try again.";
  }
}

export function recoveryDate(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}

/** Board k3: when a device signed in, in words. */
export function signedInWhen(at: number, now = Date.now()): string {
  const days = Math.floor((now - at) / (24 * 60 * 60 * 1000));
  if (days <= 0) return "Signed in today";
  if (days === 1) return "Signed in yesterday";
  if (days < 30) return `Signed in ${days} days ago`;
  return `Signed in on ${new Date(at).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}`;
}
