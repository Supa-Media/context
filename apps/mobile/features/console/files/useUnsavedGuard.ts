/**
 * The browser's own "leave site?" prompt, while a draft is unsaved — native.
 *
 * There is no equivalent on iOS or Android, and pretending otherwise would be
 * worse than the gap. The OS reclaims a backgrounded app without asking
 * anybody, so the honest answer there is to *persist* the draft rather than to
 * warn about losing it.
 *
 * This comment used to say that persisting needed storage the app did not
 * have — `@react-native-async-storage/async-storage` listed in
 * `native-deps.json` but absent from `package.json`, so a new native
 * dependency and a new development build before anyone could see it. That
 * stopped being true when the dependency was installed: it is in
 * `package.json` at 2.2.0 and in `native-deps.json` `core`, which means every
 * build already carries it and a plain static import is allowed.
 *
 * So the gap is no longer *blocked*, only unbuilt, and saying otherwise names
 * a reason nobody would think to re-check. What is left is the work: deciding
 * what a persisted draft's lifetime is, how it reconciles with the note's
 * etag when the app comes back, and what happens when it loses. That is a
 * project rather than an import.
 *
 * Until then this half does nothing, deliberately and visibly, and the phone's
 * protection is the confirm on closing a dirty tab plus the guard that refuses
 * to open another note. See `useUnsavedGuard.web.ts` for the half that works.
 */
export function useUnsavedGuard(_dirty: boolean): void {
  // Intentionally empty — see the file comment.
}
