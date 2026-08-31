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

import { useEffect, useRef, type CSSProperties } from "react";
import { Compartment, EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, redo, undo } from "@codemirror/commands";
import { livePreview, livePreviewStyles, markdownLanguage } from "./livePreview";
import { fonts, layout } from "../../design/tokens";
import { useColors, type Colors } from "../../design/theme";
import { useFrame } from "../../app/AppFrame";

/**
 * The handful of things a *button* can ask the editor to do.
 *
 * On a phone there is no keymap and no menu: `NoteAccessory` is the only route
 * to bold, to a heading, to undo. That bar cannot reach into either editor —
 * one is a CodeMirror view, the other a `TextInput`, and neither has a text
 * model the other would recognise — so this is the seam between them, declared
 * once and implemented twice.
 *
 * **It is deliberately five verbs and not a command registry.** Everything
 * here is something the reference's accessory bar actually does; a sixth
 * method added speculatively is a method one of the two implementations will
 * get wrong quietly, because only one platform's version is exercised by any
 * given test run.
 *
 * Every method goes out through the ordinary `onChange`, which is what keeps
 * the accessory bar honest: `NoteEditor` re-attaches a note's frontmatter in
 * front of every edit on a phone, so a command that wrote to the buffer by
 * some other route would silently drop the YAML block of every captured note.
 * `noteAccessory.test.ts` pins exactly that.
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
   * phone — the same bar, a different document — and a handle held past
   * unmount points at a destroyed `EditorView`, where CodeMirror's own
   * `dispatch` throws rather than no-ops. Handing `null` back makes the stale
   * case a control that does nothing rather than a crash on a keystroke.
   */
  controls?: (api: EditorControls | null) => void;
  /**
   * The editing surface took or lost the caret.
   *
   * `NoteEditor` shows the accessory bar from this, because the bar exists to
   * ride above the keyboard and the keyboard is up exactly while this surface
   * is focused. Not derived from the keyboard's own visibility: the keyboard
   * can be up over a different screen entirely.
   */
  onFocus?: () => void;
  onBlur?: () => void;
}

/**
 * Bold, italic — the pair of markers around whatever is selected.
 *
 * `changeByRange` rather than one dispatch per marker, because a document with
 * more than one cursor in it is an ordinary CodeMirror document and two
 * separate dispatches would apply the second one against positions the first
 * has already moved. The returned range spans the original selection shifted
 * by the opening marker, so wrapping a word leaves the word selected and
 * wrapping nothing leaves the caret between the two markers — which is the
 * behaviour that makes `**` on an empty line worth pressing at all.
 */
function wrapSelection(view: EditorView, before: string, after: string): void {
  if (view.state.readOnly) return;
  view.dispatch(
    view.state.update(
      view.state.changeByRange((range) => ({
        changes: [
          { from: range.from, insert: before },
          { from: range.to, insert: after },
        ],
        range: EditorSelection.range(
          range.from + before.length,
          range.to + before.length,
        ),
      })),
      { scrollIntoView: true, userEvent: "input" },
    ),
  );
  view.focus();
}

/**
 * `# `, `- [ ] ` — a prefix on the caret's line, and off it again.
 *
 * A toggle rather than an insert, because the bar has one key per prefix and
 * pressing "heading" twice on the same line otherwise produces `## `, which is
 * a different heading rather than the undo the second press means.
 *
 * Only the line the caret's *head* is on. Applying it across a multi-line
 * selection is what a desktop editor does; here the whole selection is
 * whatever a thumb dragged, and turning six lines into six headings by
 * accident is a worse failure than only doing one.
 *
 * No `selection` in the transaction: CodeMirror maps the existing selection
 * through the change, which is what keeps the caret in the same place in the
 * *text* as the line grows or shrinks under it.
 */
