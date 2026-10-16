/**
 * What a folder page knows beyond its listing: the device's notes around it,
 * with every value somebody just chose laid over them, and the one write a
 * choice makes.
 *
 * The notes come from the same place a list block's do — `FolderListSource`,
 * which is `useFolderLists` reading this device's copy at the role's
 * clearance — so the page can only ever describe notes the reader could
 * already open. Loaded from the folder itself, with subfolders, and the front
 * notes of every folder above it, since a folder's status list is inherited
 * from the nearest one that declares it (`statuses.ts`).
 *
 * Not from the parent's whole subtree, as it once was so a project's menus
 * could offer the values its siblings use: that was free against a device's
 * copy and ruinous against the server, where opening the Projects Board read
 * every note in the workspace, each one from the bucket (2026-10-08). Where
 * the source can read front notes by name (`loadFront`), the folders above
 * cost one call; elsewhere each is loaded without its subfolders, as before.
 *
 * A choice shows at once: it is laid over the notes until the device's copy
 * says the same thing, and taken back if the write is refused (the sentence
 * saying why is `problem`). Nothing here holds a note's text or writes one;
 * `setProperty` reads, changes one line and writes against the version read.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FolderListSource, ListNote, ListSource, PropertyValue } from "../listBlock/model";
import { isProjectsFolder } from "./model";
import { cachedFolder, cachedFront, readFolder, readFronts, type FolderRead } from "./pageCache";
import type { TaskHost } from "./tasks/taskHost";
import type { PeekEditing } from "./panel/peekEditing";

/** What a folder page is handed to read and change properties with. */
export interface FolderPageHost {
  readonly source: FolderListSource;
  /** Keys what each viewer last picked; one workspace's folders are not another's. */
  readonly workspaceId: string;
  /** The workspace's people: the owners offered where there is no server to search (`FolderListSource.searchOwners`). */
  readonly people: readonly string[];
  /**
   * The viewer's own name and address, which the List's "Mine" matches
   * owner lines against (resolved to their handle like any owner word).
   * Absent where the page does not know who is looking; Mine is then not offered.
   */
  readonly me?: readonly string[];
  /**
   * Adding, nesting and moving tasks on a project's List, with an undo for
   * each (`tasks/taskHost.ts`). Absent where the console cannot write — and
   * for a member, whose `source` has no `setProperty` — so the List offers
   * none of it.
   */
  readonly tasks?: TaskHost;
  /**
   * The console's one editor, lent to the side peek so a writer types in the
   * note there (`panel/peekEditing.ts`). Absent where there is none to lend —
   * the landing page's demo — and the peek reads the note, read-only.
   */
  readonly editing?: PeekEditing;
}

export interface FolderNotes {
  /** Null until the first read lands. */
  readonly notes: readonly ListNote[] | null;
  /**
   * This folder's own front note, read by name ahead of the rest, or null
   * until it lands. The title and description come from it alone, so they
   * need not wait for every note the page's List and Board are drawn from.
   */
  readonly front: readonly ListNote[] | null;
  /** False while this device may still be missing some notes. */
  readonly complete: boolean;
  /**
   * True once the notes are enough to draw the folder's statuses: the device
   * has all of them, or at least one of this folder's own, or it has been
   * `SETTLE_AFTER` since the page opened. Until then a List or Board would
   * put every item under No status and then move them all (reported on the
   * Projects board), so the page draws neither.
   */
  readonly settled: boolean;
  readonly canEdit: boolean;
  /** Why the last choice did not land, or null. */
  readonly problem: string | null;
  /** A choice is still on its way to the bucket. */
  readonly saving: boolean;
  choose(target: string, key: string, value: string | null, creates: boolean): Promise<string | null>;
  /** Several properties of one note in one write; drawn at once, like `choose`. */
  chooseMany(target: string, changes: PropertyChanges, creates: boolean): Promise<string | null>;
  /** Every note under `folder`, subfolders included, for a change that rewrites many. */
  loadAll(folder: string): Promise<readonly ListNote[] | null>;
}

/** How long a page waits for a folder's notes before it draws what it has. */
export const SETTLE_AFTER = 1500;

type Value = string | readonly string[] | null;
export type PropertyChanges = readonly (readonly [string, Value])[];
type Chosen = Map<string, Value>;

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
    else properties[key] = value as PropertyValue;
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
    const same = Array.isArray(value)
      ? Array.isArray(have) && have.length === value.length && have.every((item, i) => item === value[i])
      : have === value;
    if ((value === null && have === undefined) || same) chosen.delete(id);
  }
}

