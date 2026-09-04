/**
 * The editor itself — one configuration, two hosts.
 *
 * This used to live inline in `LiveEditor.web.tsx`, which was right while web
 * was the only surface that had a Live Preview. It is not right now that iOS
 * has one too: the native half runs the same CodeMirror inside a `WebView`
 * (see `webview/`), and an editor whose read-only rule, keymap and update
 * listener are written out twice is an editor where the two surfaces drift —
 * and drift silently, because each half has its own tests passing.
 *
 * So the *configuration* is here, and the two `LiveEditor` files are reduced to
 * what genuinely differs: on web, a `<div>` and React effects; on native, a
 * `WebView` and a JSON bridge. Everything about how the document behaves is
 * below, imported by both.
 *
 * Nothing here touches React or React Native. It is compiled twice — by Metro
 * for the browser, and by esbuild into the guest bundle — so an import either
 * bundler cannot follow would break one of the two.
 */

import {
  Annotation,
  Compartment,
  EditorSelection,
  EditorState,
  Transaction,
  type Extension,
} from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, redo, undo } from "@codemirror/commands";
import { livePreview, markdownLanguage } from "./livePreview";
import { noteLinks, type NoteLinkRef } from "./noteLinks";
import type { EditorCommand } from "./webview/protocol";

/**
 * "This text did not come from the person; it came from the app."
 *
 * There are exactly three of those: a different note was opened, a draft was
 * discarded, or a conflict was resolved by loading somebody else's version. All
 * three replace the document, and both hosts have to mark them, for two
 * separate reasons that would otherwise each be a bug:
 *
 *  - **They are not edits.** An unmarked replacement fires the update listener,
 *    which reports a change, which marks the draft dirty. On iOS that was
 *    visible immediately: the editor is built empty and told the note over the
 *    bridge, so *opening a file* announced an edit of it and lit up Save on a
 *    note nobody had touched. On web it was invisible only because the first
 *    document is passed to `EditorState.create` rather than dispatched.
 *  - **They are the one write a read-only note must still accept.** See
 *    `editability`: a read-only note refuses every change, and refusing this
 *    one would mean `privacy.md` opening blank.
 */
export const externalDoc = Annotation.define<boolean>();

/**
 * Put an authoritative document in front of the reader.
 *
 * The one way either host replaces the whole buffer, here rather than written
 * out twice, because it carries **two** annotations and the second one is easy
 * to leave off — which is exactly what happened, and what an accessory bar with
 * an undo key on it made visible.
 *
 * `Transaction.addToHistory.of(false)` keeps this out of the undo history.
 * Without it, opening a note is the first entry in that note's history, so the
 * first press of undo on a freshly-opened file *undoes the open* and hands
 * somebody an empty editor over their own note — and then `onChange` reports
 * the empty string as an edit, and Save writes it. It was invisible while the
 * only route to undo was ⌘Z on a desktop, where the first document is passed to
 * `EditorState.create` and never dispatched at all. On iOS the editor is built
 * empty and told the note over the bridge, so every note had it, and the bar
 * put an undo key under everybody's thumb.
 *
 * `addMapping` is what CodeMirror does with the change instead, so an undo
 * across a note switch is not merely skipped — the positions it holds are
 * remapped, which is what stops it pasting one note's text into another.
 */
export function replaceDocument(view: EditorView, text: string): void {
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    annotations: [externalDoc.of(true), Transaction.addToHistory.of(false)],
  });
}

export interface EditorHandlers {
  onChange: (text: string) => void;
  onSave: () => void;
}

/**
 * The callbacks, read at call time rather than captured.
 *
 * CodeMirror builds its extensions once. An extension that closed over a
 * handler directly would hold the first one forever, and every keystroke after
 * the first state change would be delivered to a stale reducer.
 */
export interface HandlerRef {
  current: EditorHandlers;
}

/** The placeholder, in one place so both surfaces say the same thing. */
export const EDITOR_PLACEHOLDER = "Write in markdown…";

/**
 * Both halves of "you may not write this", which are not the same facet.
 *
 * `EditorView.editable` drops `contenteditable`, and CodeMirror's own doc for
 * it says outright that it "doesn't affect API calls that change the editor
 * content, even when those are bound to keys or buttons. See the `readOnly`
 * facet for that." Setting only the first leaves every editing command, the
 * `Mod-s` binding, the paste handler and the drop handler live on a surface
 * that looks inert — which is exactly what shipped once and what
 * `liveEditorMount.test.ts` and `webviewBridge.test.ts` now both pin.
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
 *
 * ## And a third thing, because two is still not "read-only"
 *
 * The facet is what the *commands* consult, and most of them do — `@codemirror/view`'s
 * own `drop`, `paste` and `cut` handlers open with `if (view.state.readOnly)`,
 * and so does `deleteCharBackward`. But it is a convention, not a gate, and
 * `@codemirror/commands` already breaks it: `insertNewline` replaces the
 * selection and returns `true` without looking. It happens not to be bound in
 * `defaultKeymap` today. "Happens not to be reachable" is how the last version
 * of this was safe, too.
 *
 * `EditorState.changeFilter` *is* a gate: CodeMirror consults it for every
 * transaction that carries changes, whatever produced them, and a `false`
 * drops the changes. So on a note this viewer may not write, the only document
 * change that is allowed through is one the app itself made — the annotation
 * above, which is a different note being opened rather than an edit of this
 * one.
 *
 * `webviewBridge.test.ts` sabotages this deliberately: it builds a view with
 * `EditorView.editable.of(false)` alone and proves the same command goes
 * straight through.
 */
