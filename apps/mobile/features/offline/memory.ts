/**
 * A `KeyValueStore` that lives for as long as the app does, and says so.
 *
 * The port every other module in this folder is written against, plus the one
 * implementation that needs no platform at all. Two things use it: the native
 * half of `store.ts` (which has nowhere durable to write yet — see that file),
 * and the web half when the browser refuses `localStorage`.
 *
 * `durable` is the whole reason this is an interface rather than a direct call
 * to a platform API. CLAUDE.md's rule for a capability the build does not have
 * is that it "is reported honestly; it is never faked", and durability is
 * exactly that kind of capability: a queue that survives the app closing and a
 * queue that does not are the same object with very different promises
 * attached, and the person who typed the thing in the queue is the one who
 * should be told which one they have. `copy.ts` turns this boolean into the
 * sentence they read.
 */

/**
 * The only storage primitive this feature needs.
 *
 * Async everywhere, because the durable native implementation is
 * (`AsyncStorage`) and a synchronous port would have to be widened later —
 * which means rewriting every caller rather than one adapter. `localStorage`
 * is synchronous and simply resolves immediately.
 *
 * Keys are opaque strings; `keys.ts` owns their shape. Values are strings,
 * because that is the intersection of what `localStorage` and `AsyncStorage`
 * hold — JSON encoding is the caller's job, so a value that will not parse is
 * a caller's problem to recover from rather than a store that throws.
 */
export interface KeyValueStore {
  /**
   * Whether a write survives the app being closed.
   *
   * `false` means everything here is a session cache: the read cache still
   * works, offline edits still queue and still drain, and a force-quit loses
   * them. Never assume it; ask, and say so on screen.
   */
  readonly durable: boolean;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  /** Every key this store holds, in no particular order. */
  keys(): Promise<string[]>;
}

/** An in-memory store. Fast, correct, and gone when the process is. */
export function memoryStore(): KeyValueStore {
  const held = new Map<string, string>();
  return {
    durable: false,
    get: async (key) => held.get(key) ?? null,
    set: async (key, value) => {
      held.set(key, value);
    },
    remove: async (key) => {
      held.delete(key);
    },
    keys: async () => [...held.keys()],
  };
}
