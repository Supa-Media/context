import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EditorControls } from "../console/files/LiveEditor";
import {
  IDLE,
  isLive,
  reduce,
  type DictationEffect,
  type DictationEvent,
  type DictationState,
} from "./dictation";
import { createDictationEngine, type DictationEngine } from "./engine";

/**
 * The dull half: run the reducer's effects, feed its events back.
 *
 * Everything with a rule in it is somewhere else — `dictation.ts` decides what
 * happens, `engine.web.ts` talks to the browser, `dictate.ts` talks to the
 * editor. What is left here is wiring, and it is written to stay that way: if a
 * condition starts to appear in this file, it belongs in the reducer where a
 * test can reach it without a renderer.
 *
 * ## Two things this owns that the reducer cannot
 *
 * **The microphone is closed when the component goes away.** A person who
 * navigates mid-sentence must not leave a browser tab listening, and no pure
 * function can promise that — only an effect cleanup can.
 *
 * **Changing note stops dictation.** The reducer knows nothing about notes; it
 * would happily keep inserting into whatever editor it is handed next, which
 * means the second half of a sentence landing in a file the speaker never
 * meant. Watching the path here is the cheapest place to make that impossible.
 */

export interface DictationApi {
  state: DictationState;
  /** Open the microphone. Safe to call twice. */
  start: () => void;
  /** Settle what is pending and keep it. */
  stop: () => void;
  /** Settle nothing and take the run back out of the note. */
  discard: () => void;
  /** Close the microphone, keep what landed, drop the pending phrase. */
  cancel: () => void;
  available: boolean;
  /** The engine's sentence for why it is not available. `""` when it is. */
  unavailable: string;
}

export function useDictation(input: {
  /**
   * The live editor, read at the moment an effect runs.
   *
   * A getter rather than the handle itself, exactly as `NoteAccessory` takes
   * one: the handle is `null` between notes, and a dictated phrase arriving in
   * that window must find nothing rather than a destroyed `EditorView`.
   */
  controls: () => EditorControls | null;
  /** The note on screen. A change to it stops the microphone. */
  notePath: string | null;
  /** Injected by tests. Defaults to this surface's engine. */
  engine?: DictationEngine;
}): DictationApi {
  const { controls, notePath } = input;
  const engine = useMemo(() => input.engine ?? createDictationEngine(), [input.engine]);

  const [state, setState] = useState<DictationState>(IDLE);
  /*
    The state is held twice on purpose. Events arrive from the engine's own
    callbacks, which close over whatever `dispatch` they were given; reading
    React state there would read the render that opened the microphone and
    every later event would reduce against a stale state. The ref is what the
    reducer reads; the state is what the screen reads.
  */
  const current = useRef<DictationState>(IDLE);
  const latest = useRef({ controls, engine });
  latest.current = { controls, engine };

  const dispatch = useCallback((event: DictationEvent) => {
    const step = reduce(current.current, event);
    current.current = step.state;
    /*
      The screen is told before the effects run, and that order is load-bearing.

      An effect can dispatch back **synchronously** — `engine.ts` answers `open`
      with `error("unsupported")` on the spot, and a browser that refuses the
      microphone outright can do the same. That nested dispatch sets the state
      to `failed`; with `setState` after the loop, this call would then set it
      back to `listening` and the failure would be swallowed, leaving a capsule
      claiming to listen to a microphone that never opened. Found by `a refused
      microphone says the note was left alone`.
    */
    setState(step.state);
    for (const effect of step.effects) run(effect, latest.current, dispatch);
  }, []);

  const start = useCallback(() => dispatch({ type: "start" }), [dispatch]);
  const stop = useCallback(() => dispatch({ type: "stop" }), [dispatch]);
  const discard = useCallback(() => dispatch({ type: "discard" }), [dispatch]);
  const cancel = useCallback(() => dispatch({ type: "cancel" }), [dispatch]);

  /*
    The note changed under a live microphone.

    `cancel`, and the choice between the three verbs is the whole of it.
    `stop` would settle the pending phrase into whichever note is open *now*,
    which is a sentence landing in a file its speaker never had open. `discard`
    would take the run back out — deleting three sentences somebody dictated and
    meant, because they clicked another note. `cancel` closes the microphone,
    drops the half-phrase nobody can place any more, and leaves what landed
    exactly where it landed.

    ## The window this does not close, stated rather than left to be found

    An effect runs after the render that changed the note, so in principle a
    phrase the engine settled microseconds earlier could be delivered into the
    editor now on screen. A version of this file carried a second guard for it —
    the started-on path, compared at delivery, the way `autosave.ts` compares
    its captured path. It was **removed**, because nothing in this harness can
    reach that window: `act` flushes render and effects together, so a test
    that "reproduces" it either never re-renders (and the guard is not what
    refuses the phrase) or flushes the effect first (and dictation is already
    closed). An unreachable guard is not a guard — `docs/decisions/testing.md` —
    and a guard whose test passes for another reason is worse than none,
    because it reads as coverage.

    What is left is the ordinary React ordering, and it is narrow: the speech
    event would have to land between commit and the passive-effect flush of the
    same frame. If it is ever seen, the fix is to move this to a render-phase
    check rather than to re-add a check nothing exercises.
  */
  const openNote = useRef(notePath);
  useEffect(() => {
    if (openNote.current === notePath) return;
    openNote.current = notePath;
    if (isLive(current.current)) dispatch({ type: "cancel" });
  }, [notePath, dispatch]);

  // Unmounting with the microphone open is the one failure nobody would see
  // and everybody would mind.
  useEffect(
    () => () => {
      latest.current.engine.abandon();
      latest.current.controls()?.showInterim?.("");
    },
    [],
  );

  return {
    state,
    start,
    stop,
    discard,
    cancel,
    available: engine.available,
    unavailable: engine.unavailable,
  };
}

function run(
  effect: DictationEffect,
  deps: { controls: () => EditorControls | null; engine: DictationEngine },
  dispatch: (event: DictationEvent) => void,
): void {
  switch (effect.do) {
    case "open":
      deps.engine.open({
        interim: (text) => dispatch({ type: "interim", text }),
        final: (text) => dispatch({ type: "final", text }),
        error: (reason) => dispatch({ type: "error", reason }),
        ended: () => dispatch({ type: "ended" }),
      });
      break;
    case "finalize":
      deps.engine.finalize();
      break;
    case "abandon":
      deps.engine.abandon();
      break;
    case "insert":
      deps.controls()?.dictate(effect.text);
      break;
    case "ghost":
      deps.controls()?.showInterim?.(effect.text);
      break;
    case "undoRun":
      deps.controls()?.discardDictation?.();
      break;
  }
}
