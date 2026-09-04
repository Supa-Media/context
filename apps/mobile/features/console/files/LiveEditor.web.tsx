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

import { useEffect, useRef } from "react";
import { Compartment } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { livePreviewStyles } from "./livePreview";
import {
  editability,
  editorStateFor,
  replaceDocument,
  runCommand,
  type HandlerRef,
} from "./editorSetup";
import type { NoteLinkContext } from "./noteLinks";
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
  undo(): void;
  redo(): void;
  blur(): void;
}

export interface LiveEditorProps {
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
   * `onOpenNote` is a ⌘-click (Ctrl elsewhere) and navigates. `onPressNote` is
   * a long press, and deliberately does **not** — the host asks first, because
   * a press is an ambiguous gesture and throwing away the note somebody is
   * editing on the strength of one is the worst available reading of it. See
   * `noteLinks.ts`.
   *
   * Both absent means links are plain text on this surface, which is what the
   * landing page's demo console wants: it has nowhere to navigate to.
   */
  onOpenNote?: (path: string) => void;
  onPressNote?: (path: string) => void;
  /** The note being edited, so a relative link knows what it is relative to. */
  notePath?: string | null;
  /** Paths this surface knows of, for bare `[[name]]` links. Usually partial. */
  notePaths?: readonly string[];
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
  height: 100%;
}
.cm-lp-root .cm-editor { height: 100%; background: transparent; }
.cm-lp-root .cm-editor.cm-focused { outline: none; }
.cm-lp-root .cm-scroller {
  font-family: ${fonts.body};
  font-size: 14.5px;
  line-height: 1.75;
  padding: 14px 16px;
  overflow: auto;
}
.cm-lp-root .cm-content { color: ${colors.text2}; caret-color: ${colors.text}; }
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
  .cm-lp-root .cm-content { color: ${colors.text}; }
}
${livePreviewStyles}
`;
  if (fresh) document.head.appendChild(style);
}

export function LiveEditor({
  value,
  editable,
  onChange,
  onSave,
  controls,
  onFocus,
  onBlur,
  accessibilityLabel,
  onOpenNote,
  onPressNote,
  notePath,
  notePaths,
}: LiveEditorProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
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
    onPress: () => {},
  });
  links.current = {
    path: notePath ?? null,
    paths: notePaths,
    onOpen: (path) => onOpenNote?.(path),
    onPress: (path) => onPressNote?.(path),
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
  const handlers = useRef({ onChange, onSave, controls, onFocus, onBlur });
  handlers.current = { onChange, onSave, controls, onFocus, onBlur };

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
          handlers.current.onChange(text);
        },
        onSave: () => handlers.current.onSave(),
      },
    };

    const state = editorStateFor({
      doc: value,
      editable,
      editableCompartment: editableCompartment.current,
      handlers: bridged,
      // Absent when this surface has nowhere to navigate to; the extension is
      // then not installed at all and links are plain text.
      links: onOpenNote === undefined && onPressNote === undefined ? undefined : links,
      /*
        No `insetBottom`. A mobile browser shrinks the layout viewport when the
        keyboard opens rather than drawing over the page, so the scroller is
        already the size of what can be seen and a margin here would push the
        caret up by a keyboard that is covering nothing. The iOS half needs one
        because a WKWebView keeps its full height; see `coveredBottom`.
      */
    });

    const created = new EditorView({ state, parent: host.current });

    /*
      Focus, out to React.

      Two DOM listeners here rather than an extension in `editorSetup.ts`,
      because the guest reports its focus over the bridge instead — the two
      surfaces answer the same prop by different routes, and that route is the
      only part of this the two halves do not share. `guest.ts` attaches the
      identical pair to the identical `contentDOM`.

      Read off the ref rather than closed over, exactly like `onChange` above
      and for the same reason: this view is built once and would otherwise
      report to the first render's callbacks forever.
    */
    const reportFocus = () => handlers.current.onFocus?.();
    const reportBlur = () => handlers.current.onBlur?.();
    created.contentDOM.addEventListener("focus", reportFocus);
    created.contentDOM.addEventListener("blur", reportBlur);

    view.current = created;
    latestValue.current = value;

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
      undo: () => runCommand(created, { name: "undo" }),
      redo: () => runCommand(created, { name: "redo" }),
      blur: () => runCommand(created, { name: "blur" }),
    };
    handlers.current.controls?.(api);

    return () => {
      handlers.current.controls?.(null);
      created.contentDOM.removeEventListener("focus", reportFocus);
      created.contentDOM.removeEventListener("blur", reportBlur);
      created.destroy();
      view.current = null;
    };
    // Created once. `value` and `editable` are deliberately not dependencies —
    // the two effects below carry their changes in, without tearing the editor
    // down and losing the selection and undo history with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // An authoritative change from outside: a different note opened, a draft
  // discarded, a conflict resolved. Never the echo of our own typing — that is
  // what the comparison is for, and without it the caret jumps to the end of
  // the document on every keystroke.
  useEffect(() => {
    const current = view.current;
    if (current === null) return;
    if (value === latestValue.current) return;

    latestValue.current = value;
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

  return (
    <div
      ref={host}
      className="cm-lp-root"
      aria-label={accessibilityLabel}
      style={{ flex: 1, minHeight: 0, overflow: "hidden" }}
    />
  );
}
