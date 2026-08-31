/**
 * The half of the editor that runs inside the `WebView`.
 *
 * This is the same CodeMirror the console runs on a laptop — `editorSetup.ts`
 * builds the configuration for both — wired to a JSON bridge instead of to
 * React. Nothing here is React Native, nothing here is React, and nothing here
 * imports anything from `features/` that is not pure: esbuild compiles this
 * file for WKWebView (see `build.mjs`), and Metro never sees it.
 *
 * ## Why it takes a bridge rather than talking to `window`
 *
 * `window.ReactNativeWebView` exists only inside a real web view. Taking the
 * two functions it provides as an argument means the whole of this file runs
 * under jsdom in the ordinary Jest suite, against a real `EditorView` and a
 * real lezer tree, with a bridge that pushes messages into an array. That is
 * how `webviewBridge.test.ts` can prove the thing this file most needs proving —
 * that a read-only note refuses a programmatic edit — without a simulator.
 *
 * `entry.ts` is the ten lines that supply the real bridge.
 *
 * ## What crosses, and what does not
 *
 * Text, an `editable` flag, a palette, a keyboard inset, and a save. The
 * selection does not cross, and preserving it is the reason: see `echoes`.
 */

import { EditorView } from "@codemirror/view";
import { Compartment } from "@codemirror/state";
import {
  editability,
  editorStateFor,
  replaceDocument,
  runCommand,
  type EditorHandlers,
  type HandlerRef,
} from "../editorSetup";
import {
  PROTOCOL_VERSION,
  acceptsChange,
  acceptsCommand,
  decode,
  decodeCommand,
  echoes,
  TO_GUEST_TYPES,
  type ToGuest,
  type ToHost,
} from "./protocol";

export interface GuestBridge {
  /** Hand a message to the host. */
  post: (message: ToHost) => void;
  /** Receive messages from the host. Called once, on mount. */
  listen: (handler: (raw: string) => void) => void;
  /**
   * Run `flush` no more than once before the next frame.
   *
   * Injected so a test can drive it synchronously, and so this file states the
   * coalescing rule rather than assuming `requestAnimationFrame` exists. See
   * `coalesce` for why one frame is the right bound.
   */
  schedule?: (flush: () => void) => void;
}

export interface MountedGuest {
  view: EditorView;
  destroy: () => void;
  /** Deliver a raw message as if it had come from the host. Used by tests. */
  receive: (raw: string) => void;
}

/**
 * Post at most once per frame, always with the newest text.
 *
 * The naive bridge posts on every keystroke, and on a document editor that is a
 * message, a JSON parse, a `setState` and a React re-render of the console per
 * character. The naive fix — a timer debounce — is worse in a way that is easy
 * to miss: `state.draft` is what the Save button writes and what
 * `guardLeaving` reads, so a debounce makes it possible to type, tap Save
 * within the debounce window, and save the previous text.
 *
 * One post per frame has neither problem. A burst — a paste, an autocorrect
 * replacement, a fast typist, an IME commit — collapses to one message, and the
 * host is never more than a frame behind, which no finger can outrun. The
 * pending post reads the current text at flush time rather than capturing it,
 * so a document replaced while a post was queued reports the replacement and
 * not the text it replaced.
 */
export function coalesce(
  send: () => void,
  schedule: (flush: () => void) => void,
): { request: () => void; cancel: () => void } {
  let pending = false;
  let cancelled = false;
  return {
    request: () => {
      if (pending || cancelled) return;
      pending = true;
      schedule(() => {
        pending = false;
        if (!cancelled) send();
      });
    },
    cancel: () => {
      cancelled = true;
    },
  };
}

const defaultSchedule = (flush: () => void): void => {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(flush);
  else setTimeout(flush, 0);
};

/**
 * Write the palette onto the document.
 *
 * The host sends values, never a scheme name: there are two palettes in
 * `tokens.ts` and the rule that keeps them working is that no module holds one.
 * A web view that decided its own colours would be a third palette, and the one
 * nobody would remember to update.
 */
export function applyTheme(
  target: { style: { setProperty: (name: string, value: string) => void } },
  vars: Readonly<Record<string, string>>,
): void {
  for (const [name, value] of Object.entries(vars)) {
    // Only our own namespace, and only plain values. The host is trusted, but
    // this is the one place a string from outside becomes CSS, and a property
    // name is the cheapest thing in the world to constrain.
    if (!/^--lp-[a-z0-9-]+$/.test(name)) continue;
    target.style.setProperty(name, value);
  }
}

