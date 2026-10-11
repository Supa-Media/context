import { useAction } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { api } from "@context/convex/_generated/api";
import { PEEK_READ_MS, PEEK_WRITING_READ_MS, changedBlocks, peekBlocks, type PeekBlock, type PeekNote } from "../peek/peekModel";

export type NotePeekText =
  | { state: "loading" }
  | { state: "failed" }
  /** Stored encrypted: the card shows who is on it and no words. */
  | { state: "sealed" }
  | { state: "ready"; blocks: PeekBlock[]; changed: number[] };

/**
 * The words of the note the map's card is open on, read again on a loop: every
 * couple of seconds while somebody is writing it, so what they type shows up
 * as it is typed, and every quarter minute otherwise. Read through the
 * console's own note read (`files.readNote`), so it is exactly what this
 * person could open themselves. `changed` is which blocks are new since the
 * read before: the parts being written.
 */
export function useNotePeek(note: PeekNote | null, writing: boolean): NotePeekText {
  const read = useAction(api.functions.files.readNote);
  const readRef = useRef(read);
  readRef.current = read;
  const writingRef = useRef(writing);
  writingRef.current = writing;
  const key = note === null ? null : `${note.workspaceId}\n${note.path}`;
  const [shown, setShown] = useState<{ key: string; text: NotePeekText } | null>(null);
  // Asks for the next read at the new pace the moment somebody starts or stops writing.
  const poke = useRef<() => void>(() => {});

  useEffect(() => {
    if (note === null || key === null) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let last: PeekBlock[] | null = null;
    const schedule = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(load, writingRef.current ? PEEK_WRITING_READ_MS : PEEK_READ_MS);
    };
    const load = () => {
      if (stopped) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return schedule();
      readRef
        .current({ workspaceId: note.workspaceId as never, path: note.path })
        .then((file) => {
          if (stopped) return;
          if (file.encrypted) return setShown({ key, text: { state: "sealed" } });
          const blocks = peekBlocks(file.text);
          const changed = changedBlocks(last, blocks);
          last = blocks;
          setShown({ key, text: { state: "ready", blocks, changed } });
        })
        .catch(() => {
          if (!stopped && last === null) setShown({ key, text: { state: "failed" } });
        })
        .finally(() => {
          if (!stopped) schedule();
        });
    };
    poke.current = schedule;
    load();
    return () => {
      stopped = true;
      poke.current = () => {};
      if (timer !== null) clearTimeout(timer);
    };
    // `key` is the note.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => poke.current(), [writing]);

  return shown !== null && shown.key === key ? shown.text : { state: "loading" };
}
