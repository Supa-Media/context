import type { DictationFailure } from "./dictation";

/**
 * The seam between "somebody is talking" and "here are words", and the native
 * half of it, which is deliberately empty.
 *
 * ## Why the phone answers `available: false` rather than growing a recorder
 *
 * There is already a microphone key on the keyboard somebody is looking at.
 * iOS and Android both dictate into any focused text field, straight into
 * CodeMirror, and `features/console/files/autosave.ts` was written *around*
 * that behaviour — its whole `AUTOSAVE_MAX_WAIT_MS` ceiling exists because
 * "dictation on iOS inserts text in a near-continuous stream" and an idle-only
 * debounce never fires under one. The platform's dictation is not a gap in this
 * feature; it is the feature, already shipped, by the OS, with a better engine
 * than a React Native module would reach.
 *
 * Building a second one here would mean two dictation affordances on the same
 * screen inserting into the same document with different spacing rules. So the
 * button on a phone offers the other answer — record a meeting — and says where
 * the mic it does not own lives.
 *
 * `capture/audio.ts` is not that second engine and is not reachable from here.
 * It records a *meeting*: chunked audio to a transcriber, no interim results,
 * seconds of latency. Pointing dictation at it would produce a caret that
 * catches up with the speaker half a minute later.
 *
 * Metro resolves `engine.web.ts` ahead of this file in a browser bundle, so
 * this is what the phone gets and that file is what the console gets.
 */

export interface DictationHandlers {
  /** The engine's current guess. The caller draws it; nobody saves it. */
  interim(text: string): void;
  /** The engine has stopped revising this phrase. */
  final(text: string): void;
  error(reason: DictationFailure): void;
  /** The engine has closed. No further callback will arrive. */
  ended(): void;
}

export interface DictationEngine {
  /** Can this surface turn speech into words at all? */
  readonly available: boolean;
  /**
   * What to tell somebody when it cannot — a sentence, not a code.
   *
   * On the sheet this is the whole of the dictate row's explanation, so it says
   * what *does* work rather than only what does not.
   */
  readonly unavailable: string;
  /** Open the microphone. Only called when `available`. */
  open(handlers: DictationHandlers): void;
  /** Settle what is pending into finals, then end. What Stop means. */
  finalize(): void;
  /** Close without settling anything. What Discard means. */
  abandon(): void;
}

export const KEYBOARD_MIC =
  "Your keyboard already has a microphone key, and it types straight into the note.";

export function createDictationEngine(): DictationEngine {
  return {
    available: false,
    unavailable: KEYBOARD_MIC,
    open: (handlers) => handlers.error("unsupported"),
    finalize: () => {},
    abandon: () => {},
  };
}
