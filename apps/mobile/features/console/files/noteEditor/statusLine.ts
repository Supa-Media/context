import type { Presence } from "../../presence/usePresence";
import type { EditorState } from "../editor";

/**
 * What the foot of the note says and offers, derived once per render of
 * `NoteEditor` from values it already holds.
 */
export function noteFoot({
  state,
  presence,
  editable,
  compact,
  button,
}: {
  state: EditorState;
  presence: Presence | undefined;
  editable: boolean;
  compact: boolean;
  button: { label: string; disabled: boolean };
}): { durability: string; canDiscard: boolean; explains: boolean; manualSave: boolean } {
  /*
    The line at the foot of the document, resolved once — and the question of
    whether anything belongs down here at all.

    **`decision` is the whole rule, and it is a reversal.** This row used to
    appear for `dirty`, which is the state every keystroke produces: two
    controls, "Discard changes" and "Save", laid across somebody's own text for
    as long as a draft was unwritten — and unwritten means "for the next two
    seconds", because `autosave.ts` writes it the moment typing stops. Neither
    was needed. ⌘S and the autosave timer make the same conditional write, and
    Discard-in-`dirty` was only ever reachable inside that same two-second
    window (once the write lands the baseline moves and it is gone), which is
    what the editor's own undo is for.

    What is left is the states autosave refuses or cannot finish — a failed
    save, a conflict, a draft the offline queue is holding. `editor.ts` is
    explicit that the manual route has to stay reachable there, and those are
    also the only states with something to *explain*, so the sentence comes
    back at a pointer width with them rather than staying compact-only: the
    words are the error message itself ("we don't know whether that save
    landed"), and a crit chip in the top bar cannot carry a paragraph.

    Every other state says it in the top bar's `SaveChip` — "Saving soon",
    "Saving…", "Saved" — which is a claim you can read without anything
    standing over the note. See `status.ts`'s `saveChip`.
  */
  const collaborationStatus = presence?.collaboration?.status;
  const durability =
    presence?.collaboration?.message ??
    (collaborationStatus === "local"
      ? "Saved on this device; syncing soon."
      : collaborationStatus === "syncing"
        ? "Syncing to your bucket…"
        : collaborationStatus === "saved"
          ? "Saved in your bucket"
          : statusLine(state));
  const decision =
    state.status === "error" || state.status === "conflict" || state.status === "queued";
  /*
    `conflict` is not here, and that is unchanged: its way out is "Overwrite
    theirs" beside the resolver, not a third verb. `queued` is, and that is not
    a nicety — Save is dead in that state (the queue already holds the newest
    text), so without this there is no control on screen that lets somebody
    change their mind about an edit made offline, and the way out would be to
    retype the original and wait for it to sync. Pressing it drops the queued
    write as well as the draft; see `discard` in `useFileBrowser`.
  */
  const canDiscard = editable && (state.status === "error" || state.status === "queued");
  /*
    Where the sentence is drawn: the phone always, and a pointer width only
    where the words *are* the message — `error` and `queued` both print
    `state.message`, which is a paragraph the top bar's chip cannot hold.

    `conflict` is `decision` too and is deliberately not here. Its line is the
    single word "Conflict", and the conflict notice a few lines up has already
    said that at length, with the two buttons for answering it. A pointer
    layout would be printing the word under the paragraph explaining it.
  */
  const explains =
    durability !== "" &&
    (compact || state.status === "error" || state.status === "queued");
  /* The manual write, where autosave will not make it. Never on a phone: Save
     is on the bottom toolbar there (`check`), and this row is not a toolbar. */
  const manualSave = !compact && !button.disabled && decision;
  return { durability, canDiscard, explains, manualSave };
}

/**
 * Where this note actually is, in one sentence — or nothing.
 *
 * **Every arm of this switch is a durability claim, and the default is the
 * strongest one in the product.** "Saved in your bucket" is the promise the
 * whole thing rests on, so a state that reaches it without being in the bucket
 * is not a copy defect, it is the console lying about somebody's writing. Two
 * of the states the offline queue adds are exactly that shape, and both are
 * named here rather than left to fall through:
 *
 *  - `queued` — written down on this device; the bucket has never heard of it.
 *  - `clean` **with `fromCache`** — the body came off this device, and nothing
 *    has asked the bucket about it since.
 *
 * `empty` answers `""` for the same reason and it is not tidiness: an editor
 * with no note in it would otherwise reach the default and claim a file nobody
 * opened is safely stored. The caller draws no line at all for `""`.
 *
 * `__tests__/offlineEditorRender.test.ts` mounts the editor and asserts on the
 * words, because none of this is visible to a pure test — `statusLine` is
 * private and every one of these is a legal `EditorState` either way.
 */
export function statusLine(state: EditorState): string {
  switch (state.status) {
    case "empty":
      return "";
    case "dirty":
      /*
        Not "Unsaved changes". The three lines this switch can print for a
        note being worked on now read as one progression — "Saving soon",
        "Saving…", "Saved in your bucket" — and the first of them is a
        statement about what is about to happen rather than a debt. See
        `status.ts`, which makes the same change to the strip and argues the
        tone.
      */
      return "Saving soon";
    case "saving":
      return "Saving…";
    /*
      `queued` reads its own message rather than falling through to the resting
      line. That line is "Saved in your bucket", which is precisely the claim a
      queued draft cannot make — the text is written down on this device and the
      bucket has never heard of it.
    */
    case "queued":
    case "saved":
    case "error":
      return state.message ?? "";
    case "conflict":
      return "Conflict";
    default:
      // Same reason, for a body that came off the device rather than out of the
      // bucket. `status.ts` carries how old the copy is; this says only where
      // it came from.
      return state.fromCache === true ? "Read from this device" : "Saved in your bucket";
  }
}
