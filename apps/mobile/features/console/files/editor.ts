/**
 * The note editor's state machine.
 *
 * Plain markdown in a textarea — not a WYSIWYG. What is worth being careful
 * about is not the typing, it is the two moments either side of it:
 *
 *  - **Unsaved changes.** Clicking another note with an unsaved draft must not
 *    throw the draft away. A draft is now *written* on the way out rather than
 *    guarded — `autosaves` says which drafts may be written without anybody
 *    asking, `autosave.ts` decides when, and `guardLeaving` is left holding
 *    only the two cases nothing can write for you (`needsDecision`).
 *  - **Conflicts.** The bucket is also open in Obsidian and being written by
 *    AI clients, so "somebody else saved while you were typing" is the normal
 *    case, not an edge case. On a conflict the draft is **kept**, nothing is
 *    written, and the person is given three answers — keep theirs, keep mine,
 *    or a reviewed three-way merge of the two (`files/ConflictResolver.tsx`).
 *    There is no silent clobber in any direction; the one automatic answer is
 *    a drawing's, merged by element (`drawingMerged`, `@context/drawings`).
 *
 * A reducer rather than a pile of `useState`s, because the interesting
 * transitions — a conflict arriving while the person has already typed more, a
 * second save starting before the first resolved — are exactly the ones that
 * are untestable inside a component and trivial to test here. The console's
 * Jest suite runs in plain node with no renderer.
 */

import type { ConflictCheck, FileError, OpenNote, Visibility } from "./types";

export type EditorStatus =
  /** Nothing open. */
  | "empty"
  /** Open, unchanged since it was loaded. */
  | "clean"
  /** Open with unsaved changes. */
  | "dirty"
  | "saving"
  /** Saved just now. Decays back to `clean` in the UI. */
  | "saved"
  /**
   * Written down, waiting for a connection.
   *
   * Not a kind of `saved` and not a kind of `dirty`. The draft is in the
   * offline queue (`features/offline`), so it survives opening another note
   * and — where the store is durable — the app closing. It is **not** in the
   * customer's bucket, and no copy for this state may imply that it is: the
   * whole product is that the bucket is the thing that is real.
   */
  | "queued"
  /** Somebody else wrote it while this draft was open. */
  | "conflict"
  /** The save failed for some other reason; the draft is intact. */
  | "error";

