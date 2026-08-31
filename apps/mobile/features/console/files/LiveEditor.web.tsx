/**
 * The Live Preview editor, on web.
 *
 * A thin, deliberately boring shell around CodeMirror. Everything interesting
 * about how the document is drawn lives in `livePreview.ts`, which is pure and
 * tested; this file exists to solve exactly one hard problem, which is keeping
 * a mutable editor instance and React's idea of the world in agreement without
 * either of them fighting the other.
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
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { livePreview, livePreviewStyles, markdownLanguage } from "./livePreview";
import { fonts, layout } from "../../design/tokens";
import { useColors, type Colors } from "../../design/theme";

export interface LiveEditorProps {
  /** The authoritative text. Written into the editor only when it differs. */
  value: string;
  editable: boolean;
  onChange: (text: string) => void;
  /** Save. Wired to Cmd/Ctrl-S, because that is what people press. */
  onSave: () => void;
  accessibilityLabel: string;
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

/**
 * Both halves of "you may not write this", which are not the same facet.
 *
 * `EditorView.editable` drops `contenteditable`, and CodeMirror's own doc for
 * it says outright that it "doesn't affect API calls that change the editor
 * content, even when those are bound to keys or buttons. See the `readOnly`
 * facet for that." Setting only the first leaves every editing command, the
 * `Mod-s` binding and the drop handler live on a surface that looks inert.
 *
 * `readOnly` here is the VIEWER's clearance, which is a different question from
 * `OpenNote.readOnly` — that one is `key === PRIVACY_KEY`, a fact about the
 * file and never about the person. A member reading a note they cannot write
 * arrives as `editable: false`, and nothing further down stops them: the editor
 * goes dirty, the bottom bar's Save is gated on the draft being dirty rather
 * than on `canEdit`, and `save()` guards on the manifest rather than on
 * clearance. The server refuses the write, so what this costs is a note that
 * silently diverges on screen and a Save that lights up to fail — "a Save
 * button that always fails is worse than no Save button".
 *
 * It also restores `aria-readonly`, which CodeMirror emits only for the facet.
 * Without it the surface announces itself editable to a screen reader, which is
 * the one reader with no other way to tell.
 */
function editability(editable: boolean): Extension {
  return [EditorView.editable.of(editable), EditorState.readOnly.of(!editable)];
}

export function LiveEditor({
  value,
  editable,
  onChange,
  onSave,
  accessibilityLabel,
}: LiveEditorProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  const colors = useColors();

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
  const handlers = useRef({ onChange, onSave });
  handlers.current = { onChange, onSave };

  // What the editor is known to hold. Compared against the incoming `value` to
  // decide whether a write is a genuine external change or the echo of our own
  // last keystroke. See the module comment.
  const latestValue = useRef(value);

  useEffect(() => {
    if (host.current === null) return;

    const compartment = editableCompartment.current;
    const state = EditorState.create({
      doc: value,
      extensions: [
        markdownLanguage(),
        livePreview(),
        history(),
        EditorView.lineWrapping,
        placeholder("Write in markdown…"),
        compartment.of(editability(editable)),
        keymap.of([
          {
            key: "Mod-s",
            // Returning `true` marks the key handled, so the browser's own
            // "Save Page" dialog never opens over the app. **Both branches
            // below return `true` for that reason**, and the first version of
            // the read-only gate returned `false` — which handed ⌘S back to
            // the browser on exactly the notes a viewer is most likely to be
            // reading rather than writing, and made this comment untrue three
            // lines under it. `privacy.md` came out strictly worse than before:
            // `save()` already refused it, so the keystroke used to do nothing
            // AND swallow the dialog, and briefly did nothing AND open it.
            //
            // CodeMirror calls `preventDefault()` only on a truthy return
            // (`@codemirror/view` `runHandlers`), and a binding's own
            // `preventDefault` defaults to false, so `false` here is a real
            // browser dialog rather than a nicety.
            run: (target) => {
              // Not a save on a note this viewer may not write. `editable` is
              // captured by the effect that built this keymap, so the facet is
              // read off the live state instead — the compartment reconfigures,
              // the closure does not.
              if (target.state.readOnly) return true;
              handlers.current.onSave();
              return true;
            },
          },
          ...historyKeymap,
          ...defaultKeymap,
        ]),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          const text = update.state.doc.toString();
          latestValue.current = text;
          handlers.current.onChange(text);
        }),
      ],
    });

    const created = new EditorView({ state, parent: host.current });
    view.current = created;
    latestValue.current = value;

    return () => {
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
    current.dispatch({
      changes: { from: 0, to: current.state.doc.length, insert: value },
    });
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
