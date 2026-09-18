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

  /*
    The note changed under a live microphone. `discard` rather than `stop`:
    what was said belongs to the note that was open when it was said, and the
    run this takes back is that note's. Stopping would settle the pending
    phrase into whichever note is open *now*.
  */
  const openNote = useRef(notePath);
  useEffect(() => {
    if (openNote.current === notePath) return;
    openNote.current = notePath;
    if (isLive(current.current)) dispatch({ type: "discard" });
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
