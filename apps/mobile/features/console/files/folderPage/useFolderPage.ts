/**
 * What a folder page knows beyond its listing: the device's notes around it,
 * with every value somebody just chose laid over them, and the one write a
 * choice makes.
 *
 * The notes come from the same place a list block's do — `FolderListSource`,
 * which is `useFolderLists` reading this device's copy at the role's
 * clearance — so the page can only ever describe notes the reader could
 * already open. Loaded from the folder's *parent*, with subfolders, because
 * a project folder's menus offer the values its siblings use.
 *
 * A choice shows at once: it is laid over the notes until the device's copy
 * says the same thing, and taken back if the write is refused (the sentence
 * saying why is `problem`). Nothing here holds a note's text or writes one;
 * `setProperty` reads, changes one line and writes against the version read.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FolderListSource, ListNote, PropertyValue } from "../listBlock/model";
import { parentPath } from "../paths";

/** What a folder page is handed to read and change properties with. */
export interface FolderPageHost {
  readonly source: FolderListSource;
  /** Keys what each viewer last picked; one workspace's folders are not another's. */
  readonly workspaceId: string;
  /** The workspace's people, offered as owners. */
  readonly people: readonly string[];
}

export interface FolderNotes {
  /** Null until the first read lands. */
  readonly notes: readonly ListNote[] | null;
  /** False while this device may still be missing some notes. */
  readonly complete: boolean;
  readonly canEdit: boolean;
  /** Why the last choice did not land, or null. */
  readonly problem: string | null;
  /** A choice is still on its way to the bucket. */
  readonly saving: boolean;
  choose(target: string, key: string, value: string | null, creates: boolean): Promise<string | null>;
}

type Chosen = Map<string, string | null>;

function overlay(notes: readonly ListNote[], chosen: Chosen, now: number): readonly ListNote[] {
  if (chosen.size === 0) return notes;
  const byPath = new Map(notes.map((note) => [note.path, note]));
  for (const [id, value] of chosen) {
    const [path, key] = id.split("\n");
    const note = byPath.get(path);
    if (note === undefined) {
      // A note being created: drawn with the one property it will hold.
      if (value !== null) byPath.set(path, { path, updatedAt: now, properties: { [key]: value } });
      continue;
    }
    const properties: Record<string, PropertyValue> = { ...note.properties };
    if (value === null) delete properties[key];
    else properties[key] = value;
    byPath.set(path, { ...note, properties });
  }
  return [...byPath.values()];
}

/** Drop every choice the device's copy now agrees with. */
function settle(notes: readonly ListNote[], chosen: Chosen): void {
  const byPath = new Map(notes.map((note) => [note.path, note]));
  for (const [id, value] of [...chosen]) {
    const [path, key] = id.split("\n");
    const have = byPath.get(path)?.properties[key];
    if ((value === null && have === undefined) || have === value) chosen.delete(id);
  }
}

export function useFolderNotes(host: FolderPageHost | undefined, folder: string): FolderNotes {
  const source = host?.source;
  const scope = folder === "" ? "" : parentPath(folder);
  const [loaded, setLoaded] = useState<{ notes: readonly ListNote[]; complete: boolean } | null>(null);
  const [chosen, setChosen] = useState<Chosen>(() => new Map());
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    setLoaded(null);
    setProblem(null);
    if (source === undefined) return;
    let current = true;
    const read = () => {
      void source
        .load(scope, true)
        .then((result) => {
          if (!current) return;
          setLoaded(result === null ? { notes: [], complete: false } : result);
        })
        .catch(() => {
          if (current) setLoaded({ notes: [], complete: false });
        });
    };
    read();
    const stop = source.subscribe?.(read);
    return () => {
      current = false;
      alive.current = false;
      stop?.();
    };
  }, [source, scope]);

  useEffect(() => {
    if (loaded === null || chosen.size === 0) return;
    const next = new Map(chosen);
    settle(loaded.notes, next);
    if (next.size !== chosen.size) setChosen(next);
  }, [loaded, chosen]);

  const setProperty = source?.setProperty;
  const choose = useCallback(
    async (target: string, key: string, value: string | null, creates: boolean): Promise<string | null> => {
      if (setProperty === undefined) return "You can read this folder but not change it.";
      const id = `${target}\n${key}`;
      setProblem(null);
      setChosen((current) => new Map(current).set(id, value));
      setPending((count) => count + 1);
      const answer = await setProperty(target, key, value, creates ? { create: true } : undefined).catch(
        () => "That change could not be saved.",
      );
      if (alive.current) setPending((count) => Math.max(0, count - 1));
      if (answer !== null && alive.current) {
        setChosen((current) => {
          const next = new Map(current);
          next.delete(id);
          return next;
        });
        setProblem(answer);
      }
      return answer;
    },
    [setProperty],
  );

  const notes = useMemo(
    () => (loaded === null ? null : overlay(loaded.notes, chosen, Date.now())),
    [loaded, chosen],
  );
  return { notes, complete: loaded?.complete ?? false, canEdit: setProperty !== undefined, problem, saving: pending > 0, choose };
}
