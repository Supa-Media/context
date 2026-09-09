import type { StoredScheme } from "./appearancePrefs";

/** What a synchronous, first-paint check of storage can say. */
export interface AppearancePeek {
  /** The stored choice, if this platform can answer synchronously. */
  scheme: StoredScheme | null;
  /**
   * Whether `scheme` is the real answer rather than "have not looked yet".
   *
   * `false` here means the caller must still wait for `readStoredScheme` to
   * resolve before treating `scheme === null` as "nothing stored" rather than
   * "unknown". See `theme.tsx`'s `useAppearanceChoice` for what happens while
   * that is pending, and `appearancePeek.web.ts` for the platform where this
   * is always `true`.
   */
  resolved: boolean;
}

/**
 * Native's answer: it does not have one, synchronously.
 *
 * `AsyncStorage` is a bridge call on every native platform this app ships to
 * — there is no synchronous read to fall back to, unlike `localStorage` on
 * web. Rather than guess (and risk a first frame in the wrong scheme),
 * `app/_layout.tsx` holds the launch image up until the async read in
 * `appearancePrefs.ts` resolves, exactly as it already does for the auth
 * session. See `appearancePeek.web.ts` for the platform that can skip that
 * wait entirely.
 */
export function peekStoredSchemeSync(): AppearancePeek {
  return { scheme: null, resolved: false };
}
