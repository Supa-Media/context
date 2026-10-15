/**
 * A note's read, asked for the moment somebody shows they are about to open
 * it — a pointer over its row, a finger down on it — rather than when the
 * press lands.
 *
 * Owner, 2026-10-11: "speed is essential, especially for a notetaking app."
 * Since a plain browser stopped keeping a copy of the workspace (online means
 * server, 2026-10-08), every open is a whole read away, and a read is a control
 * plane call that reaches the bucket. The pointer is usually over a row for a
 * few hundred milliseconds before it is pressed, so starting the read there
 * takes that much off what the person waits for, and on a quick read all of it.
 *
 * **This is the read, early, not a cache.** What `take` hands back is the
 * server's answer to a request made a moment ago, never a copy kept from an
 * earlier visit, which is why three rules hold:
 *
 *  - **It is used once.** `take` removes it, so reopening a note later always
 *    asks again.
 *  - **It is young or it is nothing.** Past `PREFETCH_FRESH_MS` from when it
 *    was asked, it is dropped and the open reads afresh.
 *  - **A failure is never kept.** A read that fails is forgotten, so an open
 *    asks again rather than repeating an error from before the press.
 *
 * Whoever calls `prefetch` decides whether a read is worth asking for; the
 * note the editor already holds is never one (`useOpenNote`), because its
 * answer would predate the typing on screen.
 */

/** How long an early read stays usable, from when it was asked. */
export const PREFETCH_FRESH_MS = 8_000;

/** At most this many early reads at once; hovering down a long list asks for the last few. */
export const PREFETCH_LIMIT = 6;

interface Entry<T> {
  at: number;
  read: Promise<T>;
}

export interface NotePrefetch<T> {
  /** Ask for `key`'s read now, unless one young enough is already on its way. */
  prefetch(key: string, start: () => Promise<T>): void;
  /** The early read for `key`, removed; `undefined` when there is none young enough. */
  take(key: string): Promise<T> | undefined;
  /** Forget everything, for a context switch or a sign-out. */
  clear(): void;
}

export function createNotePrefetch<T>(now: () => number = Date.now): NotePrefetch<T> {
  const entries = new Map<string, Entry<T>>();

  const young = (entry: Entry<T>) => now() - entry.at < PREFETCH_FRESH_MS;

  return {
    prefetch(key, start) {
      const held = entries.get(key);
      if (held !== undefined && young(held)) return;
      for (const [other, entry] of entries) if (!young(entry)) entries.delete(other);
      // Oldest first: a Map iterates in insertion order.
      while (entries.size >= PREFETCH_LIMIT) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      let read: Promise<T>;
      try {
        read = start();
      } catch {
        return;
      }
      const entry = { at: now(), read };
      entries.set(key, entry);
      read.catch(() => {
        if (entries.get(key) === entry) entries.delete(key);
      });
    },
    take(key) {
      const entry = entries.get(key);
      if (entry === undefined) return undefined;
      entries.delete(key);
      return young(entry) ? entry.read : undefined;
    },
    clear() {
      entries.clear();
    },
  };
}
