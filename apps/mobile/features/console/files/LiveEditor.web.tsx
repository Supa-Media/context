/**
 * The Live Preview editor, on web.
 *
 * A thin, deliberately boring shell around CodeMirror. Everything interesting
 * about how the document is drawn lives in `livePreview.ts` and everything
 * about how the editor behaves lives in `editorSetup.ts` — both pure, both
 * tested, and `editorSetup.ts` shared verbatim with the iOS half, which runs
 * the same configuration inside a `WebView`. This file exists to solve exactly
 * one hard problem, which is keeping a mutable editor instance and React's idea
 * of the world in agreement without either of them fighting the other.
 *
 * ## The two directions, and why they are not symmetrical
 *
 * **Typing → React** is a subscription: `updateListener` fires, and the text
 * goes out through `onChange` into the existing reducer in `editor.ts`. Nothing
 * about the editor's own state changes as a result, so there is no loop.
 *
 * **React → editor** is the dangerous one, and it happens for exactly three
 * reasons: a different note was opened, the person discarded their draft, or a
 * conflict was resolved by loading somebody else's version. In all three the
 * new text is *authoritative* and the editor must be told. What must not happen
 * is the round trip — editor fires `onChange`, parent re-renders with the same
 * text, effect writes it back — because writing a document into CodeMirror
 * resets the selection, so that loop shows up as the caret jumping to the end
 * of the line on every keystroke.
 *
 * The guard is one comparison: only dispatch when the incoming `value` differs
 * from what the editor already holds. That is why `latestValue` exists rather
 * than a dependency array — a dep array compares against the *previous render's*
 * prop, which is not the same question.
 *
 * ## Why not a controlled component
 *
 * The obvious React shape — value in, onChange out, re-render on every
 * keystroke — is wrong for a text editor whose state includes a selection, an
 * undo history and a parsed syntax tree. CodeMirror owns all three. Treating it
 * as controlled would mean rebuilding them from scratch on every character.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import { pluginSuggestSource, type PluginSuggestRef } from "./pluginSuggest";
import { pluginLinkPreview, pluginPreviewTheme, type PluginPreviewRef } from "./pluginPreview";
import { EditorView } from "@codemirror/view";
import { livePreviewStyles } from "./livePreview";
import { Menu } from "../../design/components/Menu";
import { isApplePlatform } from "../../design/applePlatform";
import { writeClipboard } from "../../design/clipboard";
import { editorMenuItems, LINE_PREFIXES, type EditorMenuId } from "./editorMenu";
import { insertTable, MARKERS, toggleWrap } from "./markdownFormat";
import { TableSizePicker } from "./TableSizePicker.web";
import { drawInterim, takeBackRun } from "./dictate";
import { closeFindPanel, findInNote } from "./findInNote";
import {
  remoteCarets,
  reportSelection,
  setCaretDocument,
  setRemoteCarets,
} from "../presence/remoteCarets";
import { yCollab } from "y-codemirror.next";
import { mayPersist, type SharedDoc } from "../presence/sharedDoc";
import type { PresenceMember } from "../presence/protocol";
import {
  editability,
  editorExtensions,
  openingCaret,
  replaceDocument,
  runCommand,
  type HandlerRef,
} from "./editorSetup";
import type { NoteLinkContext, NoteLinkOpen } from "./noteLinks";
import type {
  FormOutcome,
  FormHostRef,
  FormResponsesOutcome,
  FormResponseRetract,
  FormResponseUpdate,
  FormSubmission,
  FormVote,
} from "./formBlock";
import type { ImageHostRef } from "./imageBlock";
import { fonts, layout } from "../../design/tokens";
import { useColors, type Colors } from "../../design/theme";

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
    /** Whether this client is the one that writes to the bucket. */
    canWrite: boolean;
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
 * The stylesheet, injected once per document rather than per editor.
 *
 * `EditorView.theme` would scope this properly, but the decoration classes are
 * plain strings shared with the pure module and a theme would mean expressing
 * them twice. One `<style>` with a stable id is the smaller lie.
 */
const STYLE_ELEMENT_ID = "context-live-preview-styles";

/**
 * Write the stylesheet, creating the element the first time and rewriting it
 * whenever the palette changes.
 *
 * It used to return early once the element existed, which was right while the
 * app had one palette and is a stale-colour bug now: the first editor to mount
 * would decide the note's colours for the rest of the session, and a change of
 * appearance would leave the surrounding app light and the note dark.
 *
 * One element for the document rather than one per editor, because these are
 * CSS custom properties on a shared class and CodeMirror's own
 * `EditorView.theme` would mean expressing the decoration classes twice. That
 * is only correct while the whole document is in one scheme, which is the case
 * here: the appearance comes from `useColors()`, and every editor on screen
 * reads the same one.
 */
