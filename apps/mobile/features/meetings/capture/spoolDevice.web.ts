import type { AudioSpool } from "./spoolShared";

/**
 * A browser keeps no meeting audio.
 *
 * `audio.web.ts` sends each chunk while there is a connection and, when there
 * is not, says on the glass that this stretch is not being kept — rather than
 * holding minutes of somebody's meeting in IndexedDB on a machine that may be
 * shared, under a storage quota the browser can evict without asking. The
 * phone keeps it; `docs/decisions/meetings.md` says why the browser does not.
 */
export const deviceSpool: AudioSpool | null = null;

export function createDeviceSpool(): AudioSpool | null {
  return null;
}
