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
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { livePreview, livePreviewStyles, markdownLanguage } from "./livePreview";
import { colors, fonts, layout } from "../../design/tokens";

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

function ensureStyles(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ELEMENT_ID) !== null) return;
  const style = document.createElement("style");
  style.id = STYLE_ELEMENT_ID;
  style.textContent = `
.cm-lp-root {
  --lp-heading: ${colors.text};
  --lp-muted: ${colors.text2};
  --lp-link: ${colors.codeKey};
  --lp-code-bg: rgba(255, 255, 255, 0.06);
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
  document.head.appendChild(style);
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
    ensureStyles();

    const compartment = editableCompartment.current;
    const state = EditorState.create({
      doc: value,
      extensions: [
        markdownLanguage(),
        livePreview(),
        history(),
        EditorView.lineWrapping,
        placeholder("Write in markdown…"),
        compartment.of(EditorView.editable.of(editable)),
        keymap.of([
          {
            key: "Mod-s",
            // Returning `true` marks the key handled, so the browser's own
            // "Save Page" dialog never opens over the app.
            run: () => {
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
      effects: editableCompartment.current.reconfigure(
        EditorView.editable.of(editable),
      ),
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
