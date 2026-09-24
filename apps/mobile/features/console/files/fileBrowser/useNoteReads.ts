/**
 * Reading a note's body, its raw text and its form responses, and the
 * conflict the editor is showing.
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
import { ConvexError } from "convex/values";
import { toFileError } from "../browser";
import type {
  FormOutcome,
  FormResponseRetract,
  FormResponseUpdate,
  FormResponsesOutcome,
  FormVote,
} from "../formBlock";
import { raceTimeout } from "../../storage/timeout";
import { useConflictReview } from "../useConflictReview";
import type { OpenNote } from "../types";
import { OPERATION_TIMEOUT_MS } from "./timing";
import type { FileBrowserOptions } from "./types";
import type { BrowserStateValues } from "./useBrowserState";
import type { FileActionsValues } from "./useFileActions";
import type { OfflineQueueValues } from "./useOfflineQueue";

type NoteReadsDeps =
  & { options: FileBrowserOptions }
  & Pick<
    FileActionsValues,
    | "readNote"
    | "retractSubmissionAction"
    | "updateSubmissionAction"
    | "voteFormAction"
    | "workspaceId"
  >
  & Pick<BrowserStateValues, "editor" | "selectedPathRef">
  & Pick<OfflineQueueValues, "offline" | "offlineRef">;

export function useNoteReads(deps: NoteReadsDeps) {
  const {
    options, editor, offline, offlineRef, readNote, retractSubmissionAction, selectedPathRef,
    updateSubmissionAction, voteFormAction, workspaceId,
  } = deps;

  /**
   * Read a note **without** remembering it.
   *
   * The one caller is the conflict review, and the omission is the point: the
   * cache is holding the *ancestor* of the two versions being decided between,
   * and remembering the bucket's newer body over it would destroy the only
   * thing that makes a three-way merge possible. Every other read in this file
   * goes through `openNote`, which does remember.
   */
  const fetchNote = useCallback(
    async (path: string): Promise<OpenNote> => {
      if (workspaceId === null) throw new ConvexError({ code: "UNKNOWN", message: "No context." });
      // A note renamed here is still at its old name in the bucket.
      const read = await readNote({ workspaceId, path: offlineRef.current.serverPathOf(path) });
      return { ...read, path };
    },
    [readNote, workspaceId],
  );

  /**
   * `readRaw` on `FileBrowser`: a note's text and etag, for a view reading
   * several notes at once that are not "the open note" — see `browser.ts`.
   *
   * Bounded by `raceTimeout`, for the reason `run`'s own comment gives:
   * `readNote` is a Convex action with no client-side timeout, and offline it
   * neither resolves nor rejects. `null` covers every way this can fail to
   * answer — a refusal, a genuinely missing path, and a wait that timed out —
   * because a caller here has no "cached copy" to fall back to the way
   * `openNote` does, and the honest answer in all three cases is the same one
   * `read_channel_day` gives a caller who cannot see the path: not found.
   */
  const readRaw = useCallback(
    async (path: string): Promise<{ text: string; etag: string } | null> => {
      if (workspaceId === null) return null;
      const settled = await raceTimeout(readNote({ workspaceId, path }), {
        ms: OPERATION_TIMEOUT_MS,
        schedule: (fn, ms) => setTimeout(fn, ms),
        cancel: (handle) => clearTimeout(handle),
      });
      if (settled.kind !== "value") return null;
      return { text: settled.value.text, etag: settled.value.etag };
    },
    [readNote, workspaceId],
  );

  const readFormResponses = useCallback(
    async (responsesPath: string): Promise<FormResponsesOutcome> => {
      const note = await readRaw(responsesPath);
      return note === null
        ? { ok: false, message: "That response file is not available." }
        : { ok: true, text: note.text, message: "" };
    },
    [readRaw],
  );

  const voteForm = useCallback(
    async (vote: FormVote): Promise<FormOutcome> => {
      if (workspaceId === null) return { ok: false, message: "No context is open." };
      const path = selectedPathRef.current;
      if (path === null) return { ok: false, message: "No note is open." };
      try {
        await voteFormAction({ workspaceId, path, ...vote });
        return {
          ok: true,
          message: vote.vote === "up" ? "Vote added." : "Vote removed.",
        };
      } catch (error) {
        return { ok: false, message: toFileError(error).message };
      }
    },
    [voteFormAction, workspaceId],
  );

  const updateFormResponse = useCallback(
    async (change: FormResponseUpdate): Promise<FormOutcome> => {
      if (workspaceId === null) return { ok: false, message: "No context is open." };
      const path = selectedPathRef.current;
      if (path === null) return { ok: false, message: "No note is open." };
      try {
        await updateSubmissionAction({
          workspaceId,
          path,
          formId: change.formId,
          responseId: change.responseId,
          values: change.values.map((entry) => ({ ...entry })),
        });
        return { ok: true, message: "Response updated." };
      } catch (error) {
        return { ok: false, message: toFileError(error).message };
      }
    },
    [updateSubmissionAction, workspaceId],
  );

  const retractFormResponse = useCallback(
    async (change: FormResponseRetract): Promise<FormOutcome> => {
      if (workspaceId === null) return { ok: false, message: "No context is open." };
      const path = selectedPathRef.current;
      if (path === null) return { ok: false, message: "No note is open." };
      try {
        await retractSubmissionAction({ workspaceId, path, ...change });
        return { ok: true, message: "Response deleted." };
      } catch (error) {
        return { ok: false, message: toFileError(error).message };
      }
    },
    [retractSubmissionAction, workspaceId],
  );

  const conflict = useConflictReview({
    editor,
    fetchNote,
    ancestor: (path, baseEtag) => offlineRef.current.ancestorFor(offlineRef.current.serverPathOf(path), baseEtag),
    // `unknown` is treated as online: the read is what finds out, and refusing
    // to try would leave a cold load stuck on "cannot be read" forever.
    online: offline.reachability !== "offline",
    conditionalWrite: options.conditionalWrite,
  });
  const conflictRef = useRef(conflict);
  conflictRef.current = conflict;

  return {
    readRaw, readFormResponses, voteForm, updateFormResponse, retractFormResponse, conflict,
    conflictRef,
  };
}

export type NoteReadsValues = ReturnType<typeof useNoteReads>;
