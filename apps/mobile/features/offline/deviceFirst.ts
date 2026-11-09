import * as mirrorStore from "./mirrorStore";

/**
 * Whether this runtime's own copy answers first.
 *
 * Owner, 2026-11-09, approving the offline-first boards: on the phone and
 * desktop apps, which keep a copy of the notes (`mirrorStore`), a note, a list
 * or a search is answered from that copy at once, and the server's answer and
 * the live session replace it when they arrive. A browser tab keeps no copy and
 * stays server-first, as decided on 2026-10-08. This replaces that day's
 * "when connected, always use the server" for the apps.
 *
 * Read through the module rather than a named import so that a runtime (or a
 * test double) that cannot say whether it keeps a copy is server-first, the
 * old behaviour, rather than broken.
 */
export function deviceFirst(): boolean {
  try {
    return typeof mirrorStore.mirrorSupported === "function" && mirrorStore.mirrorSupported();
  } catch {
    return false;
  }
}