function ensureStyles(colors: Colors): void {
  if (typeof document === "undefined") return;
  let style = document.getElementById(STYLE_ELEMENT_ID) as HTMLStyleElement | null;
  const fresh = style === null;
  if (style === null) {
    style = document.createElement("style");
    style.id = STYLE_ELEMENT_ID;
  }
  style.textContent = `
.cm-lp-root {
  --lp-heading: ${colors.text};
  --lp-muted: ${colors.text2};
  --lp-link: ${colors.codeKey};
  --lp-code-bg: ${colors.well};
  --lp-mono: ${fonts.mono};
  /*
    THIS BLOCK IS THE CONTRACT, AND IT HAS BEEN BROKEN TWICE THE SAME WAY.

    Everything drawn inside the editor — the shared stylesheet appended below,
    the completion list's theme, the link affordance — names its colours as
    --lp-* custom properties rather than as values, because the same rules run
    inside the iOS WebView where the palette arrives over a bridge. The guest
    declares the whole set (webview/host.ts themeVars, webview/styles.ts); this
    half has to declare the same set or those rules are talking to nothing.

    A missing one does not fail loudly. An unknown custom property makes its
    whole declaration invalid at computed-value time, so a colour naming one
    becomes inherit rather than an error — and the text takes whatever colour
    the app around the editor happens to be using, which was white ink on the
    light ground in the completion list and in every form label. It was right
    on iOS the whole time, which is exactly why nobody found it by looking at a
    phone.

    So: KEEP THIS IN STEP WITH themeVars. liveEditorMount.test.ts asserts
    that every --lp-* any mounted stylesheet reads is one declared here, which
    is the guard rather than this paragraph.
  */
  --lp-content: ${colors.text2};
  /*
    Hairlines, which this file had no token for at all — a rule that needed one
    borrowed --lp-code-bg, and that is the code fence's *fill*: #F5F5F5 on a
    #FFFFFF ground, which is not an edge. The palette has had the right two
    values the whole time.
  */
  --lp-line: ${colors.line};
  --lp-line-strong: ${colors.lineStrong};
  /* The wash behind a focused control, so focus is a ring rather than one
     pixel of border changing colour. */
  --lp-focus-ring: ${colors.accentDim};
  /*
    What a menu item that removes something is drawn in. The rust family
    tokens.ts reserves for conflict, revoked and failed; Delete row is the
    first thing in the editor that destroys anything on a press. (No backticks
    in this comment: it is inside a template literal and one would end it.)
  */
  --lp-danger: ${colors.crit};
  /*
    What the note is drawn *on*. The editor itself is transparent (below), so
    this names the surface behind it rather than painting one. The checkbox's
    tick is cut out of the filled box in this colour.
  */
  --lp-bg: ${colors.surface};
  /*
    The face the rendered blocks are set in — a form's fields, a table's cells.
    Not the scroller's own font-family, which is set directly below: that one
    is the note's body text and existed before anything here needed a token.
  */
  --lp-body: ${fonts.body};
  /*
    THE READING MEASURE — the one --lp-* here that is not a colour or a face.

    It is in this block rather than beside the rule that uses it for the
    reason the paragraph above gives: the identical rule runs inside the iOS
    WebView, where every --lp-* arrives over the bridge, so a property
    declared on one host and read on both is a declaration that silently
    becomes nothing on the other. themeVars sends this one too.

    A BARE NUMBER, and the unit is added by the rule that uses it. A
    font-relative length inside a custom property may be resolved either where
    the property is declared or where it is substituted, and engines differ —
    and those are two different lengths here, because this element is Times New
    Roman at 16px (nothing sets a face on it) while the note is a sans at
    14.5px. Multiplying by 1em down in .cm-content resolves it against the text
    it is measuring, on every engine.

    The number is layout.readingMeasureEm, which carries the argument for it,
    including why it is em rather than the ch that nominally means characters.
  */
  --lp-measure: ${layout.readingMeasureEm};
  height: 100%;
}
.cm-lp-root .cm-editor { height: 100%; background: transparent; }
.cm-lp-root .cm-editor.cm-focused { outline: none; }
.cm-lp-root .cm-scroller {
  font-family: ${fonts.body};
  /*
    The two numbers noteGutterFor needs, spent here and read there.

    (No backticks in this comment: it is inside a template literal, and one
    would end the string — the same trap frontmatterRange's neighbour records.)

    They were literals, which is fine for a rule nothing else has to line up
    with — and the breadcrumb above the note does. layout.noteFontSize is what
    --lp-measure is multiplied by down in .cm-content, and layout.notePadX is
    the gutter the measure is centred inside; anything drawn over this column
    adds them the same way or sits four points off the text at one width and
    level at another.
  */
  font-size: ${layout.noteFontSize}px;
  line-height: 1.75;
  padding: 14px ${layout.notePadX}px;
  overflow: auto;
}
/*
  Through the property rather than the value, so the body text and everything
  that says "the note's ink" resolve to one colour. The media query below moves
  both by moving the property once.
*/
.cm-lp-root .cm-content {
  color: var(--lp-content);
  caret-color: ${colors.text};
  /*
    ONE COLUMN, AND EVERYTHING IN THE NOTE SHARES IT.

    The measure is on .cm-content rather than on .cm-line because a note is
    not only prose: a table, a form, a rendered diagram and a code fence are
    block children of the same element, and constraining the lines alone would
    leave every one of those starting at a different left edge from the
    sentence above it. Nothing is allowed to be wider than the text it belongs
    to; what a wide table gets instead is its own scroller (.cm-lp-grid's
    overflow-x), which is why a 12-column table still reads as part of the
    document rather than dragging the document sideways.

    PADDING RATHER THAN MAX-WIDTH, BECAUSE THE EMPTY HALF OF THE PANE IS
    STILL THE EDITOR.

    The obvious recipe is max-width plus auto margins, and it draws exactly
    the same column. It was measured in Chromium and rejected: it makes
    .cm-content 572px wide inside a 1192px pane, so the 310px either side of
    the text stop being the editable surface. A click there lands on
    .cm-scroller, the editor does not take focus, and nothing happens — on a
    desktop console that is half the note's apparent area gone dead, and
    clicking beside a line to put the caret in it is something people do.

    Padding keeps .cm-content the full width of the pane, so CodeMirror's own
    mousedown handler still maps a click in the margin to the nearest position
    the way it always did, while every block child is inset to the measure.
    The max() floor is what hands the width back at narrow widths: once the
    pane is no wider than the measure the padding is zero and .cm-scroller's
    --lp-pad-x is the only gutter, which is the phone.

    1em is this element's own font size — the note's — which is the point of
    doing the multiplication here rather than storing a length.
  */
  padding-inline: max(0px, calc((100% - var(--lp-measure) * 1em) / 2));
}
.cm-lp-root .cm-line { padding: 0; }
/*
  The phone reads the note; it does not inspect it. Same buffer, same
  decorations, larger measure and more air — see the native half's file comment
  for the argument. A media query rather than a prop because this stylesheet is
  injected once for the document and has no React state to read; the breakpoint
  is layout.narrowBreakpoint, which is what densityFor calls compact, so the
  two surfaces change over at the same width instead of at two numbers that
  agree until somebody edits one. Minus 0.02 rather than minus 1: densityFor
  says compact below the breakpoint, and CSS max-width is inclusive, so a whole
  point would leave a window between 879 and 880 where one surface had changed
  over and the other had not. (No backticks in here: this comment is inside a
  template literal, and one would end the string.)
*/
@media (max-width: ${layout.narrowBreakpoint - 0.02}px) {
  .cm-lp-root .cm-scroller {
    /*
      Measured off Obsidian mobile: 16px on a 24px line box, 24px of side
      padding. Ours was 16.5/1.65 in 20px, which is a 27px line box — 13%
      looser than the reference and enough to make a paragraph read as a list
      of lines rather than a block of prose.
    */
    font-size: 16px;
    line-height: 1.5;
    padding: 8px 24px 32px;
  }
  /*
    The note is the whole screen here rather than a column beside a file tree,
    so it is drawn in the full-strength ink — themeVars' compact ? text : text2,
    which is the same sentence in the same two colours.
  */
  .cm-lp-root { --lp-content: ${colors.text}; }
}
${livePreviewStyles}
`;
  if (fresh) document.head.appendChild(style);
}

