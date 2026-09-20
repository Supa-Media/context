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
 * ## Why `set` and `keys` are allowed to throw and the other two are not
 *
 * The asymmetry is the same one `store.web.ts` documents and it is worth
 * repeating on both sides, because the two files will be read separately by
 * whoever next has to fix one:
 *
 *  - A **read** that fails is a read that found nothing we can trust, and every
 *    caller of `get` already has an honest "nothing cached" branch. Throwing out
 *    of one would take down the render that asked.
 *  - A **write** that fails silently is somebody's typing, gone, with the
 *    console still saying it is safe. `outbox.ts` keeps the entry in memory
 *    either way, so the queue still drains; what is lost is surviving a
 *    restart, and that is the caller's to know about rather than this file's to
 *    hide. Android's AsyncStorage has a default database ceiling (6MB, and 2MB
 *    per value) which a `MAX_NOTE_BYTES`-sized note can genuinely reach.
 *  - A **listing** that fails looks like a read and is not one. `keys()` has no
 *    read callers: every one of them is a *clear* — `forgetEverything`,
 *    `forgetWorkspace`, `forgetDepartedContexts`, `sweep`, `forgetPlace`,
 *    `forgetAllMeetings` — plus the verification `forget.ts` performs
 *    afterwards, and to all of those an empty listing does not mean "nothing
 *    cached", it means **done**. Swallowing one turned a sign-out that removed
 *    nothing into a sign-out that reported `cleared`, with no warning, in the
 *    module whose stated stance is *never silently*. This is the platform where
 *    that is least theoretical: the ceiling above is where `getAllKeys` starts
 *    throwing while `getItem` goes on answering, so the note bodies stay
 *    readable while the clear that was meant to take them reports success.
 *
 * ## What is and is not covered by a test
 *
 * The **port** is: `__tests__/offlineStore.test.ts` runs one conformance suite
 * over `localStorage` and over `memoryStore()`, and everything above this file
 * is written against `KeyValueStore` rather than against either.
 *
 * **This delegation is covered too, since the listing stance above was found
 * to be wrong while nothing executed it:** `__tests__/offlineStoreNative.test.ts`
 * reaches this file by its explicit path — the suite resolves `web.ts` first —
 * and replaces `AsyncStorage` with `jest.mock`, which needs no `jest-expo`
 * preset for a module that is four function calls. Keep it a delegation all the
 * same, but the reason is now "there is nothing here worth writing" rather than
 * "nothing here can be checked".
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
    // Deliberately unguarded too, for a different reason — see the file
    // comment. `getAllKeys` answers `readonly string[]`; the port's contract is
    // a plain array the caller may sort in place.
    keys: async () => [...(await AsyncStorage.getAllKeys())],
  };
}
