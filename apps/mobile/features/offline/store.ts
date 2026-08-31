import { memoryStore, type KeyValueStore } from "./memory";

/**
 * The durable store — native.
 *
 * **There is no durable store on this platform yet, and this file reports that
 * rather than pretending otherwise.** Everything in `features/offline` works on
 * a phone — the read cache, offline editing, the queue, the drain, the conflict
 * parking — for as long as the app is running. What it does not do is survive
 * the app being closed, and `durable: false` is what says so: `copy.ts` turns
 * it into the sentence in the console, so a person queueing edits on a phone is
 * told what the queue is worth before they rely on it.
 *
 * ## Why, precisely
 *
 * `@react-native-async-storage/async-storage` is the store this wants, and it
 * is already classified `core` in `native-deps.json` — the baseline every build
 * is expected to have. It is **not in `apps/mobile/package.json`**, so the
 * module does not resolve: a static import fails `tsc` and fails a Metro native
 * bundle, and a `require()` hidden from Metro would be worse than the gap
 * because it could never load even once the dependency arrived.
 *
 * This is the same shape of honest absence the app already carries twice:
 * `writeClipboard` returns `false` on native rather than claiming "Copied" over
 * a no-op, and `useUnsavedGuard`'s native half is a documented no-op. CLAUDE.md
 * states the rule those two follow — "an absent capability is reported
 * honestly; it is never faked" — and this is a third instance of it.
 *
 * ## What lights it up
 *
 * One line in `apps/mobile/package.json`
 * (`"@react-native-async-storage/async-storage": "2.2.0"`, matching the version
 * the iOS launch build installs), and then this file becomes:
 *
 * ```ts
 * import AsyncStorage from "@react-native-async-storage/async-storage";
 *
 * export function openStore(): KeyValueStore {
 *   return {
 *     durable: true,
 *     get: (key) => AsyncStorage.getItem(key),
 *     set: (key, value) => AsyncStorage.setItem(key, value),
 *     remove: (key) => AsyncStorage.removeItem(key),
 *     keys: async () => [...(await AsyncStorage.getAllKeys())],
 *   };
 * }
 * ```
 *
 * No other file changes: everything above this one is written against
 * `KeyValueStore` and is already tested against a durable fake
 * (`__tests__/offlineStore.test.ts` runs the same conformance suite over both),
 * and `copy.ts` has both sentences. Nothing here needs a `runtimeVersion` bump
 * — the dependency is in the `core` baseline, not `gated`.
 */
export function openStore(): KeyValueStore {
  return memoryStore();
}
