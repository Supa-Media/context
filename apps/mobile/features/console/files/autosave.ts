/**
 * When an unsaved draft is written to the bucket without anybody pressing Save.
 *
 * The console used to have exactly one route from a draft to the customer's
 * bucket: the Save button (or ⌘S). Every note-taking app people already use
 * saves for them, so the button was the app asking to be looked after. This is
 * the scheduler that removes it — the *decision* about which drafts may be
 * written automatically lives in `editor.ts` (`autosaves`), because that is a
 * statement about the state machine and belongs beside it.
 *
 * No React and no timer globals: handles are injected, exactly as
 * `storage/timeout.ts` and `storage/reverify.ts` inject theirs, so every branch
 * below — including the two that must *not* fire — is a test in plain node
 * rather than something discovered against somebody's notes.
 *
 * ## Why two timers rather than one
 *
 * **Idle** is the one people expect: stop typing, it saves. On its own it is a
 * write per typing pause, which is the right cost for a person composing a
 * note.
 *
 * **A ceiling** is the one nobody thinks of until it bites. Dictation on iOS
 * inserts text in a near-continuous stream — a partial result every few hundred
 * milliseconds — and a pure idle debounce never fires for the length of a
 * dictated paragraph. So the first edit after a quiet period also starts a
 * deadline that later edits do **not** push back, and whichever timer comes
 * first wins.
 *
 * ## What this deliberately does not know
 *
 * Whether the note it was armed for is still the one on screen. It hands the
 * captured path back to `save`, and the caller compares it against what the
 * editor is holding *now* — see `useFileBrowser`. Deciding that here would mean
 * this module holding a reference to editor state, and the failure it guards
 * against (note A's text written over note B, or against B's etag) is worth
 * being checked in the one place that knows the answer.
 */

/**
 * How long the draft has to stop changing before it is written.
 *
 * Two seconds is the pause between sentences, not the pause between words: at
 * 200ms it would fire mid-thought and spend a request on every phrase, and at
 * five it is long enough for somebody to have shut the laptop. Obsidian's own
 * default is two.
 *
 * **The cost this buys, stated plainly.** One save is a Convex action → the
 * gateway → one conditional PUT against the customer's own bucket, plus one
 * LIST to refresh the note's folder — two requests on *their* quota. At this
 * debounce a normal composing session is a couple of requests per typing pause,
 * which is the same order as the Save presses it replaces. A per-keystroke save
 * would be hundreds and is why this is a debounce rather than an effect.
 */
export const AUTOSAVE_IDLE_MS = 2_000;

/**
 * The longest a draft may go unwritten while it is still being changed.
 *
 * Fifteen seconds bounds what a crash, a closed lid or a lost connection costs
 * to one paragraph, and bounds continuous input — dictation, a paste loop, a
 * fast typist who never pauses for two whole seconds — to four writes a minute
 * (eight requests) in the worst case. Long enough that ordinary typing never
 * reaches it, because the idle timer has already fired.
 */
export const AUTOSAVE_MAX_WAIT_MS = 15_000;

export interface AutosaveController {
  /**
   * The draft for this path changed and is worth writing.
   *
   * Re-arms the idle timer every time. Starts the ceiling only when nothing was
   * pending, or when the pending path is a different note — a ceiling that
   * restarted on every keystroke would be an idle debounce with extra steps.
   */
  edited: (path: string) => void;
  /** Nothing is worth writing any more. Both timers go. */
  cancel: () => void;
  /**
   * Write what is pending **now**, if anything is.
   *
   * Answers whether it fired, so a caller that is about to navigate can say
   * whether it handed anything over. `path` restricts it to that note, for a
   * caller acting on one tab rather than on the editor.
   */
  flush: (path?: string) => boolean;
  /** The note with an unwritten draft waiting on a timer, or `null`. */
  pending: () => string | null;
  /** Clear the timers on unmount. */
  dispose: () => void;
}

export function createAutosaveController<Handle>(options: {
  schedule: (fn: () => void, ms: number) => Handle;
  cancel: (handle: Handle) => void;
  /** Write this note's draft. Called with the path that was armed. */
  save: (path: string) => void;
  idleMs?: number;
  maxWaitMs?: number;
}): AutosaveController {
  const idleMs = options.idleMs ?? AUTOSAVE_IDLE_MS;
  const maxWaitMs = options.maxWaitMs ?? AUTOSAVE_MAX_WAIT_MS;

  let pending: string | null = null;
  let idle: Handle | null = null;
  let ceiling: Handle | null = null;
  let disposed = false;

  function clear() {
    if (idle !== null) {
      options.cancel(idle);
      idle = null;
    }
    if (ceiling !== null) {
      options.cancel(ceiling);
      ceiling = null;
    }
  }

  function fire() {
    const path = pending;
    clear();
    pending = null;
    if (path !== null) options.save(path);
  }

  return {
    edited(path) {
      if (disposed) return;
      /*
        A different note. The old one's timers are dropped rather than fired:
        the caller flushes on the way out of a note (`select`), so anything
        worth writing has already been handed over, and firing here would
        write it a second time against an etag the first write has moved.
      */
      if (pending !== path) {
        clear();
        pending = path;
        ceiling = options.schedule(() => {
          ceiling = null;
          fire();
        }, maxWaitMs);
      }
      if (idle !== null) options.cancel(idle);
      idle = options.schedule(() => {
        idle = null;
        fire();
      }, idleMs);
    },

    cancel() {
      clear();
      pending = null;
    },

    flush(path) {
      if (pending === null) return false;
      if (path !== undefined && path !== pending) return false;
      fire();
      return true;
    },

    pending: () => pending,

    dispose() {
      disposed = true;
      clear();
      pending = null;
    },
  };
}
