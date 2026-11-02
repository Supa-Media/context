/**
 * A guest pass, kept in this browser (`apps/convex/functions/guestPass.ts` says what it is).
 *
 * Someone in a Tex group chat with no account proves their number once with a texted code, and the pass is what
 * keeps them signed in afterwards: the next note link from the chat opens with no code. Only ever here and in a
 * function argument, never in a URL, so it can't reach an address bar, a referrer or a log. Storage can be missing
 * or throw (a private window, blocked site data, the native app), and then there is simply no pass: the page asks
 * for the number again.
 */

const KEY = "context.guestPass";
const SHAPE = /^[A-Za-z0-9_-]{40,64}$/;

export function readGuestPass(): string | null {
  try {
    const value = globalThis.localStorage?.getItem(KEY) ?? null;
    return value !== null && SHAPE.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function saveGuestPass(pass: string): void {
  if (!SHAPE.test(pass)) return;
  try {
    globalThis.localStorage?.setItem(KEY, pass);
  } catch {
    // No storage: the next link asks for the number again.
  }
}

export function forgetGuestPass(): void {
  try {
    globalThis.localStorage?.removeItem(KEY);
  } catch {
    // Nothing stored, nothing to forget.
  }
}

export type GuestStartStatus = "sent" | "invalid_phone" | "too_many" | "unavailable" | "failed";
export type GuestVerifyStatus = "ok" | "wrong" | "too_many" | "unavailable";

/** What the number step says when the code didn't go. `null` when it went. */
export function guestStartError(status: GuestStartStatus): string | null {
  switch (status) {
    case "sent":
      return null;
    case "invalid_phone":
      return "That doesn't look like a phone number. Include the country code if it isn't a US number.";
    case "too_many":
      return "Too many codes for this number just now. Wait a few minutes and try again.";
    case "unavailable":
      return "Codes can't be texted right now. Ask whoever is in the chat to try again later.";
    default:
      return "The code didn't send. Try again.";
  }
}

/** What the code step says when the code didn't open anything. `null` for a pass. */
export function guestVerifyError(status: GuestVerifyStatus): string | null {
  switch (status) {
    case "ok":
      return null;
    case "wrong":
      return "That code didn't work. Check the newest text, or send a new code.";
    case "too_many":
      return "Too many tries for this number. Wait a while and send a new code.";
    default:
      return "This number isn't in a group chat with Tex that can open notes here. Use the number you text the group from.";
  }
}