export interface EditorState {
  status: EditorStatus;
  path: string | null;
  /** The text as last known on the server. What "unchanged" compares against. */
  baseline: string;
  /** What is in the textarea. */
  draft: string;
  /** The etag the draft was based on. `null` for a note that does not exist yet. */
  etag: string | null;
  /** `privacy.md` — shown, explained, never typed into. */
  readOnly: boolean;
  /**
   * The open note is stored encrypted, so `baseline` and `draft` are its
   * ciphertext and there is nothing here to edit.
   *
   * Always accompanied by `readOnly`, which is what actually holds the editor
   * shut. This is the copy: "Read-only" is what `privacy.md` is, and it is the
   * wrong word for a note whose content this console has no key for.
   */
  encrypted: boolean;
  /**
   * What the open note's visibility is, carried from the `OpenNote` that
   * opened it.
   *
   * Held here because the console cannot always find it anywhere else. Every
   * other consumer reads a note's visibility off the entry in its **parent
   * folder's** listing, and on a cold load — a team link straight to
   * `/console/@seyi?note=3-resources/books/plan.md` — that listing has never
   * been fetched. `entryAt` in `tree.ts` falls back to these, which is what
   * stops a deep-linked note rendering as "choose a note to read".
   *
   * `private` for an empty editor rather than `team`, so a state with nothing
   * open never reads as something shared.
   */
  visibility: Visibility;
  /** The folder default this note inherits, ignoring its own exception. */
  inherited: Visibility;
  /** `visibility !== inherited`. See `FileEntry.exception`. */
  exception: boolean;
  /** Copy for the status line. */
  message?: string;
  /** On a conflict: the etag that is actually current, so a save can be forced. */
  conflictEtag?: string;
  /**
   * On a conflict: the etag this draft was **typed against**.
   *
   * Not the same as `etag`, and the difference is what makes a three-way merge
   * possible. `etag` is what the next save will be checked against, and it
   * moves — a note reopened after a queued write conflicted carries the etag it
   * was just read at. This one does not move: it names the version that is the
   * *common ancestor* of the draft and whatever is in the bucket now, which is
   * the version the read cache may still be holding a body for.
   *
   * Carried on the state rather than looked up, because the two places a
   * conflict arrives from know it and nothing downstream can recover it: a
   * refused save knows it was the etag it sent, and a restored draft knows it
   * from the queue entry it came out of.
   */
  draftBase?: string | null;
  /**
   * The newest revision the durable collaboration controller has had
   * acknowledged by the bucket for this note.
   *
   * `etag` only moves when everything is saved, which during continuous
   * typing can be never; this one moves on every acknowledgement. It is the
   * base a restarted controller must replay this draft against: anything
   * older names a version from before most of the draft had landed, and the
   * whole draft since then would be sent again (2026-09-30).
   */
  collaborationEtag?: string;
  /** How the last successful save checked for conflicts. */
  conflictCheck?: ConflictCheck;
  /**
   * This note's body came off the device, not out of the bucket.
   *
   * Set when the console is offline, or when the read failed and there was a
   * copy to fall back on. It is never allowed to be silent: `message` carries
   * how old the copy is, and the status strip shows it, because a note that
   * reads as current and is four days behind is the console telling somebody
   * their context contains something it does not.
   */
  fromCache?: boolean;
  /**
   * With `fromCache`: shown while the bucket is still asked (`INSTANT_OPEN_MS`),
   * so not yet "Cached copy" — the phone's header flashed it for that moment
   * (owner, 2026-10-16). Cleared when the bucket answers or the read fails.
   */
  checking?: boolean;
}

/**
 * What was found waiting for a note when it was opened.
 *
 * Declared here rather than imported from `features/offline`, so this module
 * stays what it is: a pure state machine with no dependency on where the queue
 * lives or how it is stored. The offline hook builds one of these.
 */
export interface RestoredDraft {
  text: string;
  /**
   * Where this draft got to. `dirty` was typed and never saved; `queued` is
   * waiting for a connection; `conflict` and `error` are waiting for a person.
   */
  status: "dirty" | "queued" | "conflict" | "error";
  message?: string;
  /** On a conflict: the etag that is actually current. */
  conflictEtag?: string;
  /**
   * The etag this text was typed against — the ancestor a merge needs.
   *
   * Distinct from `conflictEtag`, which is the version that superseded it.
   * `undefined` for a restore that is not a conflict.
   */
  baseEtag?: string | null;
}

export const emptyEditor: EditorState = {
  status: "empty",
  path: null,
  baseline: "",
  draft: "",
  etag: null,
  readOnly: false,
  encrypted: false,
  visibility: "private",
  inherited: "private",
  exception: false,
};

/**
 * How long a save may sit in `saving` before the editor says so.
 *
 * The same number and the same reasoning as `REVERIFY_TIMEOUT_MS` in
 * `storage/reverify.ts`: the work is real network I/O against a bucket that may
 * be slow or unreachable, 30s is generous for the happy path, and nobody should
 * be left watching a spinner forever.
 *
 * Here it is not a nicety. `writeNote` is a Convex **action**, and
 * `ConvexReactClient.action()` has no client-side timeout — a connection that
 * drops mid-save leaves that promise pending for good. In that state Save is
 * disabled (`saveButton`), `NoteEditor` renders Discard only for `dirty` and
 * `error` so it is absent, and `guardLeaving` refuses to open another note:
 * **there is no control left on the screen.** The only way out was a reload,
 * which throws the draft away.
 */
export const SAVE_TIMEOUT_MS = 30_000;

