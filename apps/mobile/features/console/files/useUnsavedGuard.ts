/**
 * The browser's own "leave site?" prompt, while a draft is unsaved — native.
 *
 * There is no equivalent on iOS or Android, and pretending otherwise would be
 * worse than the gap. The OS reclaims a backgrounded app without asking
 * anybody, so the honest answer there is to *persist* the draft rather than to
 * warn about losing it — and persisting needs storage this app does not have:
 * `@react-native-async-storage/async-storage` is listed in `native-deps.json`
 * and is not in `package.json`, so adding it is a new native dependency and a
 * new development build before anyone can see it.
 *
 * So this half does nothing, deliberately and visibly, and the phone's
 * protection is the confirm on closing a dirty tab plus the guard that refuses
 * to open another note. See `useUnsavedGuard.web.ts` for the half that works,
 * and the pull request for the native gap.
 */
export function useUnsavedGuard(_dirty: boolean): void {
  // Intentionally empty — see the file comment.
}
