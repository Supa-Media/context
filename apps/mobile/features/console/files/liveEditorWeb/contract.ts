/**
 * What the web editor promises its host: the imperative handle a button uses
 * and the props a surface mounts it with.
 *
 * Declared here and re-exported from `LiveEditor.web.tsx`, which is where
 * `LiveEditor.tsx` (the iOS half) and every caller import them from, so the
 * native half satisfies the same contract without CodeMirror entering its
 * module graph. Types only.
 */

import type { SharedDoc } from "../../presence/sharedDoc";
import type { PresenceMember } from "../../presence/protocol";
import type { DurableCollaboration } from "../../collaboration/durable";
import type { NoteLinkOpen } from "../noteLinks";
import type { FolderListSource } from "../listBlock/model";
import type {
  FormOutcome,
  FormResponsesOutcome,
  FormResponseRetract,
  FormResponseUpdate,
  FormSubmission,
  FormVote,
} from "../formBlock";

/**
 * The handful of things a *button* can ask the editor to do.
 *
 * On a phone there is no keymap and no menu: `NoteAccessory` is the only route
 * to bold, to a heading, to undo. That bar cannot reach into either editor —
 * one is a CodeMirror view in this process, the other is a CodeMirror view
 * inside a `WebView` — so this is the seam between them, declared once here and
 * satisfied twice.
 *
 * **What it is not is a second implementation of markdown editing.** Both
 * halves turn each of these into the *same* `runCommand` from `editorSetup.ts`,
 * against a real `EditorView`, in exactly the way `editability` and the keymap
 * are shared. The iOS half's methods are five lines of `bridge.run({ name })`;
 * the commands themselves are written once.
 *
 * Every method's effect on the file goes out through the ordinary `onChange`,
 * which is what keeps the accessory bar honest: `NoteEditor` re-attaches a
 * note's frontmatter in front of every edit on a phone, so a command that
 * wrote to the buffer by some other route would silently drop the YAML block
 * of every captured note. `noteAccessory.test.ts` pins exactly that.
 */
export interface EditorControls {
  /** Wrap the selection, or insert the pair at the caret with it between them. */
  wrap(before: string, after: string): void;
  /** Put `prefix` at the start of the caret's line, or remove it if already there. */
  toggleLinePrefix(prefix: string): void;
  /** `[[]]`, caret between the brackets, with the `[[` completion opened. A2. */
  insertLink(): void;
  undo(): void;
  redo(): void;
  blur(): void;
  /**
   * Put the find bar away, and say whether there was one.
   *
   * **Web only, and optional for that reason** — ⌘F and its bar ship to the
   * browser alone (`findInNote.ts` says why), so the native half simply does
   * not answer this and a caller reads `closeFind?.() ?? false`.
   *
   * It exists because the press it answers never reached this editor:
   * `searchKeymap`'s Escape is scoped to the editor and the panel, so a person
   * whose focus had moved to a tree row or a tab had no key that closed the
   * bar. `NoteEditor` registers this with the frame's overlay stack, which is
   * what `keymap.ts`'s "Escape closes whatever is open, wherever you are" means
   * for a panel the frame does not render.
   */
  closeFind?(): boolean;
  /** A settled phrase, at the caret. See `dictate.ts`. */
  dictate(text: string): void;
  /**
   * Draw the guess a speech engine has not settled on yet. `""` clears it.
   *
   * **Web only, and optional for the same reason `closeFind` is**: it is not a
   * document change, so it has no verb in the bridge's protocol and nothing on
   * the other side to run one — and the phone has no dictation engine to
   * produce a guess in the first place (`features/voice/engine.ts` says why).
   * A caller reads `showInterim?.(text)`.
   */
  showInterim?(text: string): void;
  /**
   * Take back everything the current dictation run inserted, and say whether
   * it did. Web only, as above. `false` means the run had been hand-edited and
   * was left alone, which the caller has to tell somebody rather than swallow.
   */
  discardDictation?(): boolean;
}