export function editability(editable: boolean): Extension {
  return [
    EditorView.editable.of(editable),
    EditorState.readOnly.of(!editable),
    EditorState.changeFilter.of(
      (transaction) =>
        !transaction.startState.readOnly || transaction.annotation(externalDoc) === true,
    ),
  ];
}

/* -------------------------------------------------------------------------- */
/*                        what a button runs, as opposed to a key             */
/* -------------------------------------------------------------------------- */

/**
 * Bold, italic — the pair of markers around whatever is selected.
 *
 * `changeByRange` rather than one dispatch per marker, because a document with
 * more than one cursor in it is an ordinary CodeMirror document and two
 * separate dispatches would apply the second against positions the first has
 * already moved. The returned range spans the original selection shifted by the
 * opening marker, so wrapping a word leaves the word selected and wrapping
 * nothing leaves the caret between the two markers — which is the behaviour
 * that makes `**` on an empty line worth pressing at all.
 */
function wrapSelection(view: EditorView, before: string, after: string): void {
  view.dispatch(
    view.state.update(
      view.state.changeByRange((range) => ({
        changes: [
          { from: range.from, insert: before },
          { from: range.to, insert: after },
        ],
        range: EditorSelection.range(range.from + before.length, range.to + before.length),
      })),
      { scrollIntoView: true, userEvent: "input" },
    ),
  );
}

/**
 * `# `, `- [ ] ` — a prefix on the caret's line, and off it again.
 *
 * A toggle rather than an insert, because the bar has one key per prefix and
 * pressing "heading" twice on the same line otherwise produces `## `, which is
 * a different heading rather than the undo the second press means.
 *
 * Only the line the caret's *head* is on. Applying it across a multi-line
 * selection is what a desktop editor does; here the whole selection is whatever
 * a thumb dragged, and turning six lines into six headings by accident is a
 * worse failure than only doing one.
 *
 * No `selection` in the transaction: CodeMirror maps the existing selection
 * through the change, which is what keeps the caret in the same place in the
 * *text* as the line grows or shrinks under it.
 */
function toggleLinePrefix(view: EditorView, prefix: string): void {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  view.dispatch({
    changes: line.text.startsWith(prefix)
      ? { from: line.from, to: line.from + prefix.length, insert: "" }
      : { from: line.from, insert: prefix },
    scrollIntoView: true,
    userEvent: "input",
  });
}

/**
 * Run one of the accessory bar's commands against a real editor.
 *
 * **Here rather than in either `LiveEditor`**, and that is the same argument
 * this whole file is: on iOS the command arrives over a bridge and on web it
 * arrives as a method call, but what it *does* must not be written twice. A
 * `wrap` that inserted its markers differently on the two surfaces would be two
 * editors with one name, and each half's tests would keep passing while they
 * drifted.
 *
 * ## Read-only, for the third time
 *
 * `state.readOnly` is checked here even though `editability`'s `changeFilter`
 * would drop the changes anyway, because a refused transaction is still a
 * transaction: it moves the selection, it lands in the undo history, and
 * `view.focus()` below would raise a keyboard over a note nobody may type in.
 * Refusing before dispatching is what makes the key *inert* rather than merely
 * harmless. The filter remains the thing that guarantees it — see `editability`.
 *
 * `undo` is the case that makes this worth stating plainly. It is not an
 * "editing command" in any sense `@codemirror/commands` recognises; it applies
 * an inverted change, and it consults nothing. On a read-only note it would
 * cheerfully undo the app's own `externalDoc` write and hand the reader the
 * previous note.
 *
 * ## Why it takes focus back
 *
 * Pressing a native button over a web view can cost the document its selection
 * on iOS, and a bar whose second press lands somewhere else is worse than no
 * bar. `blur` is the one command that must not — it is the dismiss key, and
 * refocusing would raise the keyboard it just put away.
 */
export function runCommand(view: EditorView, command: EditorCommand): void {
  if (command.name === "blur") {
    view.contentDOM.blur();
    return;
  }
  if (view.state.readOnly) return;
  switch (command.name) {
    case "wrap":
      wrapSelection(view, command.before, command.after);
      break;
    case "toggleLinePrefix":
      toggleLinePrefix(view, command.prefix);
      break;
    case "undo":
      undo(view);
      break;
    case "redo":
      redo(view);
      break;
  }
  view.focus();
}