export function LiveEditor({
  value,
  editable,
  onChange,
  presence,
  onSave,
  controls,
  onFocus,
  onBlur,
  accessibilityLabel,
  onOpenNote,
  notePath,
  notePaths,
  onSubmitForm,
  onReadFormResponses,
  onVoteForm,
  onUpdateFormResponse,
  onRetractFormResponse,
  onLoadImage,
  onStoreImage,
  onImageProblem,
  onSuggest,
  onPickSuggestion,
  onPreviewLinks,
  onDictate,
  onAsk,
}: LiveEditorProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  /**
   * The presence reporter, behind a ref.
   *
   * The `updateListener` below is installed once, at state construction, and
   * closing over the prop would pin it to the value this render had — the same
   * trap `latestValue` exists for, one field along. A note reopened after a
   * reconnect would then report its caret into a socket that is gone.
   */
  const presenceRef = useRef(presence);
  presenceRef.current = presence;
  /**
   * Where the shared document is swapped in.
   *
   * The editor is built once, at mount, and the room answers a moment later —
   * so the collaborative binding cannot be in the initial extension list. A
   * `Compartment` is CodeMirror's own answer to exactly that: an empty slot at
   * construction, reconfigured when there is something to put in it, with the
   * selection and the undo history left alone.
   */
  const collab = useRef(new Compartment());
  const colors = useColors();

  /**
   * What a link points at, and where following one goes.
   *
   * A ref rather than a dependency of the effect that builds the editor, for
   * the reason `HandlerRef` exists: rebuilding the view when a different note
   * opens would throw away the caret, the selection and the undo history. The
   * extension reads this at event time, so the note it resolves against is
   * always the one on screen.
   */
  const links = useRef<NoteLinkContext>({
    path: notePath ?? null,
    paths: notePaths,
    onOpen: () => {},
  });
  links.current = {
    path: notePath ?? null,
    paths: notePaths,
    onOpen: (path, mode) => onOpenNote?.(path, mode),
  };

  /*
    The same ref trick, for the same reason, on the path that needs it most: a
    form widget is built once and kept across every transaction that does not
    change its fence (see `FormWidget.eq`), so a closure captured when it was
    built would still be aiming at whichever note was open then. Reading the
    handler at press time is what makes "submit this form" mean the form in
    front of you.
  */
  const forms = useRef<FormHostRef>({ current: null, generation: 0 }).current;
  /*
    And the same arrangement for link previews, for the same reason: the
    extension is built once per editor and the host's callback arrives new on
    every render, so what is configured has to be an object the host writes
    into rather than the callback itself.
  */
  /*
    Images, on the same ref arrangement and for the same reason as forms: a row
    widget is built once and kept across every transaction that does not change
    its line, so a closure captured at build time would be loading bytes for
    whichever note was open then.
  */
  const images = useRef<ImageHostRef>({ current: null }).current;
  images.current =
    onLoadImage === undefined || onStoreImage === undefined
      ? null
      : { load: (target) => onLoadImage(target), upload: (image) => onStoreImage(image) };
  const previews = useRef<PluginPreviewRef>({ previews: new Map(), note: null });
  previews.current.ask = onPreviewLinks;
  /*
    Assigned rather than signalled, every render. This editor is built once and
    has notes swapped through it, so the extension cannot see a note change on
    its own — and a counter the host bumps is a counter somebody forgets, which
    is what the first draft of this did (bumped on mount only).
  */
  previews.current.note = notePath ?? null;
  /*
    And the same for suggestions, which is the fix for the second production
    report on that feature: the state below is built in an effect with an empty
    dependency array, so a source handed `onSuggest` directly would call the
    *first* one forever. `useRuntime` rebuilds `askSuggestions` whenever the
    running frames change, so "open the note, then start the plugin" left the
    editor calling a closure whose sandbox list was empty — a plugin that says
    Running and suggests nothing, which is what Seyi saw twice.
  */
  const suggesters = useRef<PluginSuggestRef>({});
  suggesters.current.ask = onSuggest;
  suggesters.current.pick = onPickSuggestion;
  forms.current =
    onSubmitForm === undefined
      ? null
      : {
          submit: (submission) => onSubmitForm(submission),
          ...(onReadFormResponses === undefined
            ? {}
            : { readResponses: (path: string) => onReadFormResponses(path) }),
          ...(onVoteForm === undefined ? {} : { vote: (next: FormVote) => onVoteForm(next) }),
          ...(onUpdateFormResponse === undefined
            ? {}
            : { update: (change: FormResponseUpdate) => onUpdateFormResponse(change) }),
          ...(onRetractFormResponse === undefined
            ? {}
            : { retract: (change: FormResponseRetract) => onRetractFormResponse(change) }),
        };

  /**
   * The note's colours, kept in step with the app's.
   *
   * Its own effect rather than a line in the one below: that effect *builds*
   * the editor, so making it depend on the palette would tear down and rebuild
   * the view on every change of appearance — losing the caret, the selection
   * and the undo history to a colour change. Declared first so the stylesheet
   * is in the document before the first view is created.
   */
  useEffect(() => {
    ensureStyles(colors);
  }, [colors]);

  /**
   * Editability is the one part of the configuration that changes after the
   * editor is built — a note is read-only when it is `privacy.md`, or when the
   * viewer is not an editor of this context.
   *
   * A `Compartment` rather than a full `reconfigure`, and the difference is not
   * style: replacing the whole configuration would rebuild the update listener,
   * and an earlier draft of this file did exactly that and silently detached
   * typing from `onChange`. A compartment swaps one facet and leaves every
   * other extension — including the listener — untouched.
   */
  const editableCompartment = useRef(new Compartment());

  /**
   * The callbacks, held in a ref and read at call time.
   *
   * CodeMirror's extensions are built once, when the view is created. If they
   * closed over the props directly they would capture the first render's
   * `onChange` forever, and every keystroke after the first state change would
   * be sent to a stale reducer.
   */
  const handlers = useRef({ onChange, onSave, controls, onFocus, onBlur, onDictate, onAsk });
  handlers.current = { onChange, onSave, controls, onFocus, onBlur, onDictate, onAsk };

  /**
   * The right-click menu over the note body, and the table-size picker it can
   * raise. `null` means closed; the point is where the pointer was.
   *
   * Two pieces of state rather than one discriminated union because they are
   * genuinely sequential — choosing "Table…" closes the menu and opens the
   * picker at the **same** point, so the picker outlives the menu and has to
   * remember an anchor the menu has already forgotten.
   */
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [tableAt, setTableAt] = useState<{ x: number; y: number } | null>(null);

  // What the editor is known to hold. Compared against the incoming `value` to
  // decide whether a write is a genuine external change or the echo of our own
  // last keystroke. See the module comment.
  const latestValue = useRef(value);

  useEffect(() => {
    if (host.current === null) return;

    /**
     * The configuration lives in `editorSetup.ts`, shared with the iOS half.
     *
     * It used to be written out here, which was right while web was the only
     * surface with a Live Preview. It stopped being right the day
     * `LiveEditor.tsx` became the same CodeMirror inside a `WebView`: two copies
     * of the read-only facets, the `Mod-s` gate and the update listener are two
     * copies to fix, and each half's tests would keep passing while they
     * drifted.
     */
    // `onChange` is wrapped rather than passed straight through: this half also
    // has to record what the editor now holds, which is what the effect below
    // compares an incoming `value` against. (The iOS half keeps the same fact
    // in `createHostBridge`, for the same reason and under the same name.)
    const bridged: HandlerRef = {
      current: {
        onChange: (text: string) => {
          latestValue.current = text;
          /*
            **Only the elected writer dirties the local draft.**

            While a room is live every editor in it holds the same text, so if
            each one marked its own draft unsaved, each one's autosave would
            fire and they would race against one etag — the collision this
            whole feature exists to remove, arriving from the other end. One
            member writes; the rest render.

            `canWrite` is true when there is no room at all, which is what
            keeps a note nobody else is in behaving exactly as it always did.
          */
          if (!mayPersist(presenceRef.current)) return;
          handlers.current.onChange(text);
        },
        onSave: () => {
          /*
            **A manual save is a save, so writer election decides it too.**

            Review found this: `onChange` was gated and ⌘S was not, so any
            client in the room could push its own draft to the bucket with a
            keystroke — which is the racing-writers collision the election
            exists to prevent, reachable by the one control that bypasses
            autosave entirely. For a non-writer the merged text is already
            being saved by somebody else, so the right behaviour is to do
            nothing rather than to save a duplicate.
          */
          if (!mayPersist(presenceRef.current)) return;
          handlers.current.onSave();
        },
      },
    };

    const state = EditorState.create({
      doc: value,
      /*
        The start of the writing, not the start of the file — see
        `openingCaret`. Without it a note that opens with a `---` block opens
        with the caret inside it, and `livePreview.ts` reveals what the caret
        is in, so hiding the block bought nothing on the one screen it was for.
      */
      selection: { anchor: openingCaret(value) },
      // `editorExtensions` rather than `editorStateFor`: the latter is the
      // shared entry point `webview/guest.ts` also calls, and K2's find-in-note
      // keymap (`findInNote`) is web-only — see that module's header for why
      // it is appended here instead of folded into the shared list.
      extensions: [
        ...editorExtensions({
          editable,
          editableCompartment: editableCompartment.current,
          handlers: bridged,
          // Absent when this surface has nowhere to navigate to; the extension
          // is then not installed at all and links are plain text.
          links: onOpenNote === undefined ? undefined : links,
          forms,
          /*
            Images. Passed unconditionally: the ref is the thing that is empty
            on a surface with no bucket, and the row reports that itself — the
            same reason `pluginSuggest` is installed unconditionally below.
          */
          images,
          ...(onImageProblem === undefined ? {} : { reportImage: onImageProblem }),
          /*
            A plugin's in-editor suggestions.

            An option on the shared list rather than an extension appended after
            it: `editorExtensions` already configures CodeMirror's one
            completion, and a second `autocompletion()` beside it throws
            `Config merge conflict for field override` at state construction —
            which is what it did, in production, for every note opened with a
            plugin running. The native guest passes nothing here and keeps the
            editor it had.

            Installed unconditionally on this surface rather than only where a
            plugin is already running, which is the other half of that report's
            fix. "Can a plugin run here?" is not answerable at mount: the owner
            check is still resolving, and a plugin may be started a minute
            later. The source reads `suggesters.current` and answers nothing
            until there is something to ask — so the question is asked at every
            keystroke instead of once, and the answer is allowed to change.
          */
          pluginSuggest: pluginSuggestSource(suggesters.current),
          /*
            No `insetBottom`. A mobile browser shrinks the layout viewport when
            the keyboard opens rather than drawing over the page, so the
            scroller is already the size of what can be seen and a margin here
            would push the caret up by a keyboard that is covering nothing.
            The iOS half needs one because a WKWebView keeps its full height;
            see `coveredBottom`.
          */
        }),
        /*
          A plugin's read preview, on the same condition as its suggestions and
          for the same reason: a surface with no sandbox behind it gets no
          extension rather than one wired to a source that never answers.
        */
        ...(onPreviewLinks === undefined
          ? []
          : [pluginLinkPreview(previews.current), pluginPreviewTheme]),
        findInNote(),
        /*
          Other people's carets, and this editor's own going out.

          The extension is installed unconditionally and the *roster* is what
          may be absent, for `pluginSuggest`'s reason directly above: whether
          this note has a room behind it is not answerable at mount, and a
          connection that arrives a second later must not need a different
          editor.

          `selectionSet` rather than every update: a repaint, a scroll and a
          remote caret all produce updates, and reporting on those would send
          a frame per keystroke of somebody else's typing.
        */
        remoteCarets(),
        // Empty until the room answers; see the effect below.
        collab.current.of([]),
        reportSelection(() => presenceRef.current?.report),
      ],
    });

    const created = new EditorView({ state, parent: host.current });

    /*
      Focus, out to React.

      Two DOM listeners here rather than an extension in `editorSetup.ts`,
      because the guest reports its focus over the bridge instead — the two
      surfaces answer the same prop by different routes, and that route is the
      only part of this the two halves do not share. `guest.ts` attaches the
      identical pair to the identical element, and its comment carries the
      argument for which pair: a table cell is `contenteditable` DOM of a
      widget's, so a caret in a grid is a caret in the note and `contentDOM`
      does not have focus. `focusin` and `focusout` bubble; `focus` and `blur`
      do not.

      Read off the ref rather than closed over, exactly like `onChange` above
      and for the same reason: this view is built once and would otherwise
      report to the first render's callbacks forever.
    */
    let focused = false;
    const reportFocus = () => {
      if (focused) return;
      focused = true;
      handlers.current.onFocus?.();
    };
    const reportBlur = (event: FocusEvent) => {
      // Moving from one cell to the next is not leaving the note.
      const to = event.relatedTarget;
      if (to instanceof Node && created.dom.contains(to)) return;
      if (!focused) return;
      focused = false;
      handlers.current.onBlur?.();
    };
    created.dom.addEventListener("focusin", reportFocus);
    created.dom.addEventListener("focusout", reportBlur);

    /**
     * Right-click over the note body.
     *
     * A DOM listener on `contentDOM` rather than a CodeMirror
     * `domEventHandlers`, for the one reason that matters here: `noteLinks.ts`
     * already registers a `contextmenu` handler, and it answers a **long press
     * on a link** (WebKit reports one as a `contextmenu`). Its press must keep
     * winning, so this checks `defaultPrevented` and stands down — the same
     * shape as `useKeymap.web.ts`'s guard, and the same sentence: a press
     * something has already answered is not this one's to answer again.
     *
     * ## Three things it deliberately does not do
     *
     *  - **Shift-right-click falls through to the browser.** Spelling
     *    suggestions live in the browser's own menu and nowhere else, and
     *    spellcheck is on in this editor by decision (P1 in the editor sweep) —
     *    so replacing that menu unconditionally would have taken away the
     *    feature somebody deliberately turned on. Firefox already spells this
     *    chord the same way; the other engines learn it here.
     *  - **It never suppresses a menu it will not answer.** A read-only note
     *    with nothing selected has no verbs, `editorMenuItems` returns an empty
     *    list, and the browser's menu opens instead of an empty box.
     *    `rowInteractions.web.ts` states the same rule for the file tree.
     *  - **It does not move the caret out of a selection.** Right-clicking
     *    inside the selected text keeps that selection, which is what Copy and
     *    Bold are then about. Clicking anywhere else puts the caret where the
     *    click landed — explicitly, because the engines disagree about whether
     *    a right button places a caret in a contenteditable at all, and a
     *    formatting menu that acts three lines from where somebody clicked is
     *    worse than none.
     */
    const onContextMenu = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      if (event.shiftKey) return;

      const at = { x: event.clientX, y: event.clientY };
      /*
        `posAtCoords` measures, and measuring is the one thing that can fail
        here: it reads client rectangles off ranges, which a document that has
        not been laid out does not have. A throw inside this listener would
        cost the whole menu rather than the caret move, so an unanswerable
        position is `null` and the selection is simply left where it is.
      */
      let position: number | null = null;
      try {
        position = created.posAtCoords(at);
      } catch {
        position = null;
      }
      const selection = created.state.selection.main;
      const inSelection =
        !selection.empty && position !== null && position >= selection.from && position <= selection.to;
      if (!inSelection && position !== null && !created.state.readOnly) {
        created.dispatch({ selection: { anchor: position } });
      }

      const empty =
        editorMenuItems({
          canEdit: !created.state.readOnly,
          hasSelection: !created.state.selection.main.empty,
          apple: isApplePlatform(),
          /*
            Read through `handlers`, not from the closure, for the reason that
            ref exists: this listener is attached once when the view is created
            and the props it reads change under it — a note going read-only, a
            window narrowing out of the density that has a panel. A closure
            captured at creation would offer Dictate on a note that had since
            become somebody else's to read.
          */
          canDictate: handlers.current.onDictate !== undefined,
          canAsk: handlers.current.onAsk !== undefined,
        }).length === 0;
      if (empty) {
        /*
          Standing down closes whatever this menu already had open.

          Without it a right-click that falls through to the browser leaves the
          previous popover sitting there — two menus on the glass, one of them
          about a caret that has moved. Found by the test that drives a
          capability away under a mounted editor; the same line covers
          Shift-right-click, where it is just as true.
        */
        setMenuAt(null);
        setTableAt(null);
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      setTableAt(null);
      setMenuAt(at);
    };
    created.contentDOM.addEventListener("contextmenu", onContextMenu);

    view.current = created;
    latestValue.current = value;
    forms.generation = (forms.generation ?? 0) + 1;

    /*
      The imperative handle, built against `created` rather than `view.current`
      so it cannot be aimed at a later editor by a race — and handed back as
      `null` in the teardown below, before `destroy()`, so nothing can dispatch
      into a destroyed view. See `LiveEditorProps.controls`.

      Every method is `runCommand` from `editorSetup.ts`, which is the same
      function the guest bundle runs inside its `WebView`. `undo`/`redo` are
      therefore CodeMirror's own commands over the `history()` extension already
      configured there — the same history `historyKeymap` gives ⌘Z. A
      hand-rolled value stack here would be a *second* history disagreeing with
      the keyboard's on the one platform that has a keyboard.
    */
    const api: EditorControls = {
      wrap: (before, after) => runCommand(created, { name: "wrap", before, after }),
      toggleLinePrefix: (prefix) => runCommand(created, { name: "toggleLinePrefix", prefix }),
      insertLink: () => runCommand(created, { name: "insertLink" }),
      undo: () => runCommand(created, { name: "undo" }),
      redo: () => runCommand(created, { name: "redo" }),
      blur: () => runCommand(created, { name: "blur" }),
      // Not a `runCommand`: the find bar is this surface's alone, so there is
      // no verb for it in the bridge's protocol and nothing on the other side
      // to run one.
      closeFind: () => closeFindPanel(created),
      dictate: (text) => runCommand(created, { name: "dictate", text }),
      // Not `runCommand`s: neither changes the document, so neither is a
      // command. See `EditorControls.showInterim`.
      showInterim: (text) => drawInterim(created, text),
      discardDictation: () => takeBackRun(created),
    };
    handlers.current.controls?.(api);

    return () => {
      handlers.current.controls?.(null);
      created.dom.removeEventListener("focusin", reportFocus);
      created.dom.removeEventListener("focusout", reportBlur);
      created.contentDOM.removeEventListener("contextmenu", onContextMenu);
      created.destroy();
      view.current = null;
    };
    // Created once. `value` and `editable` are deliberately not dependencies —
    // the two effects below carry their changes in, without tearing the editor
    // down and losing the selection and undo history with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /*
    The shared document, into the editor.

    Once this is in, CodeMirror's text *is* the shared text: a keystroke here
    becomes an update that goes to everybody else, and their updates arrive as
    ordinary transactions. The `value` effect below stops being the authority
    for this note, which is why it checks for a binding before replacing
    anything — the two would otherwise fight over the same document and the
    visible symptom would be your own typing disappearing.
  */
  useEffect(() => {
    const current = view.current;
    const text = presence?.shared?.text;
    if (!current) return;
    current.dispatch({
      // No cast: `SharedDoc.text` is a `Y.Text`, which is exactly what the
      // binding takes. The first version of this typed it as `unknown` and
      // reached for `any` to get past the door, which is a lint error telling
      // the truth — the type was available the whole time.
      effects: [
        collab.current.reconfigure(text ? yCollab(text, null) : []),
        // Carets arrive as positions relative to this document, so the
        // extension needs the document itself to place them.
        setCaretDocument.of(presence?.shared?.doc ?? null),
      ],
    });
  }, [presence?.shared]);

  /*
    The roster, into the editor.

    A `StateEffect` rather than a prop the extension reads, because CodeMirror
    state is not React's: the field holds the members and the decorations are
    computed from it, so a roster that arrives while somebody is mid-word
    redraws the carets without touching the document, the selection or the undo
    history.

    The dependency is the members array from `usePresence`, which is a new
    array only when something actually changed — the reducer returns the same
    state object for a frame it ignored, so a peer's heartbeat does not
    dispatch here.
  */
  useEffect(() => {
    const current = view.current;
    if (!current) return;
    current.dispatch({ effects: setRemoteCarets.of(presence?.members ?? []) });
  }, [presence?.members]);

  // An authoritative change from outside: a different note opened, a draft
  // discarded, a conflict resolved.
  //
  // **Suspended while a shared document is bound.** The room is then the
  // authority for this note's text, and writing `value` over it would be two
  // sources fighting for one document — which shows up as your own typing
  // being replaced a moment after you type it. A different note being opened
  // tears the binding down first, so that case still arrives here. Never the echo of our own typing — that is
  // what the comparison is for, and without it the caret jumps to the end of
  // the document on every keystroke.
  useEffect(() => {
    const current = view.current;
    if (current === null) return;
    if (value === latestValue.current) return;

    /*
      **The guard the comment above promised, which was missing.**

      Review found this: the header said this effect stands down while a shared
      document is bound and there was no condition under it doing so. With a
      room live, `value` is the local draft — which for every client except the
      elected writer is *stale by construction*, because they deliberately stop
      calling `onChange`. Writing it over the document would replace everybody's
      text with one client's stale copy on the next unrelated re-render.

      `latestValue` is still updated first, so when the binding is torn down —
      a different note, a discarded draft — the next authoritative value is
      compared against what the editor actually holds rather than against
      whatever it held before the room existed.
    */
    latestValue.current = value;
    if (presenceRef.current?.shared) return;

    // Not an edit — a different note, a discarded draft, a resolved conflict —
    // and not an entry in the undo history either, or the bar's undo key steps
    // back into the note before this one. See `replaceDocument`.
    replaceDocument(current, value);
  }, [value]);

  useEffect(() => {
    const current = view.current;
    if (current === null) return;
    current.dispatch({
      effects: editableCompartment.current.reconfigure(editability(editable)),
    });
  }, [editable]);

  /*
    The find bar belongs to the document it was searching.

    This editor is built once and has notes swapped through it — that is what
    the effect above this one is for — so nothing takes a bar opened on one
    note down when another arrives, and what stays on screen is a query, a
    match count and highlights computed for a document that is no longer here.
    Keyed on the note rather than on `value`, because `value` changes on every
    keystroke and closing the bar while somebody types in it is worse than the
    bug.
  */
  useEffect(() => {
    const current = view.current;
    if (current === null) return;
    closeFindPanel(current);
  }, [notePath]);

  /*
    The menu belongs to the note it was opened over.

    Same argument as the find bar above, and the same failure without it: this
    editor is built once and has notes swapped through it, so a menu left
    standing across a note change is a set of verbs aimed at a document that is
    no longer here — and "Bold" would then wrap a selection in the *new* note at
    an offset taken from the old one.
  */
  useEffect(() => {
    setMenuAt(null);
    setTableAt(null);
  }, [notePath]);

  /**
   * One menu id, run against the live editor.
   *
   * Every arm goes through the same two modules the keymap and the accessory
   * bar go through — `runCommand` for the verbs that already existed, and
   * `markdownFormat.ts` for the markers — so this is a *router*, not a third
   * implementation of markdown editing. That matters beyond tidiness:
   * `NoteEditor` re-attaches a note's frontmatter in front of every edit on a
   * phone, so an arm that wrote to the buffer by any other route would silently
   * drop the YAML block of every captured note (`noteAccessory.test.ts` pins
   * exactly that for the bar).
   *
   * `readOnly` is checked once, here, and again inside `runCommand` and again
   * by `editability`'s `changeFilter`. That is three gates for one rule and all
   * three are wanted — see `editability`, which argues it at length. The menu's
   * own contribution is that Copy stays available on a note nobody may write.
   */
  const runMenuAction = useCallback((id: EditorMenuId) => {
    const current = view.current;
    if (current === null) return;

    if (id === "copy" || id === "cut") {
      const { from, to } = current.state.selection.main;
      const text = current.state.sliceDoc(from, to);
      if (text !== "") {
        /*
          Fire-and-forget deliberately. `writeClipboard` already falls back to
          `execCommand` where the async API is refused, and there is nowhere in
          this component to report a failure to — the editor has no toast. A
          cut whose copy failed would be the one unacceptable outcome, so the
          delete waits for the answer and is skipped if it never came.
        */
        void writeClipboard(text).then((ok) => {
          if (!ok || id !== "cut") return;
          const editor = view.current;
          if (editor === null || editor.state.readOnly) return;
          /*
            The positions were read before an `await`, and an autosave
            conflict or a note being opened underneath can replace the
            document in that window. Deleting a range that no longer holds
            what was copied would take out whatever moved into it, so the
            range has to still say what it said — and if it does not, the
            copy stands and nothing is removed.
          */
          if (editor.state.sliceDoc(from, to) !== text) return;
          editor.dispatch({ changes: { from, to, insert: "" }, userEvent: "delete.cut" });
        });
      }
      current.focus();
      return;
    }

    if (id === "table") {
      setTableAt(menuAt);
      return;
    }

    if (id === "dictate") {
      /*
        The caret, not the selection's head. The menu put the caret where the
        click landed (see the `contextmenu` handler), so this is where somebody
        pointed — and handing the host a position rather than letting it ask
        later is what stops the words arriving wherever the caret drifted to
        while a permission prompt was up.
      */
      handlers.current.onDictate?.(current.state.selection.main.head);
      current.focus();
      return;
    }

    if (id === "ask") {
      // No `focus()`: the answer arrives in the panel, and pulling the caret
      // back into the note would put the keyboard over it on a narrow window.
      handlers.current.onAsk?.();
      return;
    }

    const marker = id === "bold" || id === "italic" || id === "strikethrough" || id === "code"
      ? MARKERS[id]
      : null;
    if (marker !== null) {
      if (!current.state.readOnly) toggleWrap(current, marker.before, marker.after);
      current.focus();
      return;
    }

    if (id === "link") {
      runCommand(current, { name: "insertLink" });
      return;
    }

    const prefix = LINE_PREFIXES[id];
    if (prefix !== undefined) {
      runCommand(current, { name: "toggleLinePrefix", prefix });
      return;
    }
    // `heading` is the submenu's own id and is never dispatched — `Menu` opens
    // its `items` instead. Reaching here with it is a no-op rather than a
    // silent rewrite of the caret's line, which is the whole reason it is not
    // spelled `heading1`. See `editorMenu.ts`.
  }, [menuAt]);

  /*
    Stable identities, because the picker registers two `document` listeners
    keyed on them and this component re-renders on every keystroke — an inline
    arrow would tear those listeners down and rebuild them for each character
    typed into the note behind the picker.
  */
  const pickTableSize = useCallback(({ rows, columns }: { rows: number; columns: number }) => {
    const current = view.current;
    if (current === null || current.state.readOnly) return;
    // `rows` counts the header, which is the row the grid drew; the command
    // takes body rows. The subtraction lives here, once.
    /*
      The grid is drawn by the same transaction, and `insertTable` puts the
      caret in its first cell. Focusing the editor after that would take the
      caret straight back out of the cell — which is what it did, until a real
      browser typed into a table nobody was in.
    */
    if (!insertTable(current, rows - 1, columns)) current.focus();
  }, []);
  const closeTablePicker = useCallback(() => setTableAt(null), []);

  return (
    <>
      <div
        ref={host}
        className="cm-lp-root"
        aria-label={accessibilityLabel}
        style={{ flex: 1, minHeight: 0, overflow: "hidden" }}
      />
      {menuAt === null || view.current === null ? null : (
        <Menu<EditorMenuId>
          /*
            The same call the `contextmenu` handler makes to decide whether to
            open at all, and it has to stay the same call: a menu that opened
            on one answer and drew another would offer rows the handler had
            already decided were not there — or, worse, open empty. The two are
            eight hundred lines apart, which is exactly why the arguments are
            spelled out identically in both rather than defaulted in one.
          */
          items={editorMenuItems({
            canEdit: !view.current.state.readOnly,
            hasSelection: !view.current.state.selection.main.empty,
            apple: isApplePlatform(),
            canDictate: onDictate !== undefined,
            canAsk: onAsk !== undefined,
          })}
          anchor={menuAt}
          title="Format"
          onSelect={runMenuAction}
          onDismiss={() => setMenuAt(null)}
        />
      )}
      {tableAt === null ? null : (
        <TableSizePicker anchor={tableAt} onPick={pickTableSize} onDismiss={closeTablePicker} />
      )}
    </>
  );
}
