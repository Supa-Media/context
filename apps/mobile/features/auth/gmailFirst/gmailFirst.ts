/**
 * Gmail first (Dev2, 2026-10-20: "we just go straight to asking them to add
 * gmails … the first should be a primary personal gmail … then we can ask
 * them to add more"). The artboards are in tex-signup-gmail-artboards
 * (06 to 10).
 *
 * Which page sent this browser to Google is kept for the trip, so the
 * callback can answer in the same words: `primary` from the one-time email
 * gate, `another` from `/add-gmail`. Absent, the callback is Connected apps'
 * ordinary one. Session storage, so it never outlives the tab.
 */

export type GmailFirstMode = "primary" | "another";

const KEY = "context.gmailFirst";

export function rememberGmailFirst(mode: GmailFirstMode): void {
  try {
    globalThis.sessionStorage?.setItem(KEY, mode);
  } catch {
    // Storage refused: the callback shows its ordinary page.
  }
}

export function readGmailFirst(): GmailFirstMode | null {
  try {
    const mode = globalThis.sessionStorage?.getItem(KEY) ?? null;
    return mode === "primary" || mode === "another" ? mode : null;
  } catch {
    return null;
  }
}

/** Once the callback has answered, so a later connect from Settings is Settings' own. */
export function forgetGmailFirst(): void {
  try {
    globalThis.sessionStorage?.removeItem(KEY);
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
