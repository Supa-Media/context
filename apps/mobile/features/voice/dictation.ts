/**
 * Dictation, as a state machine with no microphone in it.
 *
 * ## Why the rules live here and not in the hook
 *
 * One property decides whether this feature can ship at all: **a word that has
 * not settled never reaches the file.** A speech engine emits a phrase half a
 * dozen times before it stops changing its mind — "the handover is the one" →
 * "the handover is the one thing I" — and every one of those is a guess. The
 * mock draws them as grey italic for that reason, and the promise the grey
 * makes is that they are a decoration over the document rather than text in it.
 *
 * A promise like that cannot live inside a React effect beside a live
 * `SpeechRecognition`, because the only way to check it there is to talk at a
 * browser and read the file afterwards. Here it is a pure function, so
 * `voiceDictation.test.ts` can drive a thousand interim events through it and
 * assert that not one of them produced an `insert`. `docs/decisions/testing.md`
 * — *a guard nobody has checked is not a guard* — is the whole argument for the
 * shape of this file.
 *
 * ## Effects rather than calls
 *
 * `reduce` answers with a next state and a list of things for somebody else to
 * do. It opens nothing, dispatches nothing and holds no editor. That is what
 * makes "stop does not insert the pending phrase" and "discard asks the engine
 * to abandon rather than to settle" testable as data instead of as behaviour
 * observed through two async boundaries.
 *
 * The caller — `useDictation` — owns the engine and the editor, and is
 * deliberately dull: run the effects in order, feed the events back.
 */

/** Why dictation is not running, in the words the sheet and the capsule use. */
export type DictationFailure =
  /** The person, or the browser on their behalf, refused the microphone. */
  | "denied"
  /** There is no input device at all. */
  | "no-microphone"
  /**
   * The engine cannot reach whatever turns sound into words.
   *
   * Drawn in amber and not rust: nothing is broken and nothing was lost. It is
   * the honest-degrade case `CLAUDE.md` asks for — *probe capability and
   * degrade honestly, never silently drop it* — and for dictation the honest
   * answer is to stop, because there is nothing to append and a microphone that
   * looks live while producing no words is the worse failure.
   */
  | "unreachable"
  /**
   * The engine needs a connection and this device does not have one.
   *
   * Its own case rather than `unreachable`, because the person can act on it
   * and the action is somewhere else: Chrome's engine is a network service, so
   * offline it can only fail, while the computer's own dictation — macOS and
   * Windows both ship one — works with no connection at all. "The words cannot
   * be made right now" was true and left them with nothing to do.
   */
  | "offline"
  /** This surface has no speech engine. See `engine.ts`. */
  | "unsupported";

export type DictationState =
  | { name: "idle" }
  /** The microphone is open. `interim` is what is currently being guessed. */
  | { name: "listening"; interim: string }
  /**
   * Stop was pressed and the engine was asked to settle what it had.
   *
   * A real state rather than a flag because the finals that answer a `stop`
   * arrive *after* it, and they are the words somebody just said. Treating stop
   * as "idle immediately" is how the last sentence of every dictation gets
   * dropped.
   */
  | { name: "stopping"; interim: string }
  | { name: "failed"; reason: DictationFailure };

export type DictationEvent =
  /** The button was pressed. */
  | { type: "start" }
  /** The engine's current guess. Never text; always a decoration. */
  | { type: "interim"; text: string }
  /** The engine has stopped changing its mind about this phrase. */
  | { type: "final"; text: string }
  /** Stop: settle what is pending, keep it. */
  | { type: "stop" }
  /** Discard: settle nothing, and take back what this run put in the note. */
  | { type: "discard" }
  /**
   * Something else needs the microphone, or the note went away.
   *
   * Between `stop` and `discard` and it is neither: the pending phrase is
   * dropped, because there is nothing left to settle it into, and what already
   * landed **stays**. A person who dictates three sentences and then opens
   * another note said those sentences; taking them back out would be this
   * feature deleting somebody's writing because they navigated.
   */
  | { type: "cancel" }
  /** The engine has closed. Nothing more is coming. */
  | { type: "ended" }
  | { type: "error"; reason: DictationFailure };

export type DictationEffect =
  /** Open the microphone. */
  | { do: "open" }
  /** Ask the engine to settle pending audio into finals, then end. */
  | { do: "finalize" }
  /** Close the engine without settling anything. */
  | { do: "abandon" }
  /** Put this text in the document, at the caret. */
  | { do: "insert"; text: string }
  /** Draw this as the pending guess. `""` clears it. Never document text. */
  | { do: "ghost"; text: string }
  /** Take back everything this run inserted, if the run is still intact. */
  | { do: "undoRun" };

