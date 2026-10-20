/**
 * Gmail first (Dev2, 2026-10-20: "we just go straight to asking them to add
 * gmails … the first should be a primary personal gmail … then we can ask
 * them to add more"). The artboards are in tex-signup-gmail-artboards
 * (06 to 10).
 *
 * Which page sent this browser to Google is kept for the trip, so the
 * callback can answer in the same words: `primary` from the one-time email
 * gate, `another` from `/add-gmail`, `personal` from a work-domain sign-up's
 * personal email step, which also keeps the page to come back to. Absent, the
 * callback is Connected apps' ordinary one. Session storage, so it never
 * outlives the tab.
 */

export type GmailFirstMode = "primary" | "another" | "personal";

const KEY = "context.gmailFirst";
const RETURN_KEY = "context.gmailFirst.return";

export function rememberGmailFirst(mode: GmailFirstMode, returnTo?: string): void {
  try {
    globalThis.sessionStorage?.setItem(KEY, mode);
    if (returnTo === undefined) globalThis.sessionStorage?.removeItem(RETURN_KEY);
    else globalThis.sessionStorage?.setItem(RETURN_KEY, returnTo);
  } catch {
    // Storage refused: the callback shows its ordinary page.
  }
}

/** Where a `personal` connect goes back to: the same-origin path it left, or the console. */
export function readGmailReturn(): string {
  try {
    const path = globalThis.sessionStorage?.getItem(RETURN_KEY) ?? null;
    return path !== null && path.startsWith("/") && !path.startsWith("//") && !path.includes("\\") ? path : "/console";
  } catch {
    return "/console";
  }
}

export function readGmailFirst(): GmailFirstMode | null {
  try {
    const mode = globalThis.sessionStorage?.getItem(KEY) ?? null;
    return mode === "primary" || mode === "another" || mode === "personal" ? mode : null;
  } catch {
    return null;
  }
}

/** Once the callback has answered, so a later connect from Settings is Settings' own. */
export function forgetGmailFirst(): void {
  try {
    globalThis.sessionStorage?.removeItem(KEY);
    globalThis.sessionStorage?.removeItem(RETURN_KEY);
  } catch {
    // Nothing kept.
  }
}

/** Google asks for Gmail, Calendar and Chat together, as Connected apps does. */
export const GMAIL_SERVICES = { gmail: true, calendar: true, chat: true } as const;

/** Google's warning, said where it happens rather than in the text that sent them. */
export function googleWarning(touch: boolean): string {
  return `Google will say it hasn't verified Context yet. That's expected: ${touch ? "tap" : "click"} Advanced, then Go to Context.`;
}

/** Which address a finished connect added: the first not in `before`, or null while the binding is still landing. */
export function newGmail(before: readonly string[], now: readonly string[]): string | null {
  return now.find((address) => !before.includes(address)) ?? null;
}
