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
 *    There is no automatic resolution and no silent clobber in any direction.
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
      /** How old that copy is, or anything else the open should say. */
      notice?: string;
      /** Work found waiting for this note in the offline queue. */
      restored?: RestoredDraft;
    }
  | { type: "closed" }
  | { type: "edited"; text: string }
  | { type: "saveStarted" }
  /** No connection, so the draft went into the queue instead of the bucket. */
  | { type: "saveQueued"; message: string }
  /** The queue drained this note's write to the bucket. */
  | { type: "queueSettled"; etag: string }
  | { type: "saveSucceeded"; etag: string; conflictCheck: ConflictCheck }
  | { type: "saveFailed"; error: FileError }
  /** `SAVE_TIMEOUT_MS` elapsed with the save still outstanding. */
  | { type: "saveTimedOut" }
  /** The person chose "use theirs" after a conflict. */
  | { type: "reloaded"; note: OpenNote }
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
  | { type: "discarded" };

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "opened": {
      const opened: EditorState = {
        status: "clean",
        path: action.note.path,
        baseline: action.note.text,
        draft: action.note.text,
        etag: action.note.etag,
        readOnly: action.note.readOnly,
        // Carried from the OpenNote, same as the other construction below —
        // the Properties panel reads the manifest's answer from here.
        visibility: action.note.visibility,
        inherited: action.note.inherited,
        exception: action.note.exception,
        fromCache: action.fromCache === true ? true : undefined,
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
        visibility: action.note.visibility,
        inherited: action.note.inherited,
        exception: action.note.exception,
      };

    case "closed":
      return emptyEditor;

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

    case "saveStarted":
      return { ...state, status: "saving", message: undefined };

    case "saveSucceeded":
      return {
        ...state,
        status: "saved",
        // The draft is now what the server holds, so "unchanged" means this.
        baseline: state.draft,
        etag: action.etag,
        conflictCheck: action.conflictCheck,
        conflictEtag: undefined,
        draftBase: undefined,
        message:
          action.conflictCheck === "read-compare"
            ? "Saved. This bucket does not enforce conditional writes, so conflict detection is best-effort."
            : "Saved.",
      };

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

/** Unsaved work exists. */
export function isDirty(state: EditorState): boolean {
  return state.path !== null && !state.readOnly && state.draft !== state.baseline;
}

/**
 * May this draft be written to the bucket without anybody asking for it?
 *
 * The whole policy of autosave, in one pure function, checked **when the timer
 * fires** and not only when it was armed — the state can have moved in between,
 * and every "no" below is a state where writing would be wrong rather than
 * merely unnecessary:
 *
 *  - `conflict` — **never.** The draft is based on an etag somebody else has
 *    moved past. Writing it would either loop against a refusal every two
 *    seconds or, on a bucket doing read-compare rather than a conditional
 *    write, land as a silent clobber of a version nobody has been shown. The
 *    three answers in `ConflictResolver` stay the only way out.
 *  - `queued` — nothing to add. The offline queue already holds the newest text
 *    (`queueSave` supersedes) and drains itself when the connection comes back.
 *  - `error` — no automatic retry off the same draft. A save that failed for a
 *    reason nobody has read gets one attempt, not one every two seconds. It
 *    re-arms by itself the moment somebody types, because `edited` moves
 *    `error` back to `dirty` — which is what every editor does, and is why
 *    there is no retry loop here.
 *  - `saving` — a write is already in flight for this text.
 *  - `clean`, `saved`, `empty`, and any read-only note — nothing to write.
 */
export function autosaves(state: EditorState): boolean {
  return state.status === "dirty" && isDirty(state);
}

/**
 * Leaving now would leave work behind that nothing writes on its own.
 *
 * The two states autosave refuses, and the reason a prompt still exists at all:
 * a conflict and a failed save are both waiting on a person, so they are the
 * only places where "you have unsaved changes" is news rather than nagging.
 *
 * The draft itself survives either way — `setDraft` writes every keystroke into
 * `features/offline` and `restoreFor` puts it back when the note is reopened —
 * so this is about somebody walking away believing their bucket has something
 * it does not, which is the one claim this product cannot get wrong.
 */
export function needsDecision(state: EditorState): boolean {
  if (!isDirty(state)) return false;
  return state.status === "conflict" || state.status === "error";
}

/**
 * May the person navigate away, and if not, what should they be asked?
 *
 * Returned rather than thrown so the caller decides between a dialog and a
 * quiet refusal — and so the wording is pinned by a test instead of living
 * inside a component nobody renders in CI.
 *
 * **This used to refuse for every unsaved draft, and autosave is what retired
 * that.** The refusal existed because clicking another note would have thrown
 * the draft away; now the caller flushes the pending write on the way out
 * (`select` in `useFileBrowser`), the write is the same conditional write Save
 * makes, and the text is on the device besides. Refusing anyway would be the
 * console asking to be looked after in the one place it no longer needs to be.
 *
 * What it still refuses is `needsDecision`: a conflict, and a save that failed.
 * Autosave will not write either, so leaving really does leave something
 * undone, and the sentence says which one rather than telling somebody to press
 * a Save that cannot help them.
 */
export function guardLeaving(state: EditorState): { allowed: boolean; prompt?: string } {
  if (!isDirty(state)) return { allowed: true };
  /*
    A queued draft is not unsaved work being carried in a component that is
    about to be replaced — it is written down in the offline queue, which
    survives opening another note and, on a durable store, the app closing. The
    guard exists to stop a draft being lost to navigation, and this one cannot
    be. Refusing anyway would strand somebody on a train: no connection, no way
    to save, and the console will not let them open anything else.

    It is still `isDirty`, because it still differs from what is in the bucket
    and the tab's dot should say so.
  */
  if (state.status === "queued") return { allowed: true };
  if (!needsDecision(state)) return { allowed: true };
  return {
    allowed: false,
    prompt:
      state.status === "conflict"
        ? `${state.path} was written by somebody else while you had it open. Choose which version to keep before opening something else.`
        : `${state.path} could not be saved to your bucket. Try again, or discard it, before opening something else.`,
  };
}

/**
 * What the save button should say and whether it should be pressable.
 *
 * **The resting label is a fact, not an instruction.** With autosave on, a note
 * that matches the bucket has nothing owed to anybody, and a dim "Save" sitting
 * over it read as a chore somebody had not got round to. It says "Saved".
 *
 * The button does not disappear, and the two states it is pressable in are why:
 * a save that failed and a conflict are exactly the cases autosave refuses
 * (`autosaves`), so the manual route has to stay reachable. ⌘S keeps working in
 * `dirty` too — every editor lets somebody save now rather than in two seconds
 * — and pressing it is the same conditional write autosave would have made.
 */
export function saveButton(state: EditorState): { label: string; disabled: boolean } {
  if (state.readOnly) return { label: "Read-only", disabled: true };
  switch (state.status) {
    case "saving":
      return { label: "Saving…", disabled: true };
    case "queued":
      // Nothing for a press to do: the queue holds the newest text and drains
      // itself the moment the connection comes back. A pressable Save here
      // would be a button whose only possible effect is to queue what is
      // already queued.
      return { label: "Queued", disabled: true };
    case "conflict":
      return { label: "Overwrite theirs", disabled: false };
    case "dirty":
    case "error":
      return { label: "Save", disabled: false };
    case "clean":
    case "saved":
      /*
        "Saved" is a durability claim, so it is not made for a body that came
        off the device. `fromCache` means nothing has asked the bucket about
        this note since it was read, and a button saying otherwise would be the
        console telling somebody their context contains something it does not
        — the same rule `status.ts` and `NoteEditor`'s durability line follow.
      */
      return { label: state.fromCache === true ? "Save" : "Saved", disabled: true };
    default:
      // `empty`: nothing is open, so there is no note for either word to be
      // about. The pane draws no button here.
      return { label: "Save", disabled: true };
  }
}
