/**
 * The browser's own state: listings as the bucket gave them, the tree's
 * expansion, the selection, the editor reducer, toasts, and the generation
 * counters and autosave controller every later callback reads through refs.
 *
 * Part of `useFileBrowser`, moved out of that file verbatim. The facade calls
 * each part in the order the code used to run, so every hook is still called
 * in the same order with the same dependency lists; what a part reads from an
 * earlier one arrives in `deps`, and is the same value the code closed over
 * before.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { ToastSpec } from "../../../design/components/Toast";
import type { Clipboard } from "../clipboard";
import { editorReducer, emptyEditor } from "../editor";
import { type AutosaveController, createAutosaveController } from "../autosave";
import type { Listings } from "./types";

export function useBrowserState() {
  /*
    What the bucket (or, offline, the mirror) listed. What the console *draws*
    is `listings`, below: these with the offline queue's renames, deletes, new
    notes and new folders laid over them (`overlay.ts`).
  */
  const [bucketListings, setListings] = useState<Listings>({});
  /**
   * When the request behind each folder's live listing started. A tree drawn
   * from the mirror's index replaces a folder only when the walk behind it
   * started later: otherwise a note this console just created, and refreshed
   * its folder for, would vanish under a manifest walked a moment before it.
   */
  const listedAtRef = useRef(new Map<string, number>());
  /**
   * A change this console drew before the bucket confirmed it — a move, a new
   * folder, or undoing one. Every folder whose listing it touched counts as
   * listed now, so a walk that started before the change cannot redraw the
   * tree without it in the moment before the confirming refresh lands.
   */
  const drawLocally = useCallback((change: (current: Listings) => Listings) => {
    const at = Date.now();
    setListings((current) => {
      const next = change(current);
      for (const folder of new Set([...Object.keys(current), ...Object.keys(next)])) {
        if (current[folder] !== next[folder]) listedAtRef.current.set(folder, at);
      }
      return next;
    });
  }, []);
  /**
   * Every note path the search index's docmap knows about for this context,
   * or `null` while there is nothing to answer from — no index yet, offline,
   * or the request has not landed. See `linkPaths` below for what this is
   * merged with, and `docs/decisions/app-and-console.md` "L1" for why the
   * docmap rather than a second listing.
   */
  const [indexedPaths, setIndexedPaths] = useState<readonly string[] | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  /**
   * How many times `select` has moved somewhere. See `navigations` on
   * `FileBrowser` for what reads it and why a path alone cannot answer it.
   *
   * State rather than a ref, because its consumer is an effect
   * (`useNoteAddress`) and a ref change does not run one — the whole point is
   * that the commit carrying a new selection also carries the fact that
   * somebody navigated to it.
   */
  const [navigations, setNavigations] = useState(0);
  /*
    The selection whose contents are still on their way. See `opening` in
    `browser.ts` for what reads it and why the pane cannot infer it from
    `selectedPath` and `editor` alone.

    Cleared with a functional update comparing against the path that set it, so
    a slow read for a note somebody has already navigated away from cannot
    clear the flag belonging to the one they are waiting on now.
  */
  const [opening, setOpening] = useState<string | null>(null);
  const settleOpening = useCallback((path: string) => {
    setOpening((current) => (current === path ? null : current));
  }, []);
  const [editor, dispatch] = useReducer(editorReducer, emptyEditor);
  const [clipboard, setClipboard] = useState<Clipboard | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [toasts, setToasts] = useState<readonly ToastSpec[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);

  // The reducer's state, readable from callbacks without making every callback
  // depend on it — `guardLeaving` has to see the *current* draft, not the one
  // captured when the row was rendered.
  const editorRef = useRef(editor);
  editorRef.current = editor;
  /** Paths whose prose is owned by the durable collaboration controller. */
  const collaborationPaths = useRef(new Set<string>());

  /*
    The selection, readable from a callback that outlives the render that made
    it. An undo runs seconds after the operation it inverts, by which time the
    `selectedPath` captured in that render may be somebody else's.
  */
  const selectedPathRef = useRef(selectedPath);
  selectedPathRef.current = selectedPath;

  /*
    Toast identity. A counter rather than the message or the path, because two
    archives of the same note in one session would collide on either of those
    and React would reuse the first toast's element — including its timer, which
    is what decides when the undo goes away.
  */
  const nextToastId = useRef(0);
  const dismissToast = useCallback(
    (id: string) => setToasts((current) => current.filter((toast) => toast.id !== id)),
    [],
  );

  /**
   * Say something transient that is nobody's operation.
   *
   * A refused paste is the first of these: it is not the result of a row
   * command, so it has no undo and does not belong in the `notice` line, which
   * is about the console's own state. `nextToastId` rather than the message for
   * identity, for the reason that counter's own comment gives.
   */
  const say = useCallback((message: string) => {
    nextToastId.current += 1;
    setToasts([{ id: `say-${nextToastId.current}`, message }]);
  }, []);

  /**
   * The generation counter and timer handle for the save in flight, **per
   * note**.
   *
   * The same shape `createReverifyController` uses, and for the same reason: a
   * response that arrives after its own attempt was abandoned must not be able
   * to settle anything. Here the counter is bumped both when a new save starts
   * *and* when one times out, so a write that lands after we stopped waiting is
   * discarded rather than being allowed to mark the editor clean against a
   * draft the person has since typed more into.
   *
   * **Keyed by path, which it was not before autosave.** One counter was
   * enough while `guardLeaving` refused to leave a note with a save in flight:
   * only one save could exist. Now leaving flushes instead of refusing, so a
   * write for the note you just left is routinely still in the air when the
   * next one starts — and a single counter would let the second save silently
   * discard the first one's answer, skipping the cache bookkeeping that keeps
   * a device copy from resurrecting a draft that was written.
   */
  const saveRuns = useRef(new Map<string, number>());
  const saveTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  /**
   * The generation of the toolbar operation in flight.
   *
   * Same job as `saveRun`: an operation that answers after its own attempt was
   * abandoned must not be able to touch `busy` or `notice`, because by then
   * those belong to whatever the person did next.
   */
  const operationRun = useRef(0);

  /**
   * The generation of the note (or context) `openNote` is answering for.
   *
   * The same shape as `operationRun`, for a read rather than a write: a read
   * answers the request that made it, or nobody. `openNote` closes over
   * `workspaceId` and has no other way to tell "the read I started" from "the
   * read that happens to resolve while I am waiting" — two contexts and two
   * quick opens both look identical to a promise that has already gone out.
   *
   * Bumped in three places, each a moment nothing already on screen may be
   * answered into: the "load whenever context changes" effect (a read for the
   * *previous* context settling in the new one is note A's body under note
   * B's chrome), `openNote` itself (a second open makes the first one's
   * eventual answer stale, whatever path it was for), and `deselect` (closing
   * the note is not itself an open, but it is exactly as invalidating as one —
   * without this bump a read in flight when somebody closes the note would
   * spring the editor back open with content nobody asked for any more).
   *
   * Captured at the start of `openNote`, compared just before every dispatch
   * and `setNotice` that would otherwise let a stale answer speak for the
   * request now in flight (or for nothing in flight at all).
   */
  const openRun = useRef(0);

  /**
   * The autosave timers, and the one function they are allowed to call.
   *
   * The controller is created once for the life of the hook, so it cannot be
   * rebuilt — with its pending timers dropped — by a render. What it calls goes
   * through a ref for the same reason every other callback here does: `save`
   * would otherwise capture the first render's `performSave` and write with a
   * `workspaceId` from before a context switch.
   */
  const autosaveNowRef = useRef<(path: string) => void>(() => {});
  const autosaveRef = useRef<AutosaveController | null>(null);
  if (autosaveRef.current === null) {
    autosaveRef.current = createAutosaveController({
      schedule: (fn, ms) => setTimeout(fn, ms),
      cancel: (handle) => clearTimeout(handle),
      save: (path) => autosaveNowRef.current(path),
    });
  }
  const autosave = autosaveRef.current;

  useEffect(
    () => () => {
      for (const timer of saveTimers.current.values()) clearTimeout(timer);
      saveTimers.current.clear();
      autosave.dispose();
    },
    [autosave],
  );

  return {
    bucketListings, setListings, listedAtRef, drawLocally, indexedPaths, setIndexedPaths, expanded,
    setExpanded, selectedPath, setSelectedPath, navigations, setNavigations, opening, setOpening,
    settleOpening, editor, dispatch, clipboard, setClipboard, notice, setNotice, toasts, setToasts,
    busy, setBusy, loading, setLoading, editorRef, collaborationPaths, selectedPathRef,
    nextToastId, dismissToast, say, saveRuns, saveTimers, operationRun, openRun, autosaveNowRef,
    autosave,
  };
}

export type BrowserStateValues = ReturnType<typeof useBrowserState>;