export function useFolderNotes(host: FolderPageHost | undefined, folder: string): FolderNotes {
  const source = host?.source;
  const scope = folder;
  /*
    Each read is filed under the folder it was for, and a folder with no read
    of its own yet draws what `pageCache` already holds for it: a page that
    was open before, or one its row preloaded. So a folder page arrives whole
    and a way back draws at once (owner, 2026-10-16: "the app flickers a lot").
  */
  const [loadedFor, setLoaded] = useState<{ folder: string; source: FolderListSource | undefined; read: FolderRead } | null>(null);
  const [frontFor, setFront] = useState<{ folder: string; source: FolderListSource | undefined; notes: readonly ListNote[] } | null>(null);
  const loaded =
    loadedFor !== null && loadedFor.folder === scope && loadedFor.source === source
      ? loadedFor.read
      : (cachedFolder(source, scope) ?? null);
  const front =
    frontFor !== null && frontFor.folder === scope && frontFor.source === source
      ? frontFor.notes
      : (cachedFront(source, scope) ?? null);
  const [chosen, setChosen] = useState<Chosen>(() => new Map());
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  const alive = useRef(true);
  const [waited, setWaited] = useState(false);

  useEffect(() => {
    setWaited(false);
    const timer = setTimeout(() => setWaited(true), SETTLE_AFTER);
    return () => clearTimeout(timer);
  }, [source, folder]);

  useEffect(() => {
    alive.current = true;
    setProblem(null);
    if (source === undefined) return;
    let current = true;
    /*
      The description under the title arrived a second after the page
      (owner, 2026-10-11): it waited on every note of the folder's parent,
      bodies and all, when it is one note read by name.
    */
    if (scope !== "" && source.loadFront !== undefined) {
      void readFronts(source, [scope])
        .then(() => {
          const notes = cachedFront(source, scope);
          if (current && notes !== undefined) setFront({ folder: scope, source, notes });
        })
        .catch(() => {});
    }
    const read = (fresh: boolean) => {
      void readFolder(source, scope, fresh)
        .then((result) => {
          if (current) setLoaded({ folder: scope, source, read: result });
        })
        .catch(() => {
          // A failed read leaves what was drawn; with nothing drawn, the page draws an empty List.
          if (current && cachedFolder(source, scope) === undefined) {
            setLoaded({ folder: scope, source, read: { notes: [], complete: false } });
          }
        });
    };
    read(false);
    const stop = source.subscribe?.(() => read(true));
    return () => {
      current = false;
      alive.current = false;
      stop?.();
    };
  }, [source, scope]);

  // A project folder is drawn from its statuses, so its notes are fetched now
  // rather than whenever this device's background sync gets to them.
  useEffect(() => {
    if (isProjectsFolder(folder)) source?.freshen?.(folder);
  }, [source, folder]);

  useEffect(() => {
    if (loaded === null || chosen.size === 0) return;
    const next = new Map(chosen);
    settle(loaded.notes, next);
    if (next.size !== chosen.size) setChosen(next);
  }, [loaded, chosen]);

  const setProperty = source?.setProperty;
  const setProperties = source?.setProperties;
  const chooseMany = useCallback(
    async (target: string, changes: PropertyChanges, creates: boolean): Promise<string | null> => {
      if (setProperty === undefined) return "You can read this folder but not change it.";
      const ids = changes.map(([key]) => `${target}\n${key}`);
      setProblem(null);
      setChosen((current) => {
        const next = new Map(current);
        changes.forEach(([key, value]) => next.set(`${target}\n${key}`, value));
        return next;
      });
      setPending((count) => count + 1);
      const options = creates ? { create: true } : undefined;
      const write =
        changes.length === 1 && !Array.isArray(changes[0][1])
          ? setProperty(target, changes[0][0], changes[0][1] as string | null, options)
          : setProperties === undefined
            ? Promise.resolve("This folder’s statuses can’t be changed from here.")
            : setProperties(target, changes, options);
      const answer = await write.catch(() => "That change could not be saved.");
      if (alive.current) setPending((count) => Math.max(0, count - 1));
      if (answer !== null && alive.current) {
        setChosen((current) => {
          const next = new Map(current);
          ids.forEach((id) => next.delete(id));
          return next;
        });
        setProblem(answer);
      }
      return answer;
    },
    [setProperty, setProperties],
  );
  const choose = useCallback(
    (target: string, key: string, value: string | null, creates: boolean) => chooseMany(target, [[key, value]], creates),
    [chooseMany],
  );
  const loadAll = useCallback(
    async (under: string): Promise<readonly ListNote[] | null> => {
      if (source === undefined) return null;
      const result = await source.load(under, true).catch(() => null);
      return result?.notes ?? null;
    },
    [source],
  );

  const notes = useMemo(
    () => (loaded === null ? null : overlay(loaded.notes, chosen, Date.now())),
    [loaded, chosen],
  );
  const complete = useMemo(
    () => loaded !== null && holdsFolder({ notes: loaded.notes, complete: loaded.complete, missing: loaded.missing }, folder),
    [loaded, folder],
  );
  const settled = useMemo(() => {
    if (loaded === null) return false;
    if (complete || waited) return true;
    const under = folder === "" ? "" : `${folder}/`;
    return loaded.notes.some((note) => note.path.startsWith(under));
  }, [loaded, complete, waited, folder]);
  return {
    notes,
    front,
    complete,
    settled,
    canEdit: setProperty !== undefined,
    problem,
    saving: pending > 0,
    choose,
    chooseMany,
    loadAll,
  };
}

/**
 * Whether the device holds every note this page draws. The read is of the
 * folder's parent, with subfolders — for `1-projects` that is the whole
 * workspace — so the read's own `complete` was false while any note anywhere
 * lacked a body: two hundred saved sessions in `0-inbox/` kept "This device
 * is still fetching some notes" under the Projects List for good. Only this
 * folder's notes, and the front notes above it, decide it.
 */
export function holdsFolder(result: ListSource, folder: string): boolean {
  if (result.complete) return true;
  if (result.missing === undefined) return false;
  const under = folder === "" ? "" : `${folder}/`;
  return !result.missing.some((path) => {
    if (path.startsWith(under)) return true;
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    return parent === "" || folder.startsWith(`${parent}/`);
  });
}
