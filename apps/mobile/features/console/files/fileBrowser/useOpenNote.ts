/**
 * Opening a note, and moving the selection to one or away from all of them.
 *
 * Part of `useFileBrowser`, moved out of that file verbatim. The facade calls
 * each part in the order the code used to run, so every hook is still called
 * in the same order with the same dependency lists; what a part reads from an
 * earlier one arrives in `deps`, and is the same value the code closed over
 * before.
 */
/* eslint-disable react-hooks/exhaustive-deps -- Every dependency list in this
   file was moved unchanged from `useFileBrowser.ts`, where the rule accepted
   it. What it reports here is refs, state setters and `dispatch` that now
   arrive through `deps` instead of from a `useRef`, `useState` or `useReducer`
   in the same function, so the rule can no longer see they are stable. */
import { useCallback } from "react";
import { isServerRefusal, toFileError } from "../browser";
import { guardLeaving } from "../editor";
import { isMarkdown, parentPath } from "../paths";
import { raceTimeout } from "../../storage/timeout";
import { restoreFor } from "../../../offline/restore";
import { NOT_CACHED, cachedNotice } from "../../../offline/copy";
import { findEntry } from "../tree";
import type { OpenNote } from "../types";
import { INSTANT_OPEN_MS } from "./timing";
import type { BrowserStateValues } from "./useBrowserState";
import type { FileActionsValues } from "./useFileActions";
import type { ListingsValues } from "./useListings";
import type { OfflineQueueValues } from "./useOfflineQueue";

type OpenNoteDeps =
  & Pick<FileActionsValues, "readNote" | "workspaceId">
  & Pick<
    BrowserStateValues,
    | "autosave"
    | "dispatch"
    | "editorRef"
    | "openRun"
    | "setNavigations"
    | "setNotice"
    | "setOpening"
    | "setSelectedPath"
    | "settleOpening"
  >
  & Pick<OfflineQueueValues, "listings" | "listingsRef" | "offlineRef">
  & Pick<ListingsValues, "refresh" | "reportRefreshFailure">;

