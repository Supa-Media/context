import { useMemo, useRef, useState } from "react";
import type { EditorControls } from "../../console/files/liveEditorWeb/contract";
import { joinDictated, isLive, type DictationFailure } from "../../voice/dictation";
import type { DictationEngine } from "../../voice/engine";
import { useDictation } from "../../voice/useDictation";

/** What the chat box says when the microphone could not be used. */
export function chatDictationError(failure: DictationFailure, unavailable: string): string {
  switch (failure) {
    case "denied":
      return "Your browser is blocking the microphone.";
    case "no-microphone":
      return "No microphone is attached.";
    case "unreachable":
      return "The speech service didn't answer. Try again in a moment.";
    case "offline":
      return "You're offline, and dictation here needs a connection.";
    case "unsupported":
      return unavailable;
  }
}

/**
 * Dictation into the Tex chat box: the same engine and reducer the notes use
 * (`features/voice`), pointed at the box's words instead of an editor. Each
 * settled phrase is appended to the draft; Discard puts the draft back as it was
 * when the microphone opened. The guess still being revised is handed back as
 * `interim` for the box to show, never written into the draft.
 */
export function useComposerDictation(input: {
  getText: () => string;
  setText: (update: (old: string) => string) => void;
  engine?: DictationEngine;
}) {
  const { setText } = input;
  const [interim, setInterim] = useState("");
  /** The draft when the microphone opened, for Discard. */
  const before = useRef<string | null>(null);
  const setTextRef = useRef(setText);
  setTextRef.current = setText;
  const getTextRef = useRef(input.getText);
  getTextRef.current = input.getText;

  /*
    The voice hook drives an editor through three calls; the chat box needs only
    those three, so the rest of the editor's surface is absent here and never
    called by `useDictation`.
  */
  const controls = useMemo(
    () =>
      ({
        dictate: (phrase: string) => {
          setTextRef.current((old) => old + joinDictated(old, phrase));
        },
        showInterim: (text: string) => setInterim(text),
        discardDictation: () => {
          const was = before.current;
          before.current = null;
          if (was !== null) setTextRef.current(() => was);
          return was !== null;
        },
      }) as unknown as EditorControls,
    [],
  );

  const dictation = useDictation({ controls: () => controls, notePath: null, engine: input.engine });
  const live = isLive(dictation.state);

  return {
    live,
    interim: live ? interim : "",
    available: dictation.available,
    unavailable: dictation.unavailable,
    error: dictation.state.name === "failed" ? chatDictationError(dictation.state.reason, dictation.unavailable) : null,
    /** The mic key: open the microphone, or settle and close it. */
    toggle: () => {
      if (live) {
        dictation.stop();
        return;
      }
      if (dictation.state.name === "failed") dictation.dismiss();
      before.current = getTextRef.current();
      dictation.start();
    },
    /** Sending closes the microphone and keeps what landed. */
    close: () => {
      if (live) dictation.cancel();
      before.current = null;
    },
    dismiss: dictation.dismiss,
  };
}
