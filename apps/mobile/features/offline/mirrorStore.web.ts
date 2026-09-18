import type { KeyValueStore } from "./memory";
import { kvMirrorStore, type MirrorStore } from "./mirrorStoreCore";

/**
 * The mirror's storage — web: IndexedDB, through a wrapper written here.
 *
 * `store.web.ts` explains why the queue and the drafts live in `localStorage`
 * and says, in as many words, that IndexedDB "would be the right answer" for
 * anything bigger. A whole context is that: `localStorage` holds about five
 * megabytes for the origin, and a mirror that filled it would start failing
 * the write that queues somebody's typing. IndexedDB is quota-managed per
 * origin and is typically allowed a large share of the disk.
 *
 * **Hand-written rather than a dependency**, for the reason CLAUDE.md gives
 * about web-only libraries in `apps/mobile` and for proportion: this needs one
 * object store and four operations — get, put, delete, list keys — and the
 * wrapper below is those four and the probe. Everything with rules in it is in
 * `mirrorStoreCore.ts`'s key layout and `mirror.ts`, and runs in the tests
 * against a `Map`.
 *
 * **Probed with a real write, the way `store.web.ts` probes `localStorage`.**
 * `typeof indexedDB !== "undefined"` is true in every failure mode that
 * matters: a Firefox private window that refuses to open a database, a browser
 * blocking site data, an embedded webview with storage disabled, an origin
 * over quota. Each of them is found by opening the database and writing a key.
 * One that fails answers `null` — no mirror on this device — and the console
 * says so; the bounded read cache still serves what was opened. An open that
 * never answers at all (a blocked upgrade in another tab) is bounded too:
 * `OPEN_DEADLINE_MS`, then `null`, because the alternative is a console whose
 * every note open waits on a promise nothing will settle.
 *
 * Every tab of the origin shares one database. Each tab has its own queue in
 * `guardMirror`, so two tabs syncing at once can interleave their index
 * writes and lose one tab's update to the other; the next sync repairs it
 * (an index entry that is missing is re-downloaded, not trusted), which is the
 * direction a derivative is allowed to fail in. Recorded as an open risk in
 * `docs/decisions/app-and-console.md` rather than solved with a cross-tab lock.
 */

const DB_NAME = "context-offline-mirror";
const DB_VERSION = 1;
const OBJECT_STORE = "kv";
const PROBE_KEY = "context.lc.mirror-probe";

/** How long opening the database may take before this device has no mirror. */
export const OPEN_DEADLINE_MS = 3_000;

function settled<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

/** A write is only a write once its transaction has committed. */
function committed(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB write failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB write aborted"));
  });
}

/** The four operations, over one object store. Exported for its own test. */
export function idbKeyValue(db: IDBDatabase): KeyValueStore {
  const write = async (work: (store: IDBObjectStore) => void): Promise<void> => {
    const transaction = db.transaction(OBJECT_STORE, "readwrite");
    const done = committed(transaction);
    work(transaction.objectStore(OBJECT_STORE));
    await done;
  };
  return {
    durable: true,
    get: async (key) => {
      try {
        const value = await settled(
          db.transaction(OBJECT_STORE, "readonly").objectStore(OBJECT_STORE).get(key),
        );
        return typeof value === "string" ? value : null;
      } catch {
        return null;
      }
    },
    // Unguarded, for `store.web.ts`'s reason: a failed write has to reach the
    // caller, which for the mirror means a sync that stops and says so.
    set: (key, value) => write((store) => store.put(value, key)),
    remove: async (key) => {
      try {
        await write((store) => store.delete(key));
      } catch {
        // Caught by the verification after every clear, where it is reported.
      }
    },
    // Unguarded too: every caller of `keys` is a clear or its verification.
    keys: async () => {
      const found = await settled(
        db.transaction(OBJECT_STORE, "readonly").objectStore(OBJECT_STORE).getAllKeys(),
      );
      return found.filter((key): key is string => typeof key === "string");
    },
  };
}

/** Open the database, or `null` for every way a browser can refuse. */
export async function openMirrorDatabase(
  factory: IDBFactory | undefined,
  deadlineMs: number = OPEN_DEADLINE_MS,
): Promise<IDBDatabase | null> {
  if (factory === undefined) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      // Property access and `open` both throw in some refusals; inside the
      // promise so either becomes a rejection.
      const request = factory.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(OBJECT_STORE)) {
          request.result.createObjectStore(OBJECT_STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB refused"));
      request.onblocked = () => reject(new Error("IndexedDB upgrade blocked"));
    });
    const db = await Promise.race([
      opening,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), deadlineMs);
      }),
    ]);
    if (db === null) return null;
    // Another tab upgrading the schema asks this one to let go; holding on
    // would block it forever.
    db.onversionchange = () => db.close();
    const probe = idbKeyValue(db);
    await probe.set(PROBE_KEY, "1");
    if ((await probe.get(PROBE_KEY)) !== "1") return null;
    await probe.remove(PROBE_KEY);
    return db;
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

let opened: Promise<MirrorStore | null> | null = null;

/**
 * The one mirror store for the life of the tab. One, for the reason the native
 * half gives: its single queue is what orders a sign-out's clear against a
 * sync's writes.
 */
export function openMirrorStore(): Promise<MirrorStore | null> {
  opened ??= (async () => {
    let factory: IDBFactory | undefined;
    try {
      // Reading the property is itself the refusal in some browsers — a
      // `SecurityError` where site data is blocked — so it is inside the `try`.
      factory = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    } catch {
      factory = undefined;
    }
    const db = await openMirrorDatabase(factory);
    return db === null ? null : kvMirrorStore(idbKeyValue(db), "indexeddb");
  })();
  return opened;
}
