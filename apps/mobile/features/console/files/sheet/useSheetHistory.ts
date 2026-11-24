/**
 * How a sheet sends its changes, and takes them back. Every change is a
 * function of the file's current text; `commit` applies it to the text as last
 * sent (so two changes in one moment build on each other, not on a stale
 * prop), hands the result to `onChangeText`, and keeps the text before it for
 * Cmd/Ctrl+Z. `undo(true)` is redo. A different file starts with no history.
 */

import { useEffect, useRef } from "react";

/** How many of this session's changes Cmd/Ctrl+Z can take back. */
export const UNDO_DEPTH = 100;

export function useSheetHistory(
  path: string,
  text: string,
  onChangeText: (next: string) => void,
): { commit: (edit: (current: string) => string) => void; undo: (again: boolean) => void } {
  const history = useRef<{ undo: string[]; redo: string[] }>({ undo: [], redo: [] });
  useEffect(() => {
    history.current = { undo: [], redo: [] };
  }, [path]);

  const liveText = useRef(text);
  liveText.current = text;
  const sent = useRef<{ from: string; to: string } | null>(null);
  const latest = () => {
    const sentNow = sent.current;
    return sentNow && sentNow.from === liveText.current ? sentNow.to : liveText.current;
  };

  const send = (edit: (current: string) => string, record: "undo" | "redo" | "none"): void => {
    const base = latest();
    const next = edit(base);
    if (next === base) return;
    const h = history.current;
    if (record === "undo") {
      h.undo = [...h.undo, base].slice(-UNDO_DEPTH);
      h.redo = [];
    } else if (record === "redo") {
      h.redo = [...h.redo, base].slice(-UNDO_DEPTH);
    }
    sent.current = { from: liveText.current, to: next };
    onChangeText(next);
  };

  const commit = (edit: (current: string) => string): void => send(edit, "undo");
  const undo = (again: boolean) => {
    const h = history.current;
    const from = again ? h.redo : h.undo;
    const back = from[from.length - 1];
    if (back === undefined) return;
    if (again) {
      h.redo = from.slice(0, -1);
      // Redo is a change like any other, so it can be undone again.
      h.undo = [...h.undo, latest()].slice(-UNDO_DEPTH);
      send(() => back, "none");
    } else {
      h.undo = from.slice(0, -1);
      send(() => back, "redo");
    }
  };
  return { commit, undo };
}
