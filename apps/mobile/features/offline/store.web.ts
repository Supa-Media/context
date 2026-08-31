import { memoryStore, type KeyValueStore } from "./memory";

/**
 * The durable store — web.
 *
 * `localStorage`, which is the only synchronous, origin-scoped, survives-a-
 * reload store a browser gives without asking permission. IndexedDB is bigger
 * and asynchronous and would be the right answer for attachments; this holds
 * note text, drafts and a small queue, and a dependency-free 5MB bucket is the
 * proportionate tool.
 *
 * ## Why every call is wrapped
 *
 * `localStorage` is not a function that returns errors, it is a function that
 * **throws**, in three separate ways that all reach real people:
 *
 *  - Safari in Private Browsing used to throw `QuotaExceededError` on the
 *    first `setItem`, and some embedded webviews still do.
 *  - A browser configured to block site data throws on *access to the property
 *    itself* — reading `window.localStorage` is the throw, before any method
 *    is called. That is why the probe below touches it inside the `try`.
 *  - A full bucket throws `QuotaExceededError` on a write that would not fit,
 *    at any time, not only at startup.
 *
 * The first two are answered by the probe: a store that cannot be written at
 * startup is not used at all, and `memoryStore()` takes over with
 * `durable: false`, which the console then says out loud. The third cannot be
 * answered by a probe — it happens later — so `set` rejects and the caller
 * decides. **`set` deliberately does not swallow a failed write.** A cache
 * write that silently did nothing is a cache; a *queue* write that silently
 * did nothing is somebody's typing, gone, with the UI still claiming it is
 * safe. `outbox.ts` keeps the entry in memory either way and `copy.ts` has a
 * sentence for a queue that could not be written down.
 *
 * ## Why the probe writes rather than feature-detects
 *
 * `typeof window.localStorage !== "undefined"` is true in every one of the
 * failure modes above. The only honest test of "can I write here" is a write.
 */

/** The key the probe writes and removes. Namespaced so it cannot collide. */
const PROBE_KEY = "context.lc.probe";

function canWrite(): boolean {
  try {
    // Property access included: a browser blocking site data throws here.
    const storage = window.localStorage;
    storage.setItem(PROBE_KEY, "1");
    storage.removeItem(PROBE_KEY);
    return true;
  } catch {
    return false;
  }
}

export function openStore(): KeyValueStore {
  if (typeof window === "undefined" || !canWrite()) return memoryStore();

  const storage = window.localStorage;
  return {
    durable: true,
    get: async (key) => {
      try {
        return storage.getItem(key);
      } catch {
        // A read that throws is a read that found nothing we can trust. The
        // caller's "nothing cached" branch is the honest one.
        return null;
      }
    },
    set: async (key, value) => {
      // Deliberately unguarded — see the file comment. A quota failure has to
      // reach the caller, because for the outbox it means "this is not written
      // down anywhere".
      storage.setItem(key, value);
    },
    remove: async (key) => {
      try {
        storage.removeItem(key);
      } catch {
        // Nothing useful to do, and nothing at risk: a key that could not be
        // removed is stale data, which every reader here is already required
        // to tolerate.
      }
    },
    keys: async () => {
      try {
        const found: string[] = [];
        for (let index = 0; index < storage.length; index += 1) {
          const key = storage.key(index);
          if (key !== null) found.push(key);
        }
        return found;
      } catch {
        return [];
      }
    },
  };
}
