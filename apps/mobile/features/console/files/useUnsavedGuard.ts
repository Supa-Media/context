import type { EditorState } from "./editor";

/**
 * The exit the app does not own — native.
 *
 * There is no equivalent on iOS or Android, and pretending otherwise would be
 * worse than the gap. The OS reclaims a backgrounded app without asking
 * anybody, so a prompt was never the shape of the answer here.
 *
 * **The answer this file used to say was needed now exists twice over.** It
 * said the honest response on a phone was to *persist* the draft rather than
 * warn about losing it, and that persisting needed storage the app did not
 * have. The persisting is done: `setDraft` writes every keystroke into
 * `features/offline`, Save with no connection queues instead of hanging on an
 * action that will never answer, and opening a note puts back whatever was
 * waiting for it. And since autosave, the draft also reaches the *bucket*
 * without anybody pressing anything — a couple of seconds after typing stops,
 * and at latest every `AUTOSAVE_MAX_WAIT_MS` while it does not.
 *
 * It is durable: `features/offline/store.ts` writes through
 * `@react-native-async-storage/async-storage`, which is `core` in
 * `native-deps.json`. So a draft on a phone survives the OS reclaiming the app,
 * which is the event this hook could never have warned about anyway.
 *
 * **This half is deliberately not the flush half either.** The web file
 * flushes on `visibilitychange`/`pagehide`; the equivalent here is React
 * Native's `AppState`, and it is not wired up because the ordering it would
 * need is the one thing a backgrounded app cannot promise — the OS may freeze
 * the process before a Convex action leaves it. What makes a phone draft safe
 * is the device copy plus the next autosave, not a listener racing a
 * suspension.
 *
 * See `useUnsavedGuard.web.ts` for the half that still has work to do: a
 * browser tab is closed by a person, which is an act worth interrupting when —
 * and only when — nothing else will finish the job.
 */
export function useUnsavedGuard(_options: {
  editor: EditorState;
  flush: () => void;
}): void {
  // Intentionally empty — see the file comment.
}