export function useOpenNote(deps: OpenNoteDeps) {
  const {
    autosave, dispatch, editorRef, listings, listingsRef, offlineRef, openRun, readNote, refresh,
    reportRefreshFailure, setNavigations, setNotice, setOpening, setSelectedPath, settleOpening,
    workspaceId,
  } = deps;

  /**
   * Put a note in the editor, from the bucket if it can be reached and from the
   * device if it cannot — and put back whatever was waiting for it.
   *
   * Three things happen here that did not before, and each is a case that was
   * previously an empty screen:
   *
   *  - **Offline reads go straight to the cache.** Not as a fallback after a
   *    failure: `readNote` is a Convex action with no client-side timeout, so
   *    with no connection it never rejects and the editor would sit blank.
   *  - **A read lost to the *transport* falls back to the cache.** The signal
   *    can say online and be wrong — a captive portal, a dead uplink — and a
   *    copy is better than an empty screen, as long as it says it is a copy.
   *    **A read the server *refused* does not**, and the distinction is the
   *    whole of `isServerRefusal`: the first sentence of this list used to say
   *    "a failed read", the `catch` could not tell the two apart, and a
   *    removed membership or a revoked grant was therefore converted into a
   *    cache hit — the console rendering a note body to somebody the control
   *    plane had just refused, with an age stamp under it that made it read as
   *    considered. A local copy never overrules an answer.
   *  - **Waiting work is restored.** A queued write, or a draft typed and never
   *    saved. `restoreFor` decides which, and turns a draft whose base etag has
   *    moved on into a conflict rather than into an armed overwrite.
   */
  const openNote = useCallback(
    async (path: string): Promise<void> => {
      if (workspaceId === null) return;
      const offline = offlineRef.current;
      /*
        This open's own generation. A new open (this one) makes whatever this
        hook was waiting on before stale, and everything this call eventually
        does — every `dispatch`, every `setNotice` — is guarded by comparing
        `mine` back against `openRun.current` first. See `openRun`'s own
        comment for the three moments that move it out from under a call
        already in flight.
      */
      openRun.current += 1;
      const mine = openRun.current;
      setOpening(path);
      try {
        /*
          A note created on this device and not yet sent has no copy anywhere
          but the queue — not in the bucket, not in the mirror — so it is opened
          from there, online or not. Asking the bucket for it would be a
          refusal about a file that does not exist yet, and the editor would
          close on the person's own new note.
        */
        const created = offline.pendingCreate(path);
        if (created !== undefined) {
          const folder = listingsRef.current[parentPath(path)];
          const visibility = folder?.folderDefault ?? "private";
          const unsent: OpenNote = {
            path,
            text: created.text,
            etag: "",
            visibility,
            inherited: visibility,
            exception: false,
            readOnly: false,
          };
          const restored = restoreFor({ note: unsent, pending: created, draft: null });
          if (openRun.current !== mine) return;
          dispatch({ type: "opened", note: unsent, restored, unsent: true });
          return;
        }
        /*
          And a note renamed on this device is still at its old name in the
          bucket until the rename is sent: it is read from there, and shown
          here. `relabel` puts the name the person gave it back on whatever the
          read returned.
        */
        const source = offline.serverPathOf(path);
        const relabel = (read: OpenNote): OpenNote => (read.path === path ? read : { ...read, path });
        let note: OpenNote | null = null;
        let fromCache = false;
        let notice: string | undefined;

        if (offline.reachability === "offline") {
          const cached = await offline.cachedNote(source);
          if (cached !== null) {
            note = relabel(cached.value);
            fromCache = true;
            notice = cachedNotice({ cachedAt: cached.cachedAt, now: Date.now() });
          }
        } else {
          const reading = readNote({ workspaceId, path: source });
          /*
            Online, the mirror answers first when the bucket is slow.

            A note that is on the device should open like a note in Apple
            Notes, not after a round trip to somebody's bucket on a train's
            wifi. So the read is given `INSTANT_OPEN_MS` — long enough that an
            ordinary connection answers inside it and nothing flickers — and
            past that the mirror's copy is put in the editor, marked
            `fromCache` (the save chip says "Cached copy" until the bucket
            answers), and the read carries on behind it.

            Three things keep that honest, each a rule this file already had:

             - **Not when there is work to restore.** A queued write or a draft
               is restored against the note it was typed on (`restoreFor`),
               once; showing a copy first would mean restoring twice against
               two versions. Those opens wait for the bucket, as they always
               did.
             - **A refusal still wins.** The copy was shown while there was no
               answer; when the answer is a refusal, the editor closes and says
               so — the same outcome `isServerRefusal` gives an open that never
               showed anything. A transport failure keeps the copy, as the
               fallback below always has.
             - **Typing is never replaced.** The bucket's version replaces the
               copy only while the editor is still clean on this note. If
               somebody started typing, their draft is based on the copy's
               version, a save is checked against it, and the mirror holds that
               version as the merge's ancestor (`mirrorHolds.ts`) — so a copy
               that turned out stale becomes an ordinary conflict with a real
               Merge, never an overwrite.
          */
          const quick = await raceTimeout(reading, {
            ms: INSTANT_OPEN_MS,
            schedule: (fn, ms) => setTimeout(fn, ms),
            cancel: (handle) => clearTimeout(handle),
          });
          let early: OpenNote | null = null;
          if (quick.kind === "timeout" && openRun.current === mine) {
            const copy = await offline.instantCopy(source);
            const waiting =
              offline.pendingFor(path) !== undefined || (await offline.savedDraft(path)) !== null;
            if (copy !== null && !waiting && openRun.current === mine) {
              early = relabel(copy.value);
              dispatch({ type: "opened", note: early, fromCache: true });
              settleOpening(path);
            }
          }
          try {
            const read = quick.kind === "value" ? quick.value : await reading;
            offline.rememberNote(read);
            note = relabel(read);
            if (early !== null) {
              if (openRun.current !== mine) return;
              const shown = editorRef.current;
              if (shown.path === path && shown.status === "clean") {
                dispatch({ type: "reloaded", note });
              }
              return;
            }
          } catch (error) {
            if (early !== null) {
              if (openRun.current !== mine) return;
              if (isServerRefusal(error)) {
                dispatch({ type: "closed" });
                setNotice(toFileError(error).message);
              }
              return;
            }
            const cached = isServerRefusal(error) ? null : await offline.cachedNote(source);
            if (cached === null) {
              // Superseded: do not put a *different* request's failure into
              // the notice line, and do not close whatever is open now on its
              // behalf — that state belongs to the open (or close) that came
              // after this one.
              if (openRun.current !== mine) return;
              dispatch({ type: "closed" });
              setNotice(toFileError(error).message);
              return;
            }
            note = relabel(cached.value);
            fromCache = true;
            notice = cachedNotice({ cachedAt: cached.cachedAt, now: Date.now() });
          }
        }

        if (note === null) {
          if (openRun.current !== mine) return;
          dispatch({ type: "closed" });
          setNotice(NOT_CACHED);
          return;
        }

        /*
          An encrypted note can never legitimately carry a draft or a queued
          write — `useNoteEncryption.ts`'s own header states that editing an
          unlocked note has no autosave and no offline queue, on purpose, and
          `__tests__/encryptionDraftQueueGuard.test.ts` holds that on the
          source of every file that could reach one. So whatever is found
          here for an encrypted note's path *predates* it becoming encrypted:
          a lock made on this device with nothing yet discarding it (see
          `discardLocalCopies`, and `BrowsePane`'s own caller of it), a lock
          made on another device or tab that shares this one's local storage,
          or a queued write that raced the lock and can now only ever come
          back refused (`fileOps.ts`'s "a note this request cannot open is a
          note this request cannot write").

          None of that is restorable, and `restoreFor` has no way to know to
          refuse it: it compares text and etags, a stale plaintext draft never
          equals the ciphertext envelope now on the bucket, and the lock
          always moves the etag — so an unguarded call would restore that
          plaintext into the editor as an "unsaved changes" conflict, on a
          note the console is about to tell this same person is locked. So an
          encrypted note skips the call entirely rather than trusting it to
          decline, and — because a skipped restore does not imply an absent
          one — whatever local copy exists for it is discarded right here,
          the first time any device notices the note is encrypted, instead of
          being left to resurface the same way on every future open.
        */
        const restored = note.encrypted
          ? undefined
          : restoreFor({
              note,
              pending: offline.pendingFor(path),
              draft: await offline.savedDraft(path),
            });
        if (note.encrypted === true) {
          offline.dropQueued(path);
          offline.forgetDraft(path);
        }
        // The one that matters most: a superseded read must not put its note
        // in an editor that has moved on to another context, another note, or
        // no note at all — see the module comment at the top of this file.
        if (openRun.current !== mine) return;
        dispatch({ type: "opened", note, fromCache, notice, restored });
      } finally {
        /*
          Every exit, including the early returns above that end in `closed`
          plus a notice. A read that failed is not still opening, and leaving
          the flag set would hold the region blank under the failure's own
          message.

          Guarded the same way: a superseded call's `opening` was already
          moved on by whatever superseded it (a new open sets its own path, a
          context switch or a `deselect` sets it to `null`), and clearing it
          here — even through the path comparison inside `settleOpening` —
          could still race a same-path reopen and clear a flag belonging to
          the call that came after it.
        */
        if (openRun.current === mine) settleOpening(path);
      }
    },
    [readNote, settleOpening, workspaceId],
  );

  const select = useCallback(
    (path: string): boolean => {
      /*
        Write what is pending before anything moves.

        This is what makes the relaxed `guardLeaving` honest: a draft that was
        waiting on the idle timer is handed to the bucket on the way out rather
        than being left to a timer that will refuse to fire under the next note.
        It is the same conditional write Save makes, against the etag this draft
        was typed on, and it is issued while the editor still holds the note it
        belongs to.

        Before the guard, deliberately. The guard reads `editorRef`, which is
        assigned during render and so still says `dirty` here — the flush cannot
        change the answer it gives about this navigation, and evaluating the
        guard first would only make the ordering look load-bearing when it is
        not.
      */
      autosave.flush();
      const guard = guardLeaving(editorRef.current);
      if (!guard.allowed) {
        setNotice(guard.prompt ?? null);
        return false;
      }
      setSelectedPath(path);
      // Past the guard, so a refused navigation is not one. See `navigations`.
      setNavigations((count) => count + 1);
      setNotice(null);

      /**
       * A folder has no body. Reading one comes back `FILE_NOT_FOUND`, and the
       * console then tells somebody their own folder does not exist.
       *
       * **`findEntry` is not enough to decide this, and that is the bug this
       * comment used to describe and not prevent.** It looks a path up in its
       * *parent's* listing, so on a cold load — following a team link straight
       * to `/console/@seyi?note=1-projects/pilot`, where nothing has been
       * expanded yet — the parent is absent, the entry is unknown, and the
       * folder falls through to `readNote`. The screenshot of that says "That
       * file does not exist" over an empty page.
       *
       * So the entry decides when it is known, and the path's own shape decides
       * when it is not. A note is `.md` by construction: `createNote` appends
       * it, `writeNote` refuses anything else, and `checkSharePath` requires it.
       * Anything else is a folder, and treating an unknown `.md` as a note is
       * the right failure anyway — that is a real read whose refusal is honest.
       */
      const known = findEntry(listings, path);
      const isFolder = known === null ? !isMarkdown(path) : known.kind === "folder";
      if (isFolder) {
        dispatch({ type: "closed" });
        // Its own listing, so the folder view has contents to draw rather than
        // an empty screen. `refresh` is a no-op for a folder already loaded.
        if (listings[path] === undefined) {
          /*
            A folder reached by a link has no listing yet either, and the gap
            before one arrives is the same blank the note path has — so it is
            reported the same way. A folder already loaded is not opening: the
            view has everything it needs this frame.
          */
          setOpening(path);
          void refresh([path])
            .catch(reportRefreshFailure)
            .finally(() => settleOpening(path));
        }
        return true;
      }
      if (workspaceId === null) return true;
      void openNote(path);
      // The selection moved; whether the *read* lands is a separate question
      // this answer is not about. A caller only needs to know the guard let go.
      return true;
    },
    [autosave, listings, openNote, refresh, reportRefreshFailure, settleOpening, workspaceId],
  );

  /**
   * Close what is open. The inverse of `select`, and see `browser.ts` for why
   * its absence was a shipped defect rather than a gap in the interface.
   *
   * The same three moves `select` makes on the way out of a note — flush the
   * autosave, ask the guard, clear the notice — and then `null` instead of a
   * path. `closed` empties the editor; `setOpening(null)` because a read that
   * was still in flight is a read for a note nobody is looking at any more, and
   * leaving the flag set would hold the region blank over an empty selection.
   *
   * The read itself is not cancelled — nothing here can cancel a Convex action
   * — and it does not need to be: bumping `openRun` is what stops it mattering.
   * `openNote` compares its own generation against `openRun.current` before
   * every `dispatch`, so a read still in flight when this runs finds itself
   * superseded and drops its answer rather than springing the editor back open
   * with a note nobody is looking at any more. What must not happen either is
   * the *selection* coming back, and it cannot: `selectedPath` is only ever
   * written by `select` and `deselect`.
   */
  const deselect = useCallback((): boolean => {
    autosave.flush();
    const guard = guardLeaving(editorRef.current);
    if (!guard.allowed) {
      setNotice(guard.prompt ?? null);
      return false;
    }
    // See `openRun`: a read still in flight for the note being closed must not
    // be able to dispatch `opened` back into an editor this call just closed.
    openRun.current += 1;
    setSelectedPath(null);
    setOpening(null);
    setNotice(null);
    dispatch({ type: "closed" });
    return true;
  }, [autosave]);

  return { openNote, select, deselect };
}

export type OpenNoteValues = ReturnType<typeof useOpenNote>;