export type EditorAction =
  | {
      type: "opened";
      note: OpenNote;
      /** The body came off the device rather than out of the bucket. */
      fromCache?: boolean;
      /** …while the bucket is still being asked (`EditorState.checking`). */
      checking?: boolean;
      /** How old that copy is, or anything else the open should say. */
      notice?: string;
      /** Work found waiting for this note in the offline queue. */
      restored?: RestoredDraft;
      /**
       * The note is not in the bucket: it was created on this device and its
       * create is still queued. Its etag is `null` — "did not exist" — which is
       * what makes every save of it a *create* (`writeNote` with no
       * `expectedEtag`), refused if a note appeared at that path meanwhile.
       * Inventing an etag here instead would make that save a conditional
       * update of a version the bucket never had.
       */
      unsent?: boolean;
    }
  | { type: "closed" }
  | { type: "renamed"; from: string; to: string }
  | { type: "edited"; text: string }
  | {
      type: "collaboration";
      text: string;
      etag: string | null;
      status: "offline" | "storing" | "local" | "syncing" | "saved" | "error" | "unavailable" | "revoked";
    pending: number;
    recovery?: { baseline: string; desired: string; baseEtag?: string | null };
    legacyAdopted?: { path: string; text: string; baseEtag: string };
    }
  | { type: "saveStarted" }
  /** No connection, so the draft went into the queue instead of the bucket. */
  | { type: "saveQueued"; message: string }
  /** The queue drained this note's write to the bucket. */
  | { type: "queueSettled"; etag: string }
  /** A just-created note was reread and now carries the canonical CRDT generation. */
  | { type: "queueCanonicalized"; etag: string; text?: string; baseEtag?: string }
  /** `text`: what was written; absent, the draft as it stands. */
  | { type: "saveSucceeded"; etag: string; conflictCheck: ConflictCheck; text?: string }
  | { type: "saveFailed"; error: FileError }
  /** `SAVE_TIMEOUT_MS` elapsed with the save still outstanding. */
  | { type: "saveTimedOut" }
  /** The person chose "use theirs" after a conflict. */
  | { type: "reloaded"; note: OpenNote }
  /** The bucket answered (or could not) for a copy shown early; the copy is now plainly a copy. */
  | { type: "checked"; path: string }
  /** The person chose "keep mine" — rebase the draft onto the current etag. */
  | { type: "conflictOverridden" }
  /**
   * The person answered the conflict: this text, over the version they saw.
   *
   * Both fields move together and that is the point — the text is what they
   * approved (the draft as it stood, or a merge they read and edited) and the
   * etag is the version the review actually read the bucket at. Moving the
   * text without the etag would write a merge of *their* version against an
   * etag from before it, which is refused; moving the etag without the text
   * would write the version being replaced. The save that follows is still an
   * ordinary conditional write.
   */
  | { type: "resolving"; text: string; etag: string | null }
  /** A refused drawing save, merged by element into the bucket's version at `etag`. */
  | { type: "drawingMerged"; path: string; text: string; etag: string }
  /**
   * A queued rename of this note reached the bucket. The note is now at its
   * new name at `etag`, which is the version the next save must be checked
   * against — and only if the editor was still on the version the rename
   * carried (`from`): an editor that has since moved on keeps its own.
   */
  | { type: "rebased"; from: string | null; etag: string }
  /**
   * A tool wrote this note while somebody had it open, and the shared document
   * has already been merged onto what it wrote.
   *
   * Only the etag moves. The draft is deliberately left alone: it is the
   * merged text, which is what the next save should write, and it is not the
   * bucket's version, so the baseline does not move with it either — a note
   * that still differs from the bucket is still unsaved, and saying otherwise
   * would leave the merge sitting in a browser with nothing to flush it.
   *
   * Unguarded on the previous version, unlike `rebased`: the write happened
   * somewhere else and this client has no claim about which version it
   * replaced — only that the bucket is now at this one and the shared document
   * has been reconciled with it. Applied only on the note it names.
   */
  | { type: "externalWrite"; path: string; etag: string }
  | { type: "discarded" };

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "opened": {
      const opened: EditorState = {
        status: "clean",
        path: action.note.path,
        baseline: action.note.text,
        draft: action.note.text,
        etag: action.unsent === true ? null : action.note.etag,
        readOnly: action.note.readOnly,
        encrypted: action.note.encrypted === true,
        // Carried from the OpenNote, same as the other construction below —
        // the Properties panel reads the manifest's answer from here.
        visibility: action.note.visibility,
        inherited: action.note.inherited,
        exception: action.note.exception,
        fromCache: action.fromCache === true ? true : undefined,
        ...(action.fromCache === true && action.checking === true ? { checking: true } : {}),
        message: action.notice,
      };
      if (action.restored === undefined) return opened;
      /*
        There was work waiting for this note. The queue's text wins over the
        bucket's — it is what the person typed and has not got back yet — while
        `baseline` stays the bucket's, so "unchanged" keeps meaning "the same as
        what is stored" and the dirty marker keeps telling the truth.
      */
      return {
        ...opened,
        status: action.restored.status,
        draft: action.restored.text,
        message: action.restored.message ?? action.notice,
        conflictEtag: action.restored.conflictEtag,
        draftBase: action.restored.baseEtag,
      };
    }

    case "reloaded":
      return {
        status: "clean",
        path: action.note.path,
        baseline: action.note.text,
        draft: action.note.text,
        etag: action.note.etag,
        readOnly: action.note.readOnly,
        encrypted: action.note.encrypted === true,
        visibility: action.note.visibility,
        inherited: action.note.inherited,
        exception: action.note.exception,
      };

    case "checked":
      if (state.path !== action.path || state.checking !== true) return state;
      return { ...state, checking: undefined };

    case "renamed":
      return state.path === action.from ? { ...state, path: action.to } : state;

    case "closed":
      return emptyEditor;

    case "rebased":
      if (state.path === null || state.etag !== action.from) return state;
      return { ...state, etag: action.etag };

    case "externalWrite":
      // A conflict is a decision the person has been asked for, and a merge
      // that arrived behind it does not answer that question — moving the etag
      // under an open conflict would let "keep mine" quietly win a race it was
      // never shown.
      if (state.path !== action.path || state.status === "conflict") return state;
      return { ...state, etag: action.etag };

    case "edited": {
      if (state.readOnly || state.path === null) return state;
      // A conflict is not cleared by typing. The draft is still based on an
      // etag somebody else has moved past, and pretending otherwise would let
      // the next save silently overwrite them.
      //
      // `queued` is not cleared by typing either, and for the opposite reason:
      // the queue holds the newest text (`enqueue` supersedes), so the draft is
      // still written down and calling it "unsaved" would send somebody looking
      // for a Save button that has nothing left to do.
      const status =
        state.status === "conflict"
          ? "conflict"
          : state.status === "queued"
            ? "queued"
            : action.text === state.baseline
              ? "clean"
              : "dirty";
      return { ...state, draft: action.text, status, message: undefined };
    }

    case "collaboration":
      if (state.path === null || state.readOnly) return state;
      return {
        ...state,
        draft: action.text,
        ...(action.etag?.startsWith("c2.") ? { collaborationEtag: action.etag } : {}),
        ...(action.status === "saved" && action.pending === 0
          ? {
              baseline: action.text,
              etag: action.etag,
              status: "saved" as const,
              fromCache: undefined,
              message: undefined,
            }
          : {}),
      };

    case "saveQueued":
      return {
        ...state,
        status: "queued",
        message: action.message,
        conflictEtag: undefined,
        draftBase: undefined,
      };

    case "queueSettled":
      /*
        A queued write reached the bucket while this note was open. The draft
        is now what the server holds, so the baseline moves to it and the etag
        moves to the one the write produced — without which the person's next
        Save is a conditional write against a version their own drain has just
        superseded, and conflicts them with themselves.
      */
      if (state.status !== "queued") return state;
      return {
        ...state,
        status: "saved",
        baseline: state.draft,
        etag: action.etag,
        fromCache: undefined,
        conflictEtag: undefined,
        draftBase: undefined,
        message: "Saved. That was waiting for a connection.",
      };

    case "queueCanonicalized":
      // The create ACK can be a legacy raw etag. A canonical reread upgrades
      // only the generation marker. Newer queued typing keeps its draft and
      // raw ancestor; a clean settled create may adopt peer content returned
      // by this reread as its new baseline.
      {
        const clean =
          action.text !== undefined &&
          action.baseEtag !== undefined &&
          state.status === "saved" &&
          state.draft === state.baseline;
        return {
          ...state,
          ...(clean ? { draft: action.text, baseline: action.text } : {}),
          ...(clean || action.baseEtag === undefined ? {} : { draftBase: action.baseEtag }),
          etag: action.etag,
        };
      }

    case "saveStarted":
      return { ...state, status: "saving", message: undefined };

    case "saveSucceeded": {
      // What was written is what the server holds. A stroke or keystroke made
      // while the write was out stays dirty for its own autosave, rather than
      // being marked saved without reaching the bucket.
      const written = action.text ?? state.draft;
      const behind = written !== state.draft;
      return {
        ...state,
        status: behind ? "dirty" : "saved",
        baseline: written,
        etag: action.etag,
        conflictCheck: action.conflictCheck,
        conflictEtag: undefined,
        draftBase: undefined,
        message: behind
          ? undefined
          : action.conflictCheck === "read-compare"
            ? "Saved. This bucket does not enforce conditional writes, so conflict detection is best-effort."
            : "Saved.",
      };
    }

    case "saveFailed":
      if (action.error.code === "CONFLICT") {
        return {
          ...state,
          status: "conflict",
          // The draft is deliberately untouched. Losing what somebody just
          // typed because somebody else saved first is the worst outcome
          // available here.
          conflictEtag: action.error.currentEtag,
          /*
            The etag this save was made against is the ancestor of both sides:
            it is what the draft was typed on top of, and it is what the bucket
            held until somebody else replaced it. Captured here because this is
            the last moment anything knows it — `etag` moves on the next
            reload, and the cache is keyed by it.
          */
          draftBase: state.etag,
          message: action.error.message,
        };
      }
      return { ...state, status: "error", message: action.error.message };

    case "saveTimedOut":
      // Only a save that is still running times out. A response that landed
      // first wins, and a note that has since been closed or reopened must not
      // be dragged back into an error by a timer belonging to the old one.
      if (state.status !== "saving") return state;
      // `error` rather than a status of its own, because the two states want
      // exactly the same controls: Save re-enabled to try again, and Discard
      // rendered so the draft can be let go deliberately rather than lost to a
      // reload. See `saveButton` and `NoteEditor`.
      //
      // The wording says what is actually known. The write may well have landed
      // — we stopped waiting, we did not cancel it — and claiming it failed
      // would be a lie in one of the two directions. If it did land, the next
      // Save is a conditional write against an etag that has moved, which comes
      // back as a conflict, keeps the draft, and offers the choice. Safe in
      // both branches.
      return {
        ...state,
        status: "error",
        message:
          "Still waiting on your bucket, so we stopped waiting. We don't know whether that save landed. Your draft is right here — save again, or discard it.",
      };

    case "conflictOverridden":
      // Move onto the etag that is actually current. The next save is then an
      // ordinary conditional write against the version they chose to replace —
      // still conflict-checked, just against a version they have been shown.
      return {
        ...state,
        status: "dirty",
        etag: state.conflictEtag ?? state.etag,
        conflictEtag: undefined,
        draftBase: undefined,
        message: undefined,
      };

    case "resolving":
      if (state.status !== "conflict") return state;
      return {
        ...state,
        draft: action.text,
        etag: action.etag,
        conflictEtag: undefined,
        message: undefined,
      };

    case "drawingMerged":
      if (state.path !== action.path || state.readOnly || state.status === "conflict") return state;
      return { ...state, draft: action.text, etag: action.etag, status: "dirty", message: undefined };

    case "discarded":
      return {
        ...state,
        status: "clean",
        draft: state.baseline,
        conflictEtag: undefined,
        draftBase: undefined,
        message: undefined,
      };
  }
}

export { autosaves, guardLeaving, isDirty, needsDecision, saveButton } from "./editorPolicy";
