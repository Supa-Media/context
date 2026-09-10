import { APPEARANCE_STORAGE_KEY } from "./appearancePrefs";
import type { AppearancePeek } from "./appearancePeek";

/**
 * Web's answer, and the reason this file exists apart from `appearancePeek.ts`:
 * unlike `AsyncStorage`, `localStorage` is synchronous, so the very first
 * render this module ever takes part in can already carry the true stored
 * choice — module-scope evaluation happens before anything mounts. That is
 * what lets `theme.tsx` seed its external store with the *right* answer
 * instead of a placeholder that a later effect corrects, which is the flash
 * this feature exists to avoid: a stored "light" that arrived one tick late
 * would otherwise paint dark first.
 *
 * Always answers `resolved: true`, including when the `catch` fires. A
 * browser that throws on `localStorage` access — Private Browsing, or one
 * blocking site data, exactly the failure modes `store.web.ts`'s own probe
 * guards against — will throw on every later read too, so "keep waiting"
 * would never become "resolved" on its own. Landing on "system" immediately
 * is the same answer this browser would eventually get from the async store
 * (it falls back to an in-memory store, which also holds nothing), just
 * without a pointless wait first.
 */
export function peekStoredSchemeSync(): AppearancePeek {
  // Explicit rather than relying on the `try` below to catch a `ReferenceError`
  // — the same check `store.web.ts`'s own probe makes, for a module that can
  // load somewhere `window` was never declared (this suite's plain-`node`
  // test files resolve `.web.ts` ahead of the bare extension too).
  if (typeof window === "undefined") return { scheme: null, resolved: true };
  try {
    const raw = window.localStorage.getItem(APPEARANCE_STORAGE_KEY);
    return { scheme: raw === "light" || raw === "dark" ? raw : null, resolved: true };
  } catch {
    return { scheme: null, resolved: true };
  }
}