export interface LiveEditorProps {
  /**
   * Speak into the note at the caret, from the right-click menu.
   *
   * Absent where there is no microphone to open — the landing page's preview,
   * the fixtures — and `editorMenuItems` then draws no row rather than a row
   * that does nothing. The editor hands back the caret it was clicked at, so
   * the words land where the menu was opened rather than where the selection
   * happened to be.
   */
  onDictate?: (at: number) => void;
  /**
   * Ask the agent about this note, from the same menu.
   *
   * Absent where there is no right panel for an answer to land in — which is
   * every compact layout, whatever the microphone says, and is why this is a
   * second prop rather than a second use of the first.
   */
  onAsk?: () => void;
  /** The authoritative text. Written into the editor only when it differs. */
  value: string;
  editable: boolean;
  onChange: (text: string) => void;
  /** Native WebView edits include the document version they were based on. */
  onVersionedChange?: (text: string, baseSnapshot: string) => string | void;
  /** Exact shared-document snapshot rendered into a native editor. */
  documentRevision?: string;
  /** Save. Wired to Cmd/Ctrl-S, because that is what people press. */
  onSave: () => void;
  accessibilityLabel: string;
  /**
   * Receives the imperative handle when the editor is ready, and **`null` when
   * it goes away**.
   *
   * The null is not politeness. The accessory bar outlives a note change on a
   * phone — the same bar, a different document — and a handle held past unmount
   * points at a destroyed `EditorView`, where CodeMirror's own `dispatch`
   * throws rather than no-ops. Handing `null` back makes the stale case a
   * control that does nothing rather than a crash on a keystroke.
   */
  controls?: (api: EditorControls | null) => void;
  /**
   * The editing surface took or lost the caret.
   *
   * `NoteEditor` shows the accessory bar from this, because the bar exists to
   * ride above the keyboard and the keyboard is up exactly while this surface
   * is focused. Not derived from the keyboard's own visibility: the keyboard
   * can be up over a different screen entirely.
   *
   * Both surfaces answer it, and neither of them does so with a `TextInput`'s
   * `onFocus` any more — this half listens to CodeMirror's own DOM events, and
   * the iOS half receives the guest's over the bridge. The prop is the same
   * shape on purpose, so `NoteEditor` never learns which one it has.
   */
  onFocus?: () => void;
  onBlur?: () => void;
  /**
   * Who else has this note open, and where to send this editor's own caret.
   *
   * Absent on every surface with no room behind it — the landing page's demo
   * console, a note opened offline, a locked one — and the extension is then
   * still installed but never told about anybody, so it draws nothing. An
   * absent capability is reported, never faked, and here reporting it is
   * drawing exactly the editor that existed before presence did.
   */
  presence?: {
    members: PresenceMember[];
    report: (anchor: number, head: number) => void;
    /** The document this room shares, once it has one. */
    shared: SharedDoc | null;
    /**
     * Whether the room has told this client everything it holds for this note.
     *
     * The editor needs it because an empty shared document is ambiguous: a
     * brand-new note and a room that has not replied yet look the same from
     * the document alone. See `usePresence`, and the binding effect below.
     */
    settled?: boolean;
    /** Whether this client is the one that writes to the bucket. */
    canWrite: boolean;
    collaboration?: DurableCollaboration;
  };
  /**
   * Scroll the surface this editor is laid out inside, by `delta` points.
   *
   * **Only the iOS half calls this, and only where the editor does not scroll
   * itself.** At compact the web view is given its document's full height so the
   * note has exactly one scroller — see `LiveEditor.tsx`'s `height` — and the
   * price of that is that CodeMirror can no longer scroll the caret out from
   * under the keyboard, because its own scroller has nothing to scroll. The page
   * scroller does it instead, and this is how it is asked.
   *
   * This half never calls it: its editor is a real scroller in a bounded box,
   * and a mobile browser shrinks the layout viewport for the keyboard anyway.
   */
  onScrollBy?: (delta: number) => void;
  /**
   * A link to another note was followed, and how.
   *
   * A click and a tap are `"foreground"` and go to the note; a ⌘-click and a
   * middle-click are `"background"` and must leave the person where they are.
   * ⌥-click never reaches here at all — it belongs to the caret. See
   * `noteLinks.ts`.
   *
   * Absent means links are plain text on this surface, which is what the
   * landing page's demo console wants: it has nowhere to navigate to.
   */
  onOpenNote?: (path: string, mode: NoteLinkOpen) => void;
  /** The note being edited, so a relative link knows what it is relative to. */
  notePath?: string | null;
  /** Paths this surface knows of, for bare `[[name]]` links. Usually partial. */
  notePaths?: readonly string[];
  /**
   * Send one filled-in form block.
   *
   * Absent where this surface cannot — the landing page's demo console has no
   * Convex identity — and the drawn form then says so instead of offering a
   * button that does nothing.
   */
  onSubmitForm?: (submission: FormSubmission) => Promise<FormOutcome>;
  onReadFormResponses?: (responsesPath: string) => Promise<FormResponsesOutcome>;
  onVoteForm?: (vote: FormVote) => Promise<FormOutcome>;
  onUpdateFormResponse?: (change: FormResponseUpdate) => Promise<FormOutcome>;
  onRetractFormResponse?: (change: FormResponseRetract) => Promise<FormOutcome>;
  /**
   * The bytes behind an image this note embeds, as something an `<img>` takes.
   *
   * Absent where this surface has no bucket behind it, and a row then says so
   * rather than drawing an empty frame.
   */
  onLoadImage?: (target: string) => Promise<string | null>;
  /** Store a pasted or dropped image, and answer with the key to embed. */
  onStoreImage?: (image: {
    bytes: ArrayBuffer;
    contentType: string;
  }) => Promise<{ target: string } | { error: string }>;
  /** Say a refused paste out loud — a toast on this surface. */
  onImageProblem?: (message: string) => void;
  /**
   * Where a ```list block reads the notes it chooses from. Absent on a surface
   * with no copy of the workspace, and the block then stays as its source.
   */
  folderLists?: FolderListSource;
  /**
   * Ask the running plugins to complete the line being typed.
   *
   * Absent where no plugin can run — the landing page's demo console — and the
   * completion extension is then not installed at all, rather than installed
   * over a source that always answers nothing. `onPickSuggestion` comes with
   * it; one without the other is a menu that cannot be accepted.
   *
   * **Both halves honour these.** They were accepted and dropped on native for
   * a release: the props were destructured nowhere, so a plugin showing
   * **Running** on a phone, with a grant its owner had approved, offered
   * nothing in any note and said nothing about why — the one shape that neither
   * reports an absent capability nor provides it. The `WebView` guest now holds
   * the same completion source this file installs, asking across the bridge;
   * see the `suggest` messages in `webview/protocol.ts`.
   */
  onSuggest?: (line: string, ch: number) => Promise<{ text: string }[]>;
  onPickSuggestion?: (index: number) => Promise<string | null>;
  /**
   * Ask the running plugins to preview this note's external links.
   *
   * The read half of the same boundary `onSuggest` is the write half of: a
   * plugin's markdown post-processor runs inside the sandbox and reports text
   * per link, and `pluginPreview.ts` draws that in a tooltip of Context's own.
   * Absent where no plugin can run, and the extension is then not installed.
   */
  onPreviewLinks?: (links: { href: string; text: string }[]) =>
    Promise<{ href: string; text: string }[]>;
}

/**
 * The callbacks the web editor reads at call time, through one ref.
 *
 * Every key is present, some holding `undefined`, because the component
 * assigns the whole set on every render; see `handlers` in
 * `liveEditorWeb/LiveEditor.web.tsx`.
 */
export interface EditorHandlers {
  onChange: LiveEditorProps["onChange"];
  onSave: LiveEditorProps["onSave"];
  controls: LiveEditorProps["controls"];
  onFocus: LiveEditorProps["onFocus"];
  onBlur: LiveEditorProps["onBlur"];
  onDictate: LiveEditorProps["onDictate"];
  onAsk: LiveEditorProps["onAsk"];
}

/** Where the pointer was when the menu or the table picker was opened. */
export type MenuPoint = { x: number; y: number };