function toggleLinePrefixIn(view: EditorView, prefix: string): void {
  if (view.state.readOnly) return;
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  view.dispatch({
    changes: line.text.startsWith(prefix)
      ? { from: line.from, to: line.from + prefix.length, insert: "" }
      : { from: line.from, insert: prefix },
    scrollIntoView: true,
    userEvent: "input",
  });
  view.focus();
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
  /*
    On a phone this editor does not scroll: it grows.

    The note, its inline title and its Properties panel are one document on one
    full-bleed scroll surface owned by NoteEditor, so the title can pass under
    the floating toolbar the way the reference's does. An editor that kept its
    own scroller inside that surface would be a scrollbar inside a scrollbar,
    with the title pinned above a box that scrolled separately. So the height
    cap comes off and the scroller stops scrolling; the ScrollView above is the
    only one on the screen.
  */
  .cm-lp-root, .cm-lp-root .cm-editor { height: auto; }
  .cm-lp-root .cm-scroller { overflow: visible; }
  .cm-lp-root .cm-scroller {
    /*
      Measured off Obsidian mobile: 16px on a 24px line box, 24px of side
      padding. Ours was 16.5/1.65 in 20px, which is a 27px line box — 13%
      looser than the reference and enough to make a paragraph read as a list
      of lines rather than a block of prose.
    */
    font-size: 16px;
    line-height: 1.5;
    /*
      The side margin is the token every other band on a phone lines up with,
      so the inline title, the Properties panel, the notices and the first
      character of the note share one left edge. It was 24 here and 20, 24 and
      28 elsewhere: four guesses at one measurement.

      No vertical padding at all. The room the floating chrome takes at each end
      is content padding on the ScrollView this now sits inside — one payment,
      by the surface that actually scrolls — and a tail here as well would be a
      second gap under the last line. (No backticks in here: see the note
      above.)
    */
    padding: 0 ${layout.readingMargin}px;
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
  controls,
  onFocus,
  onBlur,
  accessibilityLabel,
}: LiveEditorProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  const colors = useColors();
  /*
    Whether this editor is a box that scrolls or a block that grows.

    On a phone it grows: the note, its inline title and its Properties panel are
    one document on one scroll surface owned by `NoteEditor`, and the room the
    floating chrome takes is that surface's content padding. See the compact
    rule in the stylesheet above — this is the same decision, in the half of the
    styling CSS cannot reach, because these three properties are set inline and
    an inline style wins over a media query.
  */
  const grows = useFrame().density === "compact";

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
        /*
          Focus, out to React. Read off the ref rather than closed over,
          exactly like `onChange` above and for the same reason: these
          extensions are built once and would otherwise report to the first
          render's callbacks forever. Both handlers return `false` — they are
          observers, and claiming the event would stop CodeMirror doing its own
          focus bookkeeping.
        */
        EditorView.domEventHandlers({
          focus: () => {
            handlers.current.onFocus?.();
            return false;
          },
          blur: () => {
            handlers.current.onBlur?.();
            return false;
          },
        }),
      ],
    });

    const created = new EditorView({ state, parent: host.current });
    view.current = created;
    latestValue.current = value;

    /*
      The imperative handle, built against `created` rather than `view.current`
      so it cannot be aimed at a later editor by a race — and handed back as
      `null` in the teardown below, before `destroy()`, so nothing can dispatch
      into a destroyed view. See `LiveEditorProps.controls`.

      `undo`/`redo` are CodeMirror's own commands over the `history()` extension
      already configured above, which is the same history `historyKeymap` gives
      ⌘Z. A hand-rolled value stack here would be a *second* history disagreeing
      with the keyboard's on the one platform that has a keyboard.
    */
    const api: EditorControls = {
      wrap: (before, after) => wrapSelection(created, before, after),
      toggleLinePrefix: (prefix) => toggleLinePrefixIn(created, prefix),
      undo: () => {
        undo(created);
        created.focus();
      },
      redo: () => {
        redo(created);
        created.focus();
      },
      blur: () => created.contentDOM.blur(),
    };
    handlers.current.controls?.(api);

    return () => {
      handlers.current.controls?.(null);
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
      /*
        A pointer layout gives this the height it is allotted and lets
        CodeMirror scroll inside it; a phone lets it be as tall as the note and
        scrolls the page. `overflow: hidden` goes with the first — clipping a
        block that is meant to grow inside somebody else's scroller is how the
        bottom half of a long note disappears.
      */
      style={
        grows
          ? ({ flex: "none", minHeight: 0 } as CSSProperties)
          : ({ flex: 1, minHeight: 0, overflow: "hidden" } as CSSProperties)
      }
    />
  );
}
