import { ConvexError } from "convex/values";

/**
 * A reconnect's `login_hint`: an address-shaped string or nothing.
 *
 * It only pre-selects an account on Google's chooser, so a wrong one costs a
 * click, not access. Still bounded, because it is copied into a URL.
 */
export function validateLoginHint(hint: string | undefined): string | undefined {
  if (hint === undefined) return undefined;
  const trimmed = hint.trim();
  if (trimmed.length === 0 || trimmed.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(trimmed)) {
    throw new ConvexError({
      code: "INVALID_LOGIN_HINT",
      message: "That is not an email address Google can be asked for.",
    });
  }
  return trimmed;
}
