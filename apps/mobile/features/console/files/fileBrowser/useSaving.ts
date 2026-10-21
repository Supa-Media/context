import { trackEvent } from "../../../observability/client";
/**
 * Saving the open note: the conditional write, the Save button, and autosave.
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
import { useCallback, useRef } from "react";
import { toFileError } from "../browser";
import { SAVE_TIMEOUT_MS, autosaves } from "../editor";
import { parentPath } from "../paths";
import { draftIsKept } from "./copy";
import { isBlankNewNote } from "./unsentNotes";
import type { BrowserStateValues } from "./useBrowserState";
import type { FileActionsValues } from "./useFileActions";
import type { ListingsValues } from "./useListings";
import type { OfflineQueueValues } from "./useOfflineQueue";
import type { TrashedNoteValues } from "./useTrashedNote";

type SavingDeps =
  & Pick<FileActionsValues, "workspaceId" | "writeNote">
  & Pick<
    BrowserStateValues,
    | "autosave"
    | "autosaveNowRef"
    | "collaborationPaths"
    | "dispatch"
    | "editorRef"
    | "renamingRef"
    | "saveRuns"
    | "saveTimers"
    | "setNotice"
    | "setSelectedPath"
    | "unsentCreates"
  >
  & Pick<OfflineQueueValues, "announceSaved" | "offlineRef">
  & Pick<ListingsValues, "refresh" | "reportRefreshFailure">
  & Pick<TrashedNoteValues, "trashedRef">;

export function useSaving(deps: SavingDeps) {
  const {
    announceSaved, autosave, autosaveNowRef, collaborationPaths, dispatch, editorRef, offlineRef,
    refresh, renamingRef, reportRefreshFailure, saveRuns, saveTimers, setNotice, workspaceId, writeNote, trashedRef,
    setSelectedPath, unsentCreates,
  } = deps;
  // For the one retry below that saves again under another name.
  const performSaveRef = useRef<(path: string, text: string, expectedEtag: string | null) => void>(() => {});

  /**
   * One conditional write, whatever asked for it.
   *
   * **The path, the text and the etag are arguments rather than reads off
   * `editorRef`, and that is the whole reason this exists separately from
   * `save`.** A conflict answer has to write text the editor has only just been
   * told about, against an etag the editor has only just been told about, in
   * the same tick — and `editorRef.current` is assigned during render, so it is
   * still the pre-dispatch state at that moment. Reading the state here would
   * make "keep mine" send the version it was replacing, and it would do it
   * silently.
   *
   * Every caller gets the same write: `writeNote` with `expectedEtag`, so the
   * server's `onlyIf: { etagMatches }` where the bucket has one and its
   * read-compare where it does not. There is no unconditional branch in this
   * file and no force flag anywhere in it.
   */
  const performSave = useCallback(
    (path: string, text: string, expectedEtag: string | null) => {
      if (workspaceId === null) return;
      const offline = offlineRef.current;
      /*
        Whatever the timer was holding for this note is being written now, by
        this call. Leaving it armed would spend a second request writing the
        same text against an etag this write is about to move past. Only this
        note's timer: another note's pending write is not this call's to drop.
      */
      if (autosave.pending() === path) autosave.cancel();

      /*
        A new note nobody has written in is never written: not by the
        autosave, not by leaving it, not by Save (Dev2, 2026-10-18;
        `unsentNotes.ts`). Online or off — offline it would be a queued create
        of an empty note.
      */
      if (expectedEtag === null && isBlankNewNote(path, text)) return;

      /*
        With no connection the text goes into the queue instead of into a socket
        that will never answer.

        Decided from the signal rather than from an error, because there is no
        error to decide from: `writeNote` is a Convex action, `action()` has no
        client-side timeout, and offline it neither resolves nor rejects. The
        existing behaviour was thirty seconds of a disabled toolbar followed by
        "we don't know whether that save landed" — for a save that certainly did
        not.

        `enqueue` carries the etag this text was written against, so the write
        that eventually goes is the same conflict-checked write this function
        would have made now.
      */
      /*
        And a note renamed on this device goes through the queue even online:
        the bucket still has it under its old name, so a write to the new one
        would be a create beside it. Queued, it is sent to the old name ahead
        of the rename — see `serverPathOf` — and the drain runs now.
      */
      const renamedHere = offline.serverPathOf(path) !== path;
      if (offline.reachability === "offline" || renamedHere) {
        trackEvent("note_save_result", { result: "queued" });
        offline.queueSave({ path, text, baseEtag: expectedEtag });
        offline.forgetDraft(path);
        dispatch({
          type: "saveQueued",
          message:
            offline.reachability !== "offline"
              ? "Waiting for the rename before it to reach your bucket."
              : offline.durable
                ? "No connection, so this is written down on this device and will be sent when you are back."
                : "No connection, so this is held for this session and will be sent when you are back. Closing the app loses it.",
        });
        if (offline.reachability !== "offline") offline.drain();
        return;
      }

      const mine = (saveRuns.current.get(path) ?? 0) + 1;
      saveRuns.current.set(path, mine);
      const running = saveTimers.current.get(path);
      if (running !== undefined) clearTimeout(running);
      /*
        The one dispatch below that is *not* compared against the open note, and
        it needs no comparison rather than having been missed: every caller of
        `performSave` passes the note the editor is holding. `save` and
        `resolveWith` read the path straight off `editorRef`, and `autosaveNow`
        — the only caller that could ever pass another one — refuses before it
        gets here. The settlement dispatches below are guarded because they land
        *later*, when that is no longer true.
      */
      trackEvent("note_save_started");
      dispatch({ type: "saveStarted" });

      saveTimers.current.set(
        path,
        setTimeout(() => {
          saveTimers.current.delete(path);
          if (saveRuns.current.get(path) !== mine) return;
          // Bump past `mine` so the write, if it ever lands, cannot come back
          // and settle an attempt the editor has already given up on.
          saveRuns.current.set(path, mine + 1);
          trackEvent("note_save_result", { result: "timeout" });
          // A timeout for a note that is no longer on screen has no editor to
          // put into `error`, and the reducer would put the *other* note there.
          // See the failure branch below for the whole argument.
          if (editorRef.current.path !== path) {
            setNotice(
              `${path} is still waiting on your bucket, so we stopped waiting. We don't know whether that save landed. ${draftIsKept(offlineRef.current.durable)}`,
            );
            return;
          }
          dispatch({ type: "saveTimedOut" });
        }, SAVE_TIMEOUT_MS),
      );

      const settle = () => {
        const timer = saveTimers.current.get(path);
        if (timer !== undefined) {
          clearTimeout(timer);
          saveTimers.current.delete(path);
        }
      };

      writeNote({
        workspaceId,
        path,
        text,
        expectedEtag: expectedEtag ?? undefined,
      })
        .then((result) => {
          if (saveRuns.current.get(path) !== mine) return;
          settle();
          trackEvent("note_save_result", { result: "success" });
          /*
            The text is in the bucket now, so the copy of it on this device is
            not a draft any more — leaving it would restore "unsaved changes"
            identical to the file, on a note nobody had touched. The cache moves
            onto the text and etag that were just written, so a later offline
            read of this note shows what the person saved rather than what they
            opened.
          */
          offlineRef.current.forgetDraft(path);
          offlineRef.current.rememberBody({ path, text, etag: result.etag });
          // A new note's first save was its create: it is an ordinary note now.
          const created = expectedEtag === null ? unsentCreates.current.get(path) : undefined;
          if (created !== undefined) {
            unsentCreates.current.delete(path);
            created.landed();
          }
          // And anybody sharing this note right now, so their next save is
          // checked against the version this one just produced.
          announceSaved({ path, etag: result.etag });
          /*
            And the queue entry goes with it, if there was one.

            There is one whenever this save is answering something the queue was
            already holding — a refusal being retried, or a conflict somebody
            has just decided. Leaving it behind would send the drain back at the
            bucket with the *stale* base etag it was parked on, which raises the
            same conflict again about a decision that has already been made.
          */
          offlineRef.current.landedQueued(path, result.etag);
          /*
            The editor describes the note that is **open**, and with autosave
            this write is routinely for one that is not: leaving a note flushes
            its draft, and the answer arrives after the next note has loaded.
            `saveSucceeded` would then move the *other* note's baseline and
            etag onto this write's — marking somebody's real unsaved draft
            clean and arming their next save against a version it was never
            based on. The same guard `onDrained` has, for the same reason.

            Everything above this line still runs, because it is keyed by path
            and is what stops the device copy resurrecting a draft that was
            written. Only the reducer is skipped.
          */
          if (editorRef.current.path === path) {
            dispatch({
              type: "saveSucceeded",
              etag: result.etag,
              conflictCheck: result.conflictCheck,
            });
          }
          void refresh([parentPath(path)]).catch(reportRefreshFailure);
        })
        .catch((error: unknown) => {
          if (saveRuns.current.get(path) !== mine) return;
          settle();
          trackEvent("note_save_result", { result: "failed" });
          let failure = toFileError(error);
          const unsent = expectedEtag === null ? unsentCreates.current.get(path) : undefined;
          if (unsent !== undefined && failure.code === "FILE_NOT_FOUND") failure = toFileError(unsent.refusal());
          /*
            A new note's create refused because its untitled name is taken: a
            note made on another device since this one listed the folder.
            Nobody chose that name, so the note moves to the next one and
            saves there, as the press used to before it opened at once.
          */
          if (unsent !== undefined && failure.code === "CONFLICT" && editorRef.current.path === path) {
            const to = unsent.retarget();
            if (to !== null) {
              unsentCreates.current.delete(path);
              const shown = editorRef.current;
              const from = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
              const next = to.slice(to.lastIndexOf("/") + 1).replace(/\.md$/i, "");
              const draft = shown.draft.startsWith(`# ${from}`) ? `# ${next}${shown.draft.slice(from.length + 2)}` : shown.draft;
              editorRef.current = { ...shown, path: to, draft };
              dispatch({ type: "renamed", from: path, to });
              if (draft !== shown.draft) dispatch({ type: "edited", text: draft });
              setSelectedPath(to);
              performSaveRef.current(to, draft, null);
              return;
            }
          }
          if (editorRef.current.path !== path) {
            /*
              Same rule, and this direction is worse: `saveFailed` would put
              whatever note is open now into `conflict` or `error`, over a
              refusal that was about a different file — and a conflict carries
              `conflictEtag`, so the wrong note would be offered somebody
              else's version to merge with.

              It is not swallowed. The draft is on the device and comes back
              when the note is reopened (`restoreFor` — as a conflict if the
              bucket has moved on), so the notice says which note and where its
              text is rather than implying it is gone.
            */
            setNotice(
              `${path} could not be saved: ${failure.message} ${draftIsKept(offlineRef.current.durable)}`,
            );
            return;
          }
          dispatch({ type: "saveFailed", error: failure });
        });
    },
    [announceSaved, autosave, refresh, reportRefreshFailure, workspaceId, writeNote],
  );
  performSaveRef.current = performSave;

  /**
   * Write the open note.
   *
   * `writeNote` is a Convex action and `ConvexReactClient.action()` has no
   * client-side timeout, so a connection that drops mid-save leaves the promise
   * pending forever — and the editor pinned in `saving`, where Save is
   * disabled, Discard is not rendered, and `guardLeaving` blocks opening
   * anything else. **There is no control left**, and the only escape is a
   * reload that loses the draft.
   *
   * So the save is raced against a timer, exactly the way `storage/reverify.ts`
   * races the probe: same 30s, same generation counter, and a settled state
   * that offers a way forward rather than a spinner that promises one.
   */
  const save = useCallback(() => {
    const current = editorRef.current;
    if (current.path === null || current.readOnly || collaborationPaths.current.has(current.path)) return;
    if (renamingRef.current?.path === current.path) return;
    performSave(current.path, current.draft, current.etag);
  }, [performSave]);

  /**
   * A timer came due. Write that note's draft — **if it is still that note.**
   *
   * The scariest bug available in this whole change is right here. A timer
   * armed while `1-projects/plan.md` was open fires two seconds later, by which
   * time somebody has clicked `0-inbox/idea.md`; without the comparison below
   * it would write `editorRef.current.draft` — the *other* note's text — to
   * whichever path, against whichever etag, the state happens to hold now.
   * Either arrangement of that is somebody's note overwritten with somebody
   * else's words, which is the one failure this console must never produce.
   *
   * So the path is captured when the timer is armed (`autosave.edited`), handed
   * back here, and compared. A note that has moved on simply drops the write:
   * the draft it was for is already on the device, and `select` flushed it on
   * the way out anyway.
   *
   * `autosaves` is re-asked here rather than trusted from arming time, because
   * the two seconds in between are long enough for a conflict to arrive, for a
   * save to be pressed, or for the person to have discarded the draft.
   */
  const autosaveNow = useCallback(
    (path: string) => {
      const current = editorRef.current;
      if (current.path !== path) return;
      if (collaborationPaths.current.has(path)) return;
      // Its file is moving; the draft follows it there (`renamingRef`).
      if (renamingRef.current?.path === path) return;
      // In the trash: a write here would put it back behind the trash's back.
      if (trashedRef.current?.path === path) return;
      if (!autosaves(current)) return;
      performSave(path, current.draft, current.etag);
    },
    [performSave],
  );
  autosaveNowRef.current = autosaveNow;

  /**
   * Write what the timer is holding, now.
   *
   * The other half of "stop bugging people to save": leaving a note, closing a
   * tab or closing the browser tab hands the pending draft over rather than
   * asking somebody to. Answers whether it wrote anything, so a caller can tell
   * "nothing was owed" from "it has been dealt with".
   */
  const flushAutosave = useCallback(
    (path?: string) => autosave.flush(path),
    [autosave],
  );

  return { performSave, save, flushAutosave };
}

export type SavingValues = ReturnType<typeof useSaving>;
