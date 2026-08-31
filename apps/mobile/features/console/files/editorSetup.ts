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

import { Annotation, Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { livePreview, markdownLanguage } from "./livePreview";

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

/**
 * Everything the editor is, minus where it is drawn.
 *
 * `editableCompartment` is passed in rather than made here because the host
 * has to hold it to reconfigure later — and a compartment rather than a full
 * `reconfigure` is not style: replacing the whole configuration rebuilds the
 * update listener, and an earlier draft of the web half did exactly that and
 * silently detached typing from `onChange`.
 */
export function editorExtensions(options: {
  editable: boolean;
  editableCompartment: Compartment;
  handlers: HandlerRef;
}): Extension[] {
  const { editable, editableCompartment, handlers } = options;
  return [
    markdownLanguage(),
    livePreview(),
    history(),
    EditorView.lineWrapping,
    placeholder(EDITOR_PLACEHOLDER),
    editableCompartment.of(editability(editable)),
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
 * the property `noteRoundTrip.test.ts` pins.
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
}): EditorState {
  return EditorState.create({
    doc: options.doc,
    extensions: editorExtensions(options),
  });
}

export { Compartment };
