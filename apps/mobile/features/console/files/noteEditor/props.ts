import type { ReactNode } from "react";
import type { Presence } from "../../presence/usePresence";
import type { DrawingCollaboration } from "../drawingCollaboration";
import type { EditorState } from "../editor";
import type { ActivityView } from "../../activity/activity";
import type { NoteLinkOpen } from "../noteLinks";
import type { NoteEncryptionController } from "../../encryption/useNoteEncryption";
import type {
  FormOutcome,
  FormResponsesOutcome,
  FormResponseRetract,
  FormResponseUpdate,
  FormSubmission,
  FormVote,
} from "../formBlock";
import type { Visibility } from "../types";
import type { FolderListSource } from "../listBlock/model";

/** What a surface mounts `NoteEditor` with. */
export interface NoteEditorProps {
  /**
   * Who else has this note open, and where this editor's caret goes.
   *
   * Absent wherever there is nobody to ask — the demo console, a surface with
   * no grant — and nothing about the editor changes when it is: no chip, no
   * carets, and the same save path either way. Presence is an overlay on the
   * single-writer editor, never a second route to the bucket.
   */
  presence?: Presence;
  /** The live room behind an open canvas, when there is one. */
  drawingCollaboration?: DrawingCollaboration;
  state: EditorState;
  canEdit: boolean;
  /**
   * The note is being read rather than edited.
   *
   * Defaults to `false` so a caller that has never heard of reading mode — the
   * tests that mount a note, and any future embedder — gets exactly the
   * behaviour it had. The route is the only thing that turns it on.
   */
  reading?: boolean;
  /**
   * Send one filled-in ```form block on this note.
   *
   * Optional, and absent means the drawn form says it cannot send rather than
   * not being drawn: a reader should still see what the form asks even on a
   * surface that cannot answer it.
   *
   * It is **not** gated on `canEdit`, which is the whole point of the feature.
   * A workspace `member` has `canEdit: false` and a read-only editor, and is
   * exactly the person a form exists to collect from — see
   * `docs/decisions/forms.md`, "A `member` may submit, and that is the only
   * write they get".
   */
  /** Plugin completions, absent where no plugin can run. See `LiveEditorProps`. */
  onSuggest?: (line: string, ch: number) => Promise<{ text: string }[]>;
  onPickSuggestion?: (index: number) => Promise<string | null>;
  /** Ask the running plugins to preview this note's external links. */
  onPreviewLinks?: (links: { href: string; text: string }[]) =>
    Promise<{ href: string; text: string }[]>;
  onSubmitForm?: (submission: FormSubmission) => Promise<FormOutcome>;
  /** Read a form's response note through the same access check as opening it. */
  onReadFormResponses?: (responsesPath: string) => Promise<FormResponsesOutcome>;
  /** Add or remove the signed-in person's vote on one response. */
  onVoteForm?: (vote: FormVote) => Promise<FormOutcome>;
  onUpdateFormResponse?: (change: FormResponseUpdate) => Promise<FormOutcome>;
  onRetractFormResponse?: (change: FormResponseRetract) => Promise<FormOutcome>;
  /** The bytes behind an image this note embeds. See `LiveEditorProps`. */
  onLoadImage?: (target: string) => Promise<string | null>;
  /** Store a pasted image and answer with the key to embed. */
  onStoreImage?: (image: {
    bytes: ArrayBuffer;
    contentType: string;
  }) => Promise<{ target: string } | { error: string }>;
  /** Say a refused paste out loud. */
  onImageProblem?: (message: string) => void;
  /** Where a folder list block reads its notes. Absent: lists stay as source. */
  folderLists?: FolderListSource;
  /**
   * Who can read this note, as the access map answers it — a Properties row.
   *
   * `visibility:` is filing metadata about a note, which is exactly what the
   * Properties panel is for, and it is where the breadcrumb's chip went when
   * the breadcrumb went. The value comes from the *manifest* rather than from
   * the file's own frontmatter, because a `visibility:` line inside a note
   * decides nothing — `privacy.md` does, which is what `ManifestNotice` says in
   * so many words. So a note carrying its own `visibility:` has that row
   * replaced by this one rather than showing two answers to one question.
   *
   * Optional, and absent everywhere but the console's Browse pane: a
   * `NoteEditor` mounted without an entry beside it has no honest answer, and
   * inventing "private" would be a claim about access made by a component that
   * was not told.
   */
  visibility?: {
    visibility: Visibility;
    inherited: Visibility;
    exception: boolean;
    readOnly: boolean;
  };
  /**
   * What the pane has to say about this note, inside the note's own scroller.
   *
   * A prop rather than a sibling above this component, because on a phone that
   * scroller is the screen: a notice rendered outside it would be a band pinned
   * across the top of the glass under chrome that is already floating there,
   * and the note would start below it instead of running behind it. Passed as a
   * node because what the notices *say* is the pane's business — a bucket that
   * is not connected, a privacy manifest that will not parse — and none of it
   * is the editor's.
   */
  notices?: ReactNode;
  /**
   * Follow a link to another note.
   *
   * Absent where there is nowhere to go — the landing page's demo console — and
   * the editor then draws links as plain text rather than as a control that
   * does nothing. See `noteLinks.ts`.
   *
   * `mode` is the gesture's, not the destination's: `"background"` is a
   * ⌘-click, and the caller must open the note without moving the person off
   * this one.
   *
   * **The long-press confirmation this component used to own is gone.** It sat
   * in front of an ambiguous gesture — a press is also how a selection starts —
   * and the gesture is a tap now, which is not ambiguous. Nothing is at risk
   * from a tap that was not at risk from a click.
   */
  onOpenLink?: (path: string, mode: NoteLinkOpen) => void;
  /** Paths the console knows of, for bare `[[name]]` links. Usually partial. */
  notePaths?: readonly string[];
  /**
   * The phone's path bar, above the notices and above the inline title.
   *
   * Passed in for the reason `notices` is: a note on a phone brings its own
   * scroller, because `NoteAccessory` anchors to the *region* and would ride
   * away with the content inside one. Anything that must scroll with the
   * document therefore has to be handed to this component rather than drawn
   * around it — otherwise it is a band pinned above the note, which is what a
   * phone breadcrumb was deleted for being.
   *
   * `BrowsePane` builds it; what it says is the pane's business, and this only
   * decides where it sits.
   */
  pathBar?: ReactNode;
  onChange: (text: string) => void;
  onSave: () => void;
  onDiscard: () => void;
  onUseTheirs: () => void;
  onKeepMine: () => void;
  /**
   * What renders a note locked behind a passphrase, and what it writes back
   * to. Absent wherever there is nowhere to route a write — the landing
   * page's read-only demo — in which case a passphrase note falls back to
   * the plain `EncryptedNotice` treatment every other encrypted note gets:
   * the envelope shown as read-only text, same as this console has always
   * shown one.
   */
  encryption?: {
    controller: NoteEncryptionController;
    /** Told the new etag after every write this view makes. */
    onWritten?: (etag: string) => void;
  };
  /**
   * The activity list, for the one note that is drawn as one.
   *
   * Absent on a console that has none — the demo, or a context whose read was
   * refused — and `activity.md` then opens in the editor as the Markdown file
   * it is, which is a worse screen and a true one.
   */
  activity?: ActivityView;
  /** Whether anybody else is in this context. Changes the empty state only. */
  activityShared?: boolean;
  /**
   * Whether the pencil reaches `activity.md`'s source — `canEditActivity`.
   *
   * Defaults to `false`, so a surface that has never heard of this gets the
   * list and no way past it, which is the safe direction: the server refuses
   * the write regardless, and an unoffered control costs a press where an
   * offered-and-refused one costs trust.
   */
  activityEditable?: boolean;
  /** Open another note, from a row in that list. */
  onOpenNote?: (path: string) => void;
}
