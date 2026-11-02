/**
 * What the editor's state says about saving: whether there is unsaved work,
 * whether autosave may write it, whether leaving should ask, and what the Save
 * button reads. Pure functions over `EditorState`, kept beside the reducer in
 * `editor.ts` (which re-exports them) and apart from it so neither grows past
 * the size a reviewer can hold.
 */

import type { EditorState } from "./editor";

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
 * The two states it is pressable in are why it exists at all: a save that
 * failed and a conflict are exactly the cases autosave refuses (`autosaves`),
 * so the manual route has to stay reachable. ⌘S keeps working in `dirty` too —
 * every editor lets somebody save now rather than in two seconds — and pressing
 * it is the same conditional write autosave would have made.
 *
 * **This used to end "the button does not disappear", and it does now.** That
 * sentence was written about the *label*, and it was right about the label: a
 * dim "Save" over a note with nothing owed is a chore somebody had not got
 * round to, so the resting word became "Saved". What it was wrong about is the
 * control. `NoteEditor` draws this only where `disabled` is false, because a
 * pill that cannot be pressed is not a control, it is status — and it was
 * status printed a second time, in a second visual language, at the far end of
 * the row from the sentence that had already said it. The disabled arms are
 * still computed and still returned: this function answers what the button
 * *would* say, `autosave.test.ts` checks every arm of it, and the two arms that
 * can be pressed are the ones that reach the screen. See `NoteEditor`'s status
 * row and `docs/decisions/app-and-console.md`.
 */
export function saveButton(state: EditorState): { label: string; disabled: boolean } {
  // Before the `readOnly` arm, because both are true for an encrypted note and
  // this is the one that says something. "Read-only" describes a file this
  // console generates; an encrypted note is a file it cannot open.
  if (state.encrypted) return { label: "Encrypted", disabled: true };
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
