/**
 * Is the `next` a sign-in is carrying a link to a note in somebody's
 * workspace? The login screen reads the answer to say "someone shared a note
 * with you" and to open in email mode, before anybody has signed in.
 *
 * Nothing is looked up while signed out, so the answer may only depend on the
 * URL itself: never the workspace's name, the note's name or a domain. A `next`
 * that is not a same-origin console note path is not a shared note, whatever
 * it says.
 */

/** Under the heading on the sign-in page for a shared-note link. */
export const SHARED_NOTE_INTRO =
  "Sign in with your work email to open it. If you don't have an account yet, we'll make one next.";
/** Under the code button. The code goes to the address typed, nothing else. */
export const SHARED_NOTE_FOOT = "We'll email you a code to that address.";

const BASE = "http://context.invalid";
const NOTE_PATH = /^\/console\/@([^/]+)$/;

export function isSharedNoteNext(next: string | null | undefined): boolean {
  if (typeof next !== "string") return false;
  const trimmed = next.trim();
  // A rooted path only: no protocol-relative `//host`, no backslash tricks.
  if (!trimmed.startsWith("/") || trimmed.startsWith("//") || trimmed.startsWith("/\\")) return false;
  if (trimmed.includes("\\")) return false;

  let url: URL;
  try {
    url = new URL(trimmed, BASE);
  } catch {
    return false;
  }
  if (url.origin !== BASE) return false;

  const match = NOTE_PATH.exec(url.pathname);
  if (match === null) return false;
  try {
    if (decodeURIComponent(match[1]!).trim().length === 0) return false;
  } catch {
    return false;
  }
  // Read the raw value and decode it strictly: `URLSearchParams` tolerates a
  // broken escape that would then be a path nobody can open.
  const raw = /[?&]note=([^&#]*)/.exec(url.search)?.[1] ?? "";
  try {
    return decodeURIComponent(raw).trim().length > 0;
  } catch {
    return false;
  }
}