export function mountGuest(
  root: HTMLElement,
  bridge: GuestBridge,
  documentElement?: HTMLElement,
): MountedGuest {
  const schedule = bridge.schedule ?? defaultSchedule;
  const editableCompartment = new Compartment();

  /**
   * What the editor is known to hold, and what the host is known to have been
   * told. The one guard the whole bridge turns on — see `echoes` in
   * `protocol.ts`.
   */
  let latest = "";
  /**
   * The editor starts refusing writes and is told otherwise by the host.
   *
   * The safe direction: a bundle that never receives its first `editable`
   * message — a bridge that failed, a host that crashed on mount — leaves a
   * note that cannot be typed into rather than one that can be typed into and
   * never saved.
   */
  let editable = false;
  /**
   * How much of the editor the keyboard, and the accessory bar riding on it,
   * are covering.
   *
   * Held here and read through a closure rather than compartmented into the
   * configuration, because it is consulted at *measure* time: the extension
   * below asks for the current number every time CodeMirror scrolls something
   * into view, so an `inset` message changes where the caret is allowed to sit
   * without reconfiguring the editor. See `coveredBottom`.
   */
  let inset = 0;

  const handlers: HandlerRef = {
    current: {
      onChange: () => {},
      onSave: () => {},
    } satisfies EditorHandlers,
  };

  const view = new EditorView({
    state: editorStateFor({
      doc: "",
      editable: false,
      editableCompartment,
      handlers,
      insetBottom: () => inset,
    }),
    parent: root,
  });

  const changes = coalesce(
    () => bridge.post({ v: PROTOCOL_VERSION, type: "change", text: latest }),
    schedule,
  );

  handlers.current = {
    onChange: (text) => {
      // Recorded synchronously even though the post is deferred: this is what
      // an incoming `doc` is compared against, and a stale copy of it is the
      // caret jumping to the end of the note.
      latest = text;
      // A change on a note the viewer may not write should be impossible —
      // `EditorState.readOnly` refuses commands, paste and drop. If one gets
      // here anyway it is not reported, because reporting it is what turns a
      // failed edit into a dirty draft and a Save that will be refused.
      if (!acceptsChange(editable)) return;
      changes.request();
    },
    onSave: () => bridge.post({ v: PROTOCOL_VERSION, type: "save" }),
  };

  const apply = (message: ToGuest): void => {
    switch (message.type) {
      case "doc": {
        if (echoes(message.text, latest)) return;
        latest = message.text;
        // Not an edit, the one write a read-only note still accepts, and not an
        // entry in the undo history. All three live in `replaceDocument`.
        replaceDocument(view, message.text);
        return;
      }
      case "editable": {
        editable = message.editable;
        view.dispatch({
          effects: editableCompartment.reconfigure(editability(message.editable)),
        });
        return;
      }
      case "theme": {
        applyTheme(documentElement ?? root, message.vars);
        return;
      }
      case "inset": {
        inset = Math.max(0, message.bottom);
        applyTheme(documentElement ?? root, { "--lp-inset-bottom": `${inset}px` });
        /*
          The keyboard has just covered part of the note, and the caret may be
          under it. Three things have to be true for it to come back out, and
          only the third of them is this line:

           - the scroller has to be able to scroll that far, which is the
             padding written above;
           - "in view" has to mean *above the keyboard*, which is the scroll
             margin `inset` now feeds — without it CodeMirror is satisfied by a
             caret anywhere inside the web view's rectangle, and the web view
             keeps its full height while the keyboard is drawn over it;
           - and something has to ask, which is this.

          The first two also apply to every subsequent keystroke, because
          CodeMirror scrolls the caret into view for itself on typed input and
          consults the same facet when it does.
        */
        view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head) });
        return;
      }
      case "command": {
        /**
         * A key on the accessory bar, run against the real editor state.
         *
         * Two refusals before the command runs, and a third inside it.
         * `decodeCommand` is the guest declining to act on a shape it does not
         * recognise — the host builds these, but the guest is a separate bundle
         * that can be paired with a host it does not know, which is the same
         * reason `decode` exists one level up.
         *
         * `acceptsCommand` is the read-only gate, and it is here as well as on
         * the host for exactly the reason `acceptsChange` is: **every key on
         * this bar except the dismiss key is a programmatic edit**, and "the
         * other side checked" is the assumption that made
         * `EditorView.editable.of(false)` look sufficient for a year.
         * `runCommand` checks the live facet a third time, which is the one
         * that cannot be got round by a stale `editable` in this closure.
         */
        const command = decodeCommand(message.command);
        if (command === null) return;
        if (!acceptsCommand(editable, command)) return;
        runCommand(view, command);
        return;
      }
    }
  };

  const receive = (raw: string): void => {
    const message = decode<ToGuest>(raw, TO_GUEST_TYPES);
    if (message === null) return;
    apply(message);
  };

  bridge.listen(receive);

  const onFocus = () => bridge.post({ v: PROTOCOL_VERSION, type: "focus", focused: true });
  const onBlur = () => bridge.post({ v: PROTOCOL_VERSION, type: "focus", focused: false });
  view.contentDOM.addEventListener("focus", onFocus);
  view.contentDOM.addEventListener("blur", onBlur);

  bridge.post({ v: PROTOCOL_VERSION, type: "ready" });

  return {
    view,
    receive,
    destroy: () => {
      changes.cancel();
      view.contentDOM.removeEventListener("focus", onFocus);
      view.contentDOM.removeEventListener("blur", onBlur);
      view.destroy();
    },
  };
}
