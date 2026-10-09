/**
 * The phone somebody typed on the sign-in page when no account held it yet.
 *
 * A new number is texted nothing (`apps/convex/functions/phoneSignIn.ts`): the
 * page asks for an email, the person signs in with it, and then the phone
 * check confirms this number onto that account, so next time the phone alone
 * signs them in. Kept for the browser tab (the web lands after sign-in with a
 * real navigation) and in memory elsewhere; never in long-lived storage,
 * because it is a half-finished step, not a preference.
 */

let inMemory: string | null = null;
const KEY = "context.pendingPhone";

function session(): Storage | null {
  try {
    return typeof window !== "undefined" && window.sessionStorage ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

export function pendingPhone(): string | null {
  try {
    return session()?.getItem(KEY) ?? inMemory;
  } catch {
    return inMemory;
  }
}

export function setPendingPhone(phone: string): void {
  inMemory = phone;
  try {
    session()?.setItem(KEY, phone);
  } catch {
    // Memory is enough for this tab.
  }
}

export function clearPendingPhone(): void {
  inMemory = null;
  try {
    session()?.removeItem(KEY);
  } catch {
    // Nothing kept, nothing to clear.
  }
}
