import { openStore } from "../offline/store";

/**
 * Persistence for the one appearance preference this app remembers: light,
 * dark, or follow the device.
 *
 * `openStore()` is `features/offline/store.ts` (native, `AsyncStorage`) or
 * `store.web.ts` (web, `localStorage`, falling back to an in-memory store when
 * the browser refuses one) — the port every other small piece of device state
 * in this app already goes through (`features/console/useLastPlace.ts` is the
 * clearest example: a device-remembered value with nothing to do with the
 * offline note cache the folder is named for). Reused rather than reinvented:
 * both platforms are already covered, already tested, and a write that fails
 * here should fail exactly as quietly as it does for "where you last were" —
 * losing a remembered preference is a cosmetic regression, not a lost note.
 *
 * This is deliberately its own key, outside `features/offline/keys.ts`'s
 * scheme: that file's keys are workspace-scoped copies of what a bucket said,
 * and every one of its four kinds is either a cache invalidated by
 * `sweep()`/`forgetWorkspace` or a queue tied to a signed-in session. An
 * appearance choice is neither — it has no workspace, survives every sign-out
 * and every "forget this context", and answers to nobody's clearance.
 */
export const APPEARANCE_STORAGE_KEY = "context.lc.appearance.v1";

/** What can be written down: an explicit pin, or nothing (follow the device). */
export type StoredScheme = "light" | "dark";

/** The persisted choice, or `null` for "nothing stored" — meaning "system". */
export async function readStoredScheme(): Promise<StoredScheme | null> {
  const raw = await openStore().get(APPEARANCE_STORAGE_KEY);
  return raw === "light" || raw === "dark" ? raw : null;
}

/** `null` clears the key, which is what "follow the device" is stored as. */
export async function writeStoredScheme(scheme: StoredScheme | null): Promise<void> {
  const store = openStore();
  if (scheme === null) {
    await store.remove(APPEARANCE_STORAGE_KEY);
  } else {
    await store.set(APPEARANCE_STORAGE_KEY, scheme);
  }
}
