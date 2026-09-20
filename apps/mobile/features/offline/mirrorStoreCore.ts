import { currentEpoch } from "./epoch";
import type { CacheScope } from "./keys";
import { memoryStore, type KeyValueStore } from "./memory";

/**
 * Where the mirror keeps every note body, as a port with three implementations.
 *
 * `KeyValueStore` is the wrong shape for this and the wrong size: it is
 * `localStorage` on the web, which caps at about five megabytes for the whole
 * origin, and `AsyncStorage` on native, whose Android database defaults to six.
 * A context of a thousand notes does not fit in either, and a store that fills
 * up throws on the next write — which, in `KeyValueStore`, is the write that
 * queues somebody's typing. So the mirror has storage of its own:
 *
 *  - **native** (`mirrorStore.ts`): files under the app's document directory,
 *    one per note body, through `expo-file-system` — `core` in
 *    `native-deps.json`, so no gate and no `runtimeVersion` bump;
 *  - **web** (`mirrorStore.web.ts`): IndexedDB, through a wrapper small enough
 *    to read in one sitting, because a dependency would be a second React-shaped
 *    risk in `apps/mobile` for four calls;
 *  - **memory** (here): the same key layout over a `Map`, for tests.
 *
 * `null` from `openMirrorStore` means "no mirror on this device" — a browser
 * with IndexedDB blocked — and the console then says so rather than pretending;
 * the bounded read cache in `cache.ts` still serves what was opened.
 *
 * ## The barrier lives in the store
 *
 * `epoch.ts` is how sign-out stays a sign-out while writes are still in
 * flight, and the mirror is the worst case for it: a sync is minutes of
 * `readNotes` round trips, each followed by a write. Checking the epoch in the
 * caller before each write narrows the window without closing it — the check
 * and the write are separate steps. So every **write** here takes the epoch
 * its caller belongs to, and `guardMirror` compares it *inside one serial
 * queue that `clearAll` also runs through*. `forgetLocalCopies` ends the epoch
 * before it enqueues the clear, so every write the queue reaches after that
 * point is from a session that has ended and is dropped; every one it reached
 * before is removed by the clear. There is no gap between the two.
 *
 * Removals take no epoch: removing something after a sign-out is what a
 * sign-out wants.
 */

/** A body slot: the note as the bucket last had it, or an ancestor held for a merge. */
export type MirrorSlot = "current" | "base";

export interface MirrorRoot {
  scope: CacheScope;
  workspaceId: string;
}

/** The port. Strings in and out; `mirror.ts` owns what they mean. */
export interface MirrorStore {
  readonly kind: "files" | "indexeddb" | "memory";
  /** Never throws: an index that cannot be read is an index we do not have. */
  readIndex(scope: CacheScope, workspaceId: string): Promise<string | null>;
  /** `false` when the session this write belongs to has ended. */
  writeIndex(epoch: number, scope: CacheScope, workspaceId: string, json: string): Promise<boolean>;
  readBody(
    scope: CacheScope,
    workspaceId: string,
    slot: MirrorSlot,
    path: string,
  ): Promise<string | null>;
  writeBody(
    epoch: number,
    scope: CacheScope,
    workspaceId: string,
    slot: MirrorSlot,
    path: string,
    text: string,
  ): Promise<boolean>;
  removeBody(scope: CacheScope, workspaceId: string, slot: MirrorSlot, path: string): Promise<void>;
  /**
   * Every (scope, workspace) holding anything. Rejects when it cannot list —
   * the same stance `KeyValueStore.keys` takes, for the same reason: every
   * caller is a clear or its verification, and "nothing" means *done* to them.
   */
  roots(): Promise<MirrorRoot[]>;
  forgetWorkspace(workspaceId: string): Promise<void>;
  clearAll(): Promise<void>;
}

/** What a platform implements. `guardMirror` adds the queue and the barrier. */
export type RawMirrorStore = {
  readonly kind: MirrorStore["kind"];
  readIndex: MirrorStore["readIndex"];
  writeIndex(scope: CacheScope, workspaceId: string, json: string): Promise<void>;
  readBody: MirrorStore["readBody"];
  writeBody(
    scope: CacheScope,
    workspaceId: string,
    slot: MirrorSlot,
    path: string,
    text: string,
  ): Promise<void>;
  removeBody: MirrorStore["removeBody"];
  roots: MirrorStore["roots"];
  forgetWorkspace: MirrorStore["forgetWorkspace"];
  clearAll: MirrorStore["clearAll"];
};

