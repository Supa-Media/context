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

import { shareTokenFromSegment } from "../share/share";

/** Under the heading on the sign-in page for a shared-note link. */
export const SHARED_NOTE_INTRO =
  "Sign in with your work email to open it. If you don't have an account yet, we'll make one next.";
/** Under the code button. The code goes to the address typed, nothing else. */
export const SHARED_NOTE_FOOT = "We'll email you a code to that address.";

/**
 * Under the heading for a shared link whose workspace is open to an email
 * domain (Dev, 2026-10-20). The domain is the server's answer for the link's
 * token (`shares.shareSignInHint`), never read from the URL, so nobody can
 * make this page name a domain of their choosing.
 */
export function sharedLinkDomainIntro(domain: string, canEdit: boolean): { heading: string; intro: string } {
  return canEdit
    ? { heading: "Sign in to edit", intro: `Use your @${domain} email. If you're new, we'll make your account next.` }
    : {
        heading: "Sign in to join",
        intro: `Use your @${domain} email to join the workspace this note is in. If you're new, we'll make your account next.`,
      };
}

const BASE = "http://context.invalid";
const SHARE_PATH = /^\/s\/([^/]+)$/;

/**
 * The share token a `next` is carrying back to, from `/s/<segment>`, or
 * `null`. The same same-origin rules as `isSharedNoteNext`.
 */
export function shareTokenInNext(next: string | null | undefined): string | null {
  if (typeof next !== "string") return null;
  const trimmed = next.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//") || trimmed.includes("\\")) return null;
  let url: URL;
  try {
    url = new URL(trimmed, BASE);
  } catch {
    return null;
  }
  if (url.origin !== BASE) return null;
  const match = SHARE_PATH.exec(url.pathname);
  if (match === null) return null;
  try {
    return shareTokenFromSegment(decodeURIComponent(match[1]!));
  } catch {
    return null;
  }
}
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