/**
 * How much of the editor something else is covering, as a scroll margin.
 *
 * **This is what actually keeps the caret above the keyboard**, and the
 * padding in `styles.ts` on its own is not. Padding makes it *possible* to
 * scroll the last line clear of the keyboard; it does nothing to make
 * CodeMirror do so, because CodeMirror's idea of "visible" is the scroller's
 * client rectangle, and on iOS the web view keeps its full height while the
 * keyboard is drawn over it. So `scrollIntoView` was satisfied by a caret
 * sitting underneath the keyboard.
 *
 * `scrollMargins` is the facet CodeMirror provides for exactly this — "space
 * around the sides of the scrolling element that should be considered
 * invisible" — and it applies to *every* scroll into view, including the one
 * CodeMirror does for itself on every keystroke. One facet rather than a margin
 * passed to each of our own calls, which would have covered the bar's commands
 * and not typing.
 *
 * It reads through a function rather than closing over a number so the guest can
 * change the inset without reconfiguring the editor: the facet is consulted at
 * measure time, so the next scroll uses the current value.
 *
 * Only the native half supplies one. A mobile browser shrinks the layout
 * viewport when the keyboard opens, so on web the scroller is already the size
 * of what can be seen and a margin here would push the caret up by a keyboard
 * that is not covering anything.
 */
export function coveredBottom(read: () => number): Extension {
  return EditorView.scrollMargins.of(() => {
    const bottom = read();
    return bottom > 0 ? { bottom } : null;
  });
}

/**
 * Everything the editor is, minus where it is drawn.
 *
 * `editableCompartment` is passed in rather than made here because the host
 * has to hold it to reconfigure later — and a compartment rather than a full
 * `reconfigure` is not style: replacing the whole configuration rebuilds the
 * update listener, and an earlier draft of the web half did exactly that and
 * silently detached typing from `onChange`.
 *
 * `insetBottom` is the one option only one host passes, and the asymmetry is
 * real rather than an oversight: the keyboard covers a WKWebView and shrinks a
 * mobile browser's viewport. See `coveredBottom`.
 */
export function editorExtensions(options: {
  editable: boolean;
  editableCompartment: Compartment;
  handlers: HandlerRef;
  /** How many pixels of the editor the keyboard and its accessory bar cover. */
  insetBottom?: () => number;
  /**
   * What a link to another note points at, and what to do when one is
   * followed. Absent on a surface with nowhere to navigate to — the landing
   * page's demo console is one — and the links are then plain text there,
   * which is honest rather than a degraded feature.
   */
  links?: NoteLinkRef;
}): Extension[] {
  const { editable, editableCompartment, handlers, insetBottom, links } = options;
  return [
    markdownLanguage(),
    livePreview(),
    ...(links === undefined ? [] : [noteLinks(links)]),
    history(),
    EditorView.lineWrapping,
    placeholder(EDITOR_PLACEHOLDER),
    editableCompartment.of(editability(editable)),
    ...(insetBottom === undefined ? [] : [coveredBottom(insetBottom)]),
    keymap.of([
      {
        key: "Mod-s",
        // Returning `true` marks the key handled, so the browser's own "Save
        // Page" dialog never opens over the app. **Both branches below return
        // `true` for that reason**, and the first version of the read-only gate
        // returned `false` — which handed ⌘S back to the browser on exactly the
        // notes a viewer is most likely to be reading rather than writing.
        //
        // CodeMirror calls `preventDefault()` only on a truthy return
        // (`@codemirror/view` `runHandlers`), and a binding's own
        // `preventDefault` defaults to false, so `false` here is a real browser
        // dialog rather than a nicety.
        run: (target) => {
          // Not a save on a note this viewer may not write. `editable` is
          // captured by whoever built this keymap, so the facet is read off the
          // live state instead — the compartment reconfigures, the closure does
          // not.
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
      // A document the app itself wrote is not an edit of it. See `externalDoc`.
      if (update.transactions.some((transaction) => transaction.annotation(externalDoc) === true)) {
        return;
      }
      handlers.current.onChange(update.state.doc.toString());
    }),
  ];
}

/**
 * A fresh state holding `doc`.
 *
 * `lineSeparator` is deliberately left at CodeMirror's default, and that
 * default is worth stating because it is the one place this editor is not
 * byte-exact: CodeMirror splits on `\r\n`, `\r` or `\n` and joins on `\n`, so a
 * CRLF file that somebody *edits* is written back with LF endings. A file
 * nobody edits is never written back at all — the editor does not fire
 * `onChange` on load, so the draft stays the bytes that were read — which is
 * the property `webviewBridge.test.ts` pins, opening a note and asserting that
 * no `change` crosses at all.
 *
 * Pinning the separator to whatever the file happened to use was considered and
 * dropped: it answers only the unmixed case, and a file with both endings would
 * still be rewritten while now doing so under a name that claims otherwise.
 */
export function editorStateFor(options: {
  doc: string;
  editable: boolean;
  editableCompartment: Compartment;
  handlers: HandlerRef;
  insetBottom?: () => number;
  links?: NoteLinkRef;
}): EditorState {
  return EditorState.create({
    doc: options.doc,
    extensions: editorExtensions(options),
  });
}

export { Compartment };
