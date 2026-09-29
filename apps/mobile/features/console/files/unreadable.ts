/**
 * A note that is in storage but can't be opened right now (Board 6).
 *
 * A managed workspace's files are encrypted, and a missing key, a wrong key or
 * a damaged file all end at the same answer from the control plane:
 * `ENCRYPTED_UNREADABLE`, or `KEY_UNAVAILABLE` when the workspace's key itself
 * could not be opened. Either one is drawn as this state and never as text in
 * the editor: the editor stays closed for that note, so nothing can be typed
 * or saved over a file we can't read.
 *
 * Not the password lock. A passphrase-locked note has its own "Unlock"
 * screen; this one has no password to ask for, and never uses that word.
 */

import { ConvexError } from "convex/values";

export const UNREADABLE_CODES: ReadonlySet<string> = new Set(["ENCRYPTED_UNREADABLE", "KEY_UNAVAILABLE"]);

export const UNREADABLE_TITLE = "This note can't be opened right now";
export const UNREADABLE_BODY =
  "It's still in storage, but we can't open it right now. We've been alerted. Try again in a few minutes.";
export const UNREADABLE_FOOT = "Editing is off for this note until it opens, so nothing overwrites it.";

/** Whether a failed read is this state rather than an ordinary notice. */
export function isUnreadable(error: unknown): boolean {
  if (!(error instanceof ConvexError)) return false;
  const code = (error.data as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && UNREADABLE_CODES.has(code);
}
