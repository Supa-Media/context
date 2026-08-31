/**
 * The browser's own "leave site?" prompt, while a draft is unsaved — native.
 *
 * There is no equivalent on iOS or Android, and pretending otherwise would be
 * worse than the gap. The OS reclaims a backgrounded app without asking
 * anybody, so a prompt was never the shape of the answer here.
 *
 * **The answer this file used to say was needed now exists.** It said the
 * honest response on a phone was to *persist* the draft rather than warn about
 * losing it, and that persisting needed storage the app did not have. The
 * persisting is done: `setDraft` writes every keystroke into
 * `features/offline`, Save with no connection queues instead of hanging on an
 * action that will never answer, and opening a note puts back whatever was
 * waiting for it. This half does nothing because there is nothing left for it
 * to do, rather than because nothing could be done.
 *
 * One limit remains, and it belongs to the store rather than to this hook.
 * `features/offline/store.ts` has nowhere durable to write on a phone until
 * `@react-native-async-storage/async-storage` — already `core` in
 * `native-deps.json` — is in `package.json`; that file carries the exact
 * change. Until then a draft survives opening another note and does not survive
 * the app closing, and the console says which of those two promises is in force
 * rather than implying the stronger one. Nothing here changes when it lands.
 *
 * See `useUnsavedGuard.web.ts` for the half that still has work to do: a
 * browser tab is closed by a person, which is an act worth interrupting.
 */
export function useUnsavedGuard(_dirty: boolean): void {
  // Intentionally empty — see the file comment.
}