/**
 * One queue for every operation, and the epoch compared inside it.
 *
 * One queue rather than one per workspace because `clearAll` has to be ordered
 * against *everything*, and a per-workspace queue would let a write for a
 * workspace the clear has already walked past land behind it. The cost is that
 * a note being opened waits behind a sync's write in progress — one file write
 * or one IndexedDB put, which is milliseconds.
 */
export function guardMirror(raw: RawMirrorStore): MirrorStore {
  let tail: Promise<unknown> = Promise.resolve();
  const run = <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work, work);
    tail = next.catch(() => {});
    return next;
  };
  const gated = (epoch: number, work: () => Promise<void>): Promise<boolean> =>
    run(async () => {
      if (epoch !== currentEpoch()) return false;
      await work();
      return true;
    });

  return {
    kind: raw.kind,
    readIndex: (scope, workspaceId) =>
      run(() => raw.readIndex(scope, workspaceId)).catch(() => null),
    writeIndex: (epoch, scope, workspaceId, json) =>
      gated(epoch, () => raw.writeIndex(scope, workspaceId, json)),
    readBody: (scope, workspaceId, slot, path) =>
      run(() => raw.readBody(scope, workspaceId, slot, path)).catch(() => null),
    writeBody: (epoch, scope, workspaceId, slot, path, text) =>
      gated(epoch, () => raw.writeBody(scope, workspaceId, slot, path, text)),
    removeBody: (scope, workspaceId, slot, path) =>
      run(() => raw.removeBody(scope, workspaceId, slot, path)),
    roots: () => run(() => raw.roots()),
    forgetWorkspace: (workspaceId) => run(() => raw.forgetWorkspace(workspaceId)),
    clearAll: () => run(() => raw.clearAll()),
  };
}

/*
  The key layout over a key-value store, used by IndexedDB on the web and by a
  `Map` in tests. `U+001F` separates segments for the reason `keys.ts` gives: a
  bucket path cannot contain it, and a workspace id is a Convex id. A key-value
  store has no directories, so there is nothing for a path to escape — the
  encoding `mirrorPath.ts` does for the filesystem has no counterpart here.
*/
const SEP = "\u001f";

function indexKey(scope: CacheScope, workspaceId: string): string {
  return ["index", scope, workspaceId].join(SEP);
}

function bodyKey(scope: CacheScope, workspaceId: string, slot: MirrorSlot, path: string): string {
  return ["body", scope, workspaceId, slot, path].join(SEP);
}

const SCOPES: ReadonlySet<string> = new Set<CacheScope>(["private", "team"]);

function parse(key: string): { scope: CacheScope; workspaceId: string } | null {
  const parts = key.split(SEP);
  if (parts[0] === "index" && parts.length === 3 && SCOPES.has(parts[1]!)) {
    return { scope: parts[1] as CacheScope, workspaceId: parts[2]! };
  }
  if (parts[0] === "body" && parts.length === 5 && SCOPES.has(parts[1]!)) {
    return { scope: parts[1] as CacheScope, workspaceId: parts[2]! };
  }
  return null;
}

/** The mirror over any `KeyValueStore`. `kind` says which one, for the status line. */
export function kvMirrorStore(kv: KeyValueStore, kind: MirrorStore["kind"]): MirrorStore {
  return guardMirror({
    kind,
    readIndex: async (scope, workspaceId) => kv.get(indexKey(scope, workspaceId)),
    writeIndex: (scope, workspaceId, json) => kv.set(indexKey(scope, workspaceId), json),
    readBody: async (scope, workspaceId, slot, path) =>
      kv.get(bodyKey(scope, workspaceId, slot, path)),
    writeBody: (scope, workspaceId, slot, path, text) =>
      kv.set(bodyKey(scope, workspaceId, slot, path), text),
    removeBody: (scope, workspaceId, slot, path) =>
      kv.remove(bodyKey(scope, workspaceId, slot, path)),
    roots: async () => {
      const found = new Map<string, { scope: CacheScope; workspaceId: string }>();
      for (const key of await kv.keys()) {
        const parsed = parse(key);
        if (parsed === null) continue;
        found.set(`${parsed.scope}${SEP}${parsed.workspaceId}`, {
          scope: parsed.scope,
          workspaceId: parsed.workspaceId,
        });
      }
      return [...found.values()];
    },
    forgetWorkspace: async (workspaceId) => {
      for (const key of await kv.keys()) {
        if (parse(key)?.workspaceId === workspaceId) await kv.remove(key);
      }
    },
    clearAll: async () => {
      for (const key of await kv.keys()) if (parse(key) !== null) await kv.remove(key);
    },
  });
}

/** For tests, and for nothing else: a mirror that is gone when the process is. */
export function memoryMirrorStore(): MirrorStore {
  return kvMirrorStore(memoryStore(), "memory");
}
