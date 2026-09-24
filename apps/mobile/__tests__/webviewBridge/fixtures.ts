/**
 * @jest-environment jsdom
 */

/**
 * THE iOS EDITOR, END TO END, WITHOUT A PHONE.
 *
 * `LiveEditor.tsx` is a `WebView` whose contents are a real CodeMirror. The two
 * halves talk over JSON, and the parts worth proving are all in that
 * conversation rather than in either end:
 *
 *  - text goes across and comes back **byte for byte**, and a note nobody typed
 *    into never produces a `change` at all — which is what makes a save
 *    round-trip the file rather than rewrite it;
 *  - a note the viewer may not write refuses a **programmatic** edit, not just
 *    a keystroke — and every key on the accessory bar is a programmatic edit;
 *  - the caret does not jump when the reducer echoes back what was just typed;
 *  - the accessory bar's commands cross as *names* and are run against the real
 *    editor state, so the selection and the undo history survive them;
 *  - focus crosses back, because a `WebView` has no `onFocus` of its own and
 *    `NoteEditor` decides whether to show the bar from one;
 *  - and `state.draft` goes dirty exactly when it should.
 *
 * None of that needs a simulator. `guest.ts` takes its bridge as an argument
 * and `host.ts` is a function over values, so the two can be wired to each
 * other in one process, with a real `EditorView` and a real lezer tree in the
 * middle. The only thing missing is WKWebView itself, which contributes no
 * behaviour to any of the above — it carries strings.
 *
 * What this therefore does NOT prove, and is verified on a device instead: the
 * keyboard, the caret staying above it, scroll physics, and how the note looks.
 *
 * This module is the shared mounting harness for every file in this folder —
 * it carries no tests of its own.
 */

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { deleteCharBackward, insertNewline } from "@codemirror/commands";
import * as Y from "yjs";
import {
  applyTheme,
  caretBox,
  mountGuest,
  type MountedGuest,
} from "../../features/console/files/webview/guest";
import { guestStyles } from "../../features/console/files/webview/styles";
import { createHostBridge, themeVars } from "../../features/console/files/webview/host";
import {
  PROTOCOL_VERSION,
  type EditorCommand,
} from "../../features/console/files/webview/protocol";
import { runCommand } from "../../features/console/files/editorSetup";
import { splitNote } from "../../features/console/files/frontmatter";
import { editorReducer, emptyEditor } from "../../features/console/files/editor";
import { darkColors, layout, lightColors } from "../../features/design/tokens";

export {
  EditorState,
  EditorView,
  deleteCharBackward,
  insertNewline,
  Y,
  applyTheme,
  caretBox,
  mountGuest,
  type MountedGuest,
  guestStyles,
  createHostBridge,
  themeVars,
  PROTOCOL_VERSION,
  type EditorCommand,
  runCommand,
  splitNote,
  editorReducer,
  emptyEditor,
  darkColors,
  layout,
  lightColors,
};

/**
 * Every command on the accessory bar that touches the document.
 *
 * Written out rather than derived from the bar's own key list, because a table
 * that is the same object the code uses asserts that the code equals itself.
 * `blur` is deliberately not here: it is the dismiss key, it writes nothing,
 * and the tests below require it to work on a note the others are refused on.
 */
export const COMMANDS_THAT_WRITE: readonly EditorCommand[] = [
  { name: "wrap", before: "**", after: "**" },
  { name: "toggleLinePrefix", prefix: "# " },
  { name: "insertLink" },
  { name: "undo" },
  { name: "redo" },
];

/**
 * What CodeMirror has been told to keep clear at the bottom of the scroller.
 *
 * The facet holds functions, so the value has to be asked for rather than read.
 * This is `EditorView.scrollMargins` as CodeMirror itself consults it.
 */
export function marginBelow(view: EditorView): number {
  return view.state
    .facet(EditorView.scrollMargins)
    .reduce((total, read) => total + (read(view)?.bottom ?? 0), 0);
}

/**
 * A note with frontmatter, because that is the shape every note in a real
 * bucket has and the shape most likely to lose a byte: the closing `---`
 * parses as a setext underline, and the live-preview decorations treat the
 * whole block specially because of it.
 */
export const NOTE = "---\nupdated: 2026-08-31\nstatus: active\n---\n\n# Title\n\nSome **bold** body.\n";

export interface Wired {
  guest: MountedGuest;
  host: ReturnType<typeof createHostBridge>;
  view: EditorView;
  /** Every text the host's `onChange` was called with. */
  changes: string[];
  saves: number;
  /** Every `focused` the host's `onFocus` was called with, in order. */
  focus: boolean[];
  /** Run whatever the guest has queued for the next frame. */
  flush: () => void;
  /** Deliver a raw payload as if the web view had posted it. */
  fromWebView: (raw: string) => void;
  destroy: () => void;
}

/**
 * Host and guest, connected to each other.
 *
 * The order matters and is the order React produces: the host's effects set the
 * document, the editability and the palette *before* the web view has loaded —
 * so all of it is sent into the void — and the guest then announces `ready`,
 * which is what makes the host resend the lot. A harness that set the state
 * after mounting would never exercise that, and the first thing a person would
 * see on a phone is an empty editor.
 */
export function connect(initial: { doc: string; editable: boolean }): Wired {
  const root = document.createElement("div");
  document.body.appendChild(root);

  const changes: string[] = [];
  const focus: boolean[] = [];
  const counters = { saves: 0 };
  const frames: (() => void)[] = [];

  let deliver: (raw: string) => void = () => {};
  const host = createHostBridge((raw) => deliver(raw), {
    onChange: (text) => changes.push(text),
    onSave: () => {
      counters.saves += 1;
    },
    onFocus: (focused) => focus.push(focused),
  });

  host.setDoc(initial.doc);
  host.setEditable(initial.editable);
  host.setTheme(themeVars(darkColors, "Menlo", true));

  const guest = mountGuest(
    root,
    {
      post: (message) => host.receive(JSON.stringify(message)),
      listen: (handler) => {
        deliver = handler;
      },
      schedule: (flush) => frames.push(flush),
    },
    document.documentElement,
  );

  return {
    guest,
    host,
    view: guest.view,
    changes,
    focus,
    get saves() {
      return counters.saves;
    },
    flush: () => {
      const queued = frames.splice(0, frames.length);
      for (const frame of queued) frame();
    },
    fromWebView: (raw) => host.receive(raw),
    destroy: () => {
      guest.destroy();
      root.remove();
    },
  } as Wired;
}
