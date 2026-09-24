/**
 * Dropping local copies, resolving a conflict either way, a plugin's write,
 * and the draft and collaboration state the editor hands back.
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
import { toFileError } from "../browser";
import { autosaves, editorReducer } from "../editor";
import { parentPath } from "../paths";
import { KEEP_MINE_OFFLINE } from "../../../offline/resolution";
import type { OpenNote } from "../types";
import type { AppliedPluginNoteWrite } from "../../plugins/runtime";
import type { BrowserStateValues } from "./useBrowserState";
import type { FileActionsValues } from "./useFileActions";
import type { ListingsValues } from "./useListings";
import type { NoteReadsValues } from "./useNoteReads";
import type { OfflineQueueValues } from "./useOfflineQueue";
import type { OpenNoteValues } from "./useOpenNote";
import type { SavingValues } from "./useSaving";

type ConflictsAndDraftsDeps =
  & Pick<FileActionsValues, "readNote" | "workspaceId">
  & Pick<
    BrowserStateValues,
    | "autosave"
    | "collaborationPaths"
    | "dispatch"
    | "editorRef"
    | "saveRuns"
    | "saveTimers"
    | "setNotice"
    | "setSelectedPath"
  >
  & Pick<OfflineQueueValues, "offlineRef">
  & Pick<NoteReadsValues, "conflictRef">
  & Pick<ListingsValues, "refresh" | "reportRefreshFailure">
  & Pick<OpenNoteValues, "openNote">
  & Pick<SavingValues, "performSave">;

export function useConflictsAndDrafts(deps: ConflictsAndDraftsDeps) {
  const {
    autosave, collaborationPaths, conflictRef, dispatch, editorRef, offlineRef, openNote,
    performSave, readNote, refresh, reportRefreshFailure, saveRuns, saveTimers, setNotice,
    setSelectedPath, workspaceId,
  } = deps;

  /**
   * Drop every local copy of a path's plaintext — see `browser.ts`'s own
   * comment for who calls this and why. The same pair `discard` and
   * `useTheirs` already make for the *open* editor's path, generalised to an
   * arbitrary one: a lock's caller has just finished writing an envelope over
   * `path` and does not need — and must not have to force — that note back
   * open first to clear what predates it.
   *
   * Cancelling autosave is deliberately not this function's job: it takes a
   * path rather than reading `editorRef`, and an armed timer belongs to
   * whichever path the editor is *currently* holding, which may not be this
   * one. `performSave`'s own `if (autosave.pending() === path) autosave.cancel()`
   * is the guard for the note actually on screen; a lock success re-opens the
   * note it just wrote (`BrowsePane`'s `files.select`), and that reopen is
   * itself what clears `dirty`/`status`, so nothing here has to. `select`
   * flushes a pending timer rather than dropping it, so what that reopen can
   * still issue is the same *conditional* write `performSave` always makes,
   * against the etag the draft was typed on — which the lock has moved, so the
   * bucket refuses it and the envelope stands.
   *
   * What it does drop, beyond its old name: the cached body. See the block
   * inside, and `browser.ts` for the whole argument.
   */
  const discardLocalCopies = useCallback((path: string) => {
    offlineRef.current.dropQueued(path);
    offlineRef.current.forgetDraft(path);
    /*
      And the cached body, which is the copy nothing else here would take.

      `sweep`'s bounds reach it in thirty days and `forgetWorkspace` reaches it
      when the context is left; neither is "now", and now is what a lock
      promised. The reopen that follows a lock does overwrite it — but only if
      it lands, and a read that fails between the two falls back to exactly
      this record and serves the pre-lock plaintext into an ordinary editor,
      because a copy taken before the lock carries `encrypted: false` and so
      never reaches `openNote`'s guard below.
    */
    offlineRef.current.forgetNote(path);
  }, []);

  /**
   * React to a lock performed by another live console. Stop future local
   * writes, invalidate a save already in flight, remove durable copies, and
   * clear the editor before waiting for the bucket. `select` cannot be reused:
   * it intentionally flushes autosave, which would send the plaintext this
   * notification exists to revoke.
   */
  const encryptedElsewhere = useCallback(
    (path: string) => {
      if (autosave.pending() === path) autosave.cancel();
      const running = saveTimers.current.get(path);
      if (running !== undefined) {
        clearTimeout(running);
        saveTimers.current.delete(path);
      }
      saveRuns.current.set(path, (saveRuns.current.get(path) ?? 0) + 1);
      discardLocalCopies(path);
      if (editorRef.current.path !== path) return;
      dispatch({ type: "closed" });
      void openNote(path);
    },
    [autosave, discardLocalCopies, openNote],
  );

  /**
   * The person answered the conflict: this text, over the version they saw.
   *
   * One function for two of the three answers — "keep mine" is this with the
   * draft, "merge" is this with whatever they approved in the review — because
   * the only thing that differs is the text, and the thing that must **not**
   * differ is what the write is checked against.
   *
   * `theirsEtag` is the etag the review actually read the bucket at, so the
   * write is conditional on the version that was on screen when they decided.
   * If somebody has moved it again since, the write comes back `CONFLICT`, the
   * editor goes back into `conflict`, and this whole surface reappears with
   * fresh content. **There is no force flag and no second write path**; the
   * only way to overwrite somebody here is to be shown their version first.
   */
  const resolveWith = useCallback(
    (text: string) => {
      const current = editorRef.current;
      if (current.path === null || current.status !== "conflict") return;
      // An update resolution is not available until the bucket version has
      // actually been read and shown. A deletion resolution is the parallel
      // safe case: the failed conditional update authoritatively established
      // absence, so `null` means create-only rather than blind overwrite.
      // This guard keeps both boundaries intact if another caller invokes the
      // callback directly.
      const review = conflictRef.current;
      const reviewedEtag = review?.theirsDeleted === true ? null : review?.theirsEtag;
      if (reviewedEtag === undefined || (reviewedEtag === null && review?.theirsDeleted !== true)) {
        return;
      }
      const path = current.path;
      const offline = offlineRef.current;
      const etag = reviewedEtag;

      if (offline.reachability === "offline" || offline.serverPathOf(path) !== path) {
        /*
          Nothing can be read or written now, so this is a decision about what
          the queue holds rather than a write. (Online too, for a note renamed
          on this device: its write goes to the old name, ahead of the rename,
          so it is the queue's to send — `performSave` says the same.) `queueSave` takes the newer text
          (and cannot advance the base etag, by design), and `keepQueued`
          re-bases onto the version the conflict reported and puts it back in
          the queue — so what eventually drains is still a conditional write
          against a version this person was shown.
        */
        offline.queueSave({ path, text, baseEtag: etag });
        offline.keepQueued(path);
        dispatch({ type: "edited", text });
        dispatch({ type: "saveQueued", message: KEEP_MINE_OFFLINE });
        if (offline.reachability !== "offline") offline.drain();
        return;
      }

      /*
        The cache moves onto the version they were shown, and it moves *before*
        the write rather than after it.

        It is not optimism: at this moment the bucket really did hold that body
        at that etag — the review read it — and the cache is a mirror of the
        bucket, so this is the more accurate record either way. What it buys is
        the next round. If a third writer gets in before this write lands, the
        refusal comes back with the draft they just approved, whose common
        ancestor is precisely the version now cached — so the merge is offered
        again, correctly, instead of the console having to say the ancestor is
        gone.
      */
      const theirs = conflictRef.current?.theirs;
      if (theirs !== undefined && theirs !== null && etag !== null) {
        offline.rememberBody({ path, text: theirs, etag });
      }

      // The draft becomes what they approved, and the etag becomes the version
      // it is being written over, *before* the write — so a refusal leaves the
      // reviewed text in the editor rather than the text it replaced.
      dispatch({ type: "resolving", text, etag });
      performSave(path, text, etag);
    },
    [performSave],
  );

  /**
   * "Load theirs" — take the bucket's version and let this draft go.
   *
   * The one path in the console that deliberately destroys somebody's typing,
   * and it is reached from a control pressed with the conflict explained beside
   * it. So it has to take the draft *and* anything holding a copy of it: the
   * queue entry and the written-down draft both go, or the next time this note
   * is opened the console restores the very text the person just chose to drop.
   */
  const useTheirs = useCallback(() => {
    const current = editorRef.current;
    if (workspaceId === null || current.path === null) return;
    const path = current.path;
    const offline = offlineRef.current;
    const source = offline.serverPathOf(path);
    offline.dropQueued(path);
    offline.forgetDraft(path);
    if (conflictRef.current?.theirsDeleted === true) {
      autosave.cancel();
      setSelectedPath(null);
      dispatch({ type: "closed" });
      void refresh([parentPath(path)]).catch(reportRefreshFailure);
      return;
    }
    readNote({ workspaceId, path: source })
      .then((note: OpenNote) => {
        offlineRef.current.rememberNote(note);
        dispatch({ type: "reloaded", note: { ...note, path } });
      })
      .catch((error: unknown) => setNotice(toFileError(error).message));
  }, [autosave, readNote, refresh, reportRefreshFailure, workspaceId]);

  const applyPluginNoteWrite = useCallback((write: AppliedPluginNoteWrite) => {
    const current = editorRef.current;
    if (current.path !== write.path) return;
    if (current.etag !== write.expectedEtag) return;
    if (current.status !== "clean" && current.status !== "saved") return;

    const note: OpenNote = {
      path: write.path,
      text: write.text,
      etag: write.etag,
      visibility: current.visibility,
      inherited: current.inherited,
      exception: current.exception,
      readOnly: current.readOnly,
      encrypted: current.encrypted,
    };
    offlineRef.current.forgetDraft(write.path);
    offlineRef.current.dropQueued(write.path);
    offlineRef.current.rememberNote(note);
    dispatch({ type: "reloaded", note });
  }, []);

  /**
   * "Keep mine" — send this draft over the version that is there now.
   *
   * The queue is re-based in step with the editor. Leaving it behind would mean
   * the editor moving onto the current etag while a queued entry still carried
   * the stale one, so the next drain would raise the same conflict again about
   * a decision the person has already made.
   */
  const keepMine = useCallback(() => {
    const path = editorRef.current.path;
    if (path !== null) offlineRef.current.keepQueued(path);
    dispatch({ type: "conflictOverridden" });
    /*
      And arm the timer, because this is the one route into `dirty` that is not
      a keystroke.

      Autosave is armed from `setDraft`, which is right for every other path
      into that status — somebody typed. "Keep mine" produces a writable draft
      without anybody typing, and leaving it unarmed meant the person resolved
      the conflict, watched nothing happen, and still owed the app a press of
      Save. That is precisely the thing this change exists to remove, surviving
      in the one place somebody has just been made to think hard.

      Safe to arm unconditionally: the reducer has already moved the state to
      `dirty` on the etag they chose to replace, and `autosaveNow` re-asks
      `autosaves` when the timer comes due anyway.
    */
    if (path !== null) autosave.edited(path);
  }, [autosave]);

  const discard = useCallback(() => {
    const path = editorRef.current.path;
    if (path !== null) {
      offlineRef.current.dropQueued(path);
      offlineRef.current.forgetDraft(path);
    }
    // Belt and braces: `autosaveNow` would refuse a discarded draft anyway,
    // because the note is `clean` by the time the timer comes due. Cancelling
    // is what makes that a decision rather than a coincidence of ordering.
    autosave.cancel();
    dispatch({ type: "discarded" });
  }, [autosave]);

  /**
   * Every keystroke, written down.
   *
   * Two destinations, and which one depends on whether Save has been pressed
   * yet. Before it, the text is a *draft* — nothing has tried to send it — and
   * it is kept so that closing the tab, or the OS reclaiming a backgrounded
   * app, does not throw it away. After it, the text belongs to the queue, and
   * `queueSave` supersedes the entry so what eventually reaches the bucket is
   * the last thing typed rather than the version that happened to be waiting
   * when the signal went.
   *
   * Both are debounced inside `useOfflineNotes`; neither writes to storage per
   * character.
   */
  const setDraft = useCallback(
    (text: string) => {
      const current = editorRef.current;
      dispatch({ type: "edited", text });
      if (current.path === null || current.readOnly) return;
      if (collaborationPaths.current.has(current.path)) return;

      /*
        And, unless the state says otherwise, scheduled to be written to the
        bucket.

        The decision is made against the state this edit *produces*, by running
        the reducer — not by re-deriving "is it dirty now" here. There is one
        definition of what an edit does to the status (`edited`, which keeps a
        conflict a conflict and a queued draft queued) and one definition of
        what may be written without being asked for (`autosaves`); a second
        copy of either in this callback is how they come to disagree, and the
        direction that disagreement fails is an automatic write over somebody
        else's version.
      */
      if (autosaves(editorReducer(current, { type: "edited", text }))) {
        autosave.edited(current.path);
      } else {
        autosave.cancel();
      }

      const offline = offlineRef.current;
      if (current.status === "queued") {
        offline.queueSave({ path: current.path, text, baseEtag: current.etag });
        return;
      }
      if (text === current.baseline) {
        offline.forgetDraft(current.path);
        return;
      }
      offline.rememberDraft({
        path: current.path,
        text,
        baseEtag: current.etag,
        savedAt: Date.now(),
      });
    },
    [autosave],
  );

  const setCollaborationOwned = useCallback((path: string, owned: boolean) => {
    if (owned) collaborationPaths.current.add(path);
    else if (offlineRef.current.pendingFor(path) === undefined) collaborationPaths.current.delete(path);
  }, []);

  const setCollaborationDraft = useCallback((text: string) => {
    const current = editorRef.current;
    if (current.path === null || current.readOnly) return;
    dispatch({ type: "edited", text });
  }, []);
  const setCollaborationState = useCallback(
    (next: { text: string; etag: string | null; status: "offline" | "storing" | "local" | "syncing" | "saved" | "error" | "unavailable" | "revoked"; pending: number; recovery?: { baseline: string; desired: string; baseEtag?: string | null }; legacyAdopted?: { path: string; text: string; baseEtag: string } }) => {
      if (next.legacyAdopted !== undefined) {
        offlineRef.current.adoptLegacy(next.legacyAdopted);
      }
      dispatch({ type: "collaboration", ...next });
    },
    [],
  );

  const dismissNotice = useCallback(() => setNotice(null), []);

  return {
    discardLocalCopies, encryptedElsewhere, resolveWith, useTheirs, applyPluginNoteWrite, keepMine,
    discard, setDraft, setCollaborationOwned, setCollaborationDraft, setCollaborationState,
    dismissNotice,
  };
}

export type ConflictsAndDraftsValues = ReturnType<typeof useConflictsAndDrafts>;