export interface Step {
  state: DictationState;
  effects: readonly DictationEffect[];
}

export const IDLE: DictationState = { name: "idle" };

/** A state in which the microphone is open, or is closing with words still owed. */
export type LiveState = Extract<DictationState, { name: "listening" | "stopping" }>;

/**
 * Is the microphone open, or about to close with words still owed?
 *
 * A type predicate rather than a boolean, so the `!isLive(state) return` guard
 * at the top of each branch below is also what tells the compiler the state has
 * an `interim` on it. Written as a plain boolean it type-checked only with a
 * cast in every branch, which is a cast standing where a narrowing belongs.
 */
export function isLive(state: DictationState): state is LiveState {
  return state.name === "listening" || state.name === "stopping";
}

/**
 * One event against one state.
 *
 * ## The two lines that are the whole point
 *
 * `interim` returns a `ghost` and nothing else, in every state. `stop` and
 * `discard` return no `insert` at all. Between them those are the invariant:
 * there is no path from an unsettled phrase to the document, and no amount of
 * pressing Stop at the right moment can make one.
 */
export function reduce(state: DictationState, event: DictationEvent): Step {
  switch (event.type) {
    case "start":
      // Starting from `failed` is how the Try again affordance works: the
      // reason is not sticky, because the microphone may well have been
      // allowed in the meantime.
      if (isLive(state)) return { state, effects: [] };
      return { state: { name: "listening", interim: "" }, effects: [{ do: "open" }] };

    case "interim":
      if (!isLive(state)) return { state, effects: [] };
      return {
        state: { ...state, interim: event.text },
        effects: [{ do: "ghost", text: event.text }],
      };

    case "final": {
      if (!isLive(state)) return { state, effects: [] };
      // The guess this final replaces stops being drawn in the same step that
      // its settled form goes in, so there is never a frame showing both.
      const effects: DictationEffect[] = [{ do: "ghost", text: "" }];
      if (event.text.trim() !== "") effects.push({ do: "insert", text: event.text });
      return { state: { ...state, interim: "" }, effects };
    }

    case "stop":
      if (state.name !== "listening") return { state, effects: [] };
      // `finalize`, not `abandon`: what is pending was said out loud by a
      // person who then pressed Stop, and they meant to keep it. The engine
      // answers with finals, which arrive in `stopping` and are inserted.
      return { state: { name: "stopping", interim: state.interim }, effects: [{ do: "finalize" }] };

    case "discard":
      if (!isLive(state)) return { state, effects: [] };
      return {
        state: IDLE,
        effects: [{ do: "abandon" }, { do: "ghost", text: "" }, { do: "undoRun" }],
      };

    case "cancel":
      if (!isLive(state)) return { state, effects: [] };
      return { state: IDLE, effects: [{ do: "abandon" }, { do: "ghost", text: "" }] };

    case "ended":
      if (!isLive(state)) return { state, effects: [] };
      return { state: IDLE, effects: [{ do: "ghost", text: "" }] };

    case "error":
      return {
        state: { name: "failed", reason: event.reason },
        effects: [{ do: "abandon" }, { do: "ghost", text: "" }],
      };
  }
}

/**
 * Characters after which a dictated phrase needs no space in front of it.
 *
 * An opening bracket or quote is the case that makes this a set rather than a
 * whitespace check: somebody who types `(` and then speaks wants `(the probe`,
 * not `( the probe`.
 */
const OPENS = new Set(["(", "[", "{", "“", "‘", '"', "'"]);

/**
 * Punctuation that a phrase may start with, which then closes up to the left.
 *
 * Engines emit `, and the second thing` as its own final often enough that
 * without this a dictated sentence collects spaces before its commas.
 */
const CLOSES = new Set([".", ",", "!", "?", ";", ":", ")", "]", "}", "’", "%"]);

/**
 * What to actually insert, given what the caret already has behind it.
 *
 * Speech arrives as bare phrases with no leading space, so inserting one
 * verbatim after an existing word produces `probeand the second`. Putting the
 * space on the *engine* side is not an option — the engine is a browser's, and
 * three of them disagree — so the joining rule is ours, it is here, and it is a
 * pure function over one character of context.
 *
 * `before` is the text preceding the caret; only its last character matters,
 * and it is taken as a string rather than a character so callers can hand over
 * a slice without thinking about an empty document.
 */
export function joinDictated(before: string, phrase: string): string {
  const text = phrase.trim();
  if (text === "") return "";
  const last = before.slice(-1);
  if (last === "") return text;
  if (/\s/.test(last)) return text;
  if (OPENS.has(last)) return text;
  if (CLOSES.has(text[0]!)) return text;
  return ` ${text}`;
}
