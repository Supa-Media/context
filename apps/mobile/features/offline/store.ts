import AsyncStorage from "@react-native-async-storage/async-storage";
import type { KeyValueStore } from "./memory";

/**
 * The durable store — native.
 *
 * `@react-native-async-storage/async-storage`, which is `core` in
 * `native-deps.json` — the baseline every build has — so it is a static import
 * and needs no `NativeModules` gate and no `runtimeVersion` bump. It was added
 * to the native baseline for the first iOS build; this is the first thing to
 * use it.
 *
 * ## Why `set` is the only method that is allowed to throw
 *
 * The asymmetry is the same one `store.web.ts` documents and it is worth
 * repeating on both sides, because the two files will be read separately by
 * whoever next has to fix one:
 *
 *  - A **read** that fails is a read that found nothing we can trust, and every
 *    caller here already has an honest "nothing cached" branch. Throwing out of
 *    one would take down the render that asked.
 *  - A **write** that fails silently is somebody's typing, gone, with the
 *    console still saying it is safe. `outbox.ts` keeps the entry in memory
 *    either way, so the queue still drains; what is lost is surviving a
 *    restart, and that is the caller's to know about rather than this file's to
 *    hide. Android's AsyncStorage has a default database ceiling (6MB, and 2MB
 *    per value) which a `MAX_NOTE_BYTES`-sized note can genuinely reach.
 *
 * ## What is and is not covered by a test
 *
 * The **port** is: `__tests__/offlineStore.test.ts` runs one conformance suite
 * over `localStorage` and over `memoryStore()`, and everything above this file
 * is written against `KeyValueStore` rather than against either. What is not
 * covered is this delegation, because the suite runs in plain node with no
 * native mocks and no `jest-expo` preset (see `jest.config.js`) — the same
 * reason `clipboard.ts` and `fonts.ts` have untested native halves. Keep it a
 * delegation for that reason: any logic added here is logic nothing checks.
 */
export function openStore(): KeyValueStore {
  return {
    durable: true,
    get: async (key) => {
      try {
        return await AsyncStorage.getItem(key);
      } catch {
        return null;
      }
    },
    // Deliberately unguarded — see the file comment.
    set: (key, value) => AsyncStorage.setItem(key, value),
    remove: async (key) => {
      try {
        await AsyncStorage.removeItem(key);
      } catch {
        // A key that could not be removed is stale data, which every reader
        // here already has to tolerate.
      }
    },
    keys: async () => {
      try {
        // `getAllKeys` answers `readonly string[]`; the port's contract is a
        // plain array the caller may sort in place.
        return [...(await AsyncStorage.getAllKeys())];
      } catch {
        return [];
      }
    },
  };
}
