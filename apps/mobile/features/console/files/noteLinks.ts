import { RangeSetBuilder, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  hoverTooltip,
  type DecorationSet,
  type Tooltip,
  type ViewUpdate,
} from "@codemirror/view";
import { indexByName, parseLinks, resolveLink } from "@context/shared/src/links";

/**
 * A link to another note is a link you can follow.
 *
 * ## What was wrong
 *
 * `[[../../2-products/context-lc/overview]]` rendered as that exact string.
 * Not underlined, not coloured, and above all not *clickable* — the notes in
 * these buckets are full of links to each other and following one meant reading
 * the path, finding it in the tree, and clicking that. The owner's words: "links
 * like [[…]] dont actually link to the page they are referencing".
 *
 * ## Why a modifier, and why a tooltip saying so
 *
 * This is an **editor**, and the text under the pointer is text somebody may be
 * about to select or retype. A plain click has to keep placing the caret, or
 * every attempt to fix a typo inside a link navigates away instead. So
 * following one is ⌘-click (Ctrl elsewhere), which is what every editor with
 * this feature does — and because a modifier is invisible, the affordance has
 * to say so: hovering shows a tooltip naming the note and the chord. Without
 * the tooltip the feature is a secret.
 *
 * On a touch screen there is no modifier and no hover, so **long press** is the
 * gesture, and it does not navigate on its own: it asks the host, which puts a
 * small confirmation in front of the person. A long press that silently threw
 * away the note you were editing would be the worst possible reading of an
 * ambiguous gesture.
 *
 * ## What is drawn as a link, and what deliberately is not
 *
 * A target that resolves to a **path** — relative or rooted — is drawn as a
 * link, and whether that note exists is not checked. That is a decision, and
 * the reason is that this surface cannot answer the question: the file tree
 * loads folder by folder, so the console knows the notes somebody has expanded
 * and nothing about the rest. Requiring existence would mean a link to a note
 * in an unexpanded folder — the normal case — rendering as plain text, which is
 * a worse lie than the one it avoids. Following a link to a note that is not
 * there lands on the editor's own "that file does not exist", which is the same
 * answer Obsidian gives and an honest one.
 *
 * A **bare** `[[name]]` is the exception and is drawn only when the paths this
 * surface does know resolve it unambiguously. It has no path to resolve to
 * otherwise, so there is nothing to open — the alternative would be underlining
 * a word and doing nothing when it is clicked.
 *
 * Resolution is `@context/shared`'s — the same engine that rewrites these links
 * when a note moves, so what the editor calls a link and what a rename follows
 * are the same set by construction. They would otherwise drift into a state
 * where following a link worked and renaming its target did not, or the
 * reverse.
 */

/** Everything the extension needs from the app, read at event time. */
export interface NoteLinkContext {
  /** The note being edited. Relative targets are resolved against its folder. */
  path: string | null;
  /**
   * Note paths this surface happens to know about, for bare `[[name]]` links.
   *
   * Optional, and usually incomplete: the file tree loads folder by folder, so
   * the console knows the notes somebody has expanded and no more. That is why
   * existence is **not** a condition for the other two link styles — see the
   * module comment.
   */
  paths?: readonly string[];
  /** ⌘-click, or a confirmed long press. */
  onOpen: (path: string) => void;
  /** A long press. The host asks before opening; see the module comment. */
  onPress: (path: string) => void;
}

/**
 * Held in a ref for the reason `HandlerRef` is: CodeMirror builds its
 * extensions once, so an extension closing over the note list directly would
 * hold the list as it was when the first note opened.
 */
export interface NoteLinkRef {
  current: NoteLinkContext;
}

/** A followable link in the buffer. */
export interface NoteLinkSpan {
  /** The whole construct, brackets included, so all of it is a target. */
  from: number;
  to: number;
  /** Where it points, already resolved to a path this context holds. */
  path: string;
}

/**
 * Every followable link in `text`.
 *
 * Pure, and exported for its own test: what makes this correct is which links
 * it *refuses*, and that is a property of text and a note list rather than of a
 * mounted editor.
 *
 * The span is widened from the target to the whole link — `[[` and `]]`, the
 * alias, the `!` of an embed, `[label](…)` — because a person aiming at a link
 * aims at the words, and in an inline link the words are the label, which is
 * not the part `parseLinks` returns.
 */
export function noteLinksIn(
  text: string,
  context: { path: string | null; paths?: readonly string[] },
): NoteLinkSpan[] {
  if (context.path === null) return [];
  const byName = indexByName(context.paths ?? []);
  const spans: NoteLinkSpan[] = [];

  for (const link of parseLinks(text)) {
    /*
      `resolveLink` answers `null` for everything that is not a path into this
      bucket — an external URL, a bare anchor, a traversal above the root — and
      for a bare name these paths cannot settle. Each of those is a thing not to
      draw, for a different reason, and they are one branch here because the
      resulting behaviour is the same: leave the text alone.
    */
    const path = resolveLink(link, context.path, byName);
    if (path === null) continue;
    spans.push({ ...widen(text, link), path });
  }
  return spans;
}

/**
 * Grow a target's span to the whole link.
 *
 * Done by scanning outward from the target rather than by re-matching, because
 * the parser has already decided where the link is and a second regex here
 * would be a second, disagreeing answer to the same question.
 */
function widen(text: string, link: { kind: string; start: number; end: number }): {
  from: number;
  to: number;
} {
  if (link.kind === "wiki") {
    const close = text.indexOf("]]", link.end);
    const open = text.lastIndexOf("[[", link.start);
    if (open === -1 || close === -1) return { from: link.start, to: link.end };
    return { from: text[open - 1] === "!" ? open - 1 : open, to: close + 2 };
  }
  const close = text.indexOf(")", link.end);
  const open = text.lastIndexOf("[", link.start);
  if (open === -1 || close === -1) return { from: link.start, to: link.end };
  return { from: text[open - 1] === "!" ? open - 1 : open, to: close + 1 };
}

/** The link under a position, or `null`. */
export function noteLinkAt(spans: readonly NoteLinkSpan[], pos: number): NoteLinkSpan | null {
  return spans.find((span) => pos >= span.from && pos <= span.to) ?? null;
}

/**
 * `⌘` on an Apple keyboard, `Ctrl` everywhere else.
 *
 * Read from the user agent because this string goes in front of a person and
 * naming the wrong key is worse than naming none. It is deliberately not read
 * from `Platform.OS`: the editor is a web surface on both hosts, so what
 * matters is the keyboard attached to the browser and not what compiled the
 * app around it. A native iPad with a Magic Keyboard is a Mac for this purpose,
 * and a Windows browser is not, however the app was built.
 */
export function followChord(agent: string | undefined): string {
  return /mac|iphone|ipad|ipod/i.test(agent ?? "") ? "⌘" : "Ctrl";
}

/** How long a touch has to stay put to be a press rather than a tap. */
export const LONG_PRESS_MS = 450;
/** How far it may drift first. Beyond this it is a scroll, not a press. */
export const LONG_PRESS_SLOP = 10;
/**
 * How long a touch must have been held before the browser taking it away is
 * read as a press rather than as an interruption.
 *
 * See the `touchcancel` handler. A cancel at twenty milliseconds is a phone
 * call arriving; a cancel at three hundred is the platform's own long-press
 * recogniser claiming a finger that has not moved.
 */
export const PRESS_CANCEL_FLOOR_MS = 150;

const linkMark = Decoration.mark({ class: "cm-note-link" });

/**
 * The extension.
 *
 * A `ViewPlugin` rather than a `StateField` because what it draws depends on
 * the *note list*, which is not in the document: the plugin reads it off the
 * ref at build time, so a list that arrives later is picked up by the next
 * document or viewport change rather than needing a reconfiguration.
 */
export function noteLinks(ref: NoteLinkRef): Extension {
  const spansOf = (view: EditorView): NoteLinkSpan[] =>
    noteLinksIn(view.state.doc.toString(), ref.current);

  const decorations = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view);
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged) this.decorations = build(update.view);
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );

  function build(view: EditorView): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>();
    for (const span of spansOf(view)) builder.add(span.from, span.to, linkMark);
    return builder.finish();
  }

  const tooltip = hoverTooltip((view, pos): Tooltip | null => {
    const span = noteLinkAt(spansOf(view), pos);
    if (span === null) return null;
    return {
      pos: span.from,
      end: span.to,
      above: true,
      create: () => {
        const dom = document.createElement("div");
        dom.className = "cm-note-link-tooltip";
        const name = document.createElement("span");
        name.className = "cm-note-link-name";
        name.textContent = span.path;
        const hint = document.createElement("span");
        hint.className = "cm-note-link-hint";
        hint.textContent = `${followChord(navigatorAgent())}-click to open`;
        dom.append(name, hint);
        return { dom };
      },
    };
  });

  /*
    A press is state that belongs to one gesture, so it is held here rather than
    on the view: two fingers are two touches and only the first of them can be a
    press.

    ## Two ways a long press arrives, because one of them was never arriving

    The timer below is the obvious one and, driven as real touch events in a
    real browser, it works: touch down, hold, and at `LONG_PRESS_MS` the host is
    asked. **On iOS Safari it fired approximately never**, and the reason is
    that the page is not the only thing watching the finger. WebKit's own
    long-press recogniser — the one that puts up the selection magnifier over
    editable text — claims a stationary touch and tells the page by sending
    `touchcancel`. This handler used that as its cue to give up, so the gesture
    was cancelled by the very thing that recognised it.

    So there are two signals now, and either one is the press:

     - the timer, for every browser that leaves the touch alone;
     - `contextmenu`, which is the platform *reporting* a long press, and which
       is only honoured while a touch gesture of ours is live — a right-click
       on a desktop has no touch behind it and must keep the browser's menu.

    And `touchcancel` no longer cancels a finger that has not moved: the timer
    is left to run, which is what turns WebKit's interruption into the press it
    was recognising. A scroll has already drifted past the slop by then and a
    genuine interruption is caught by `PRESS_CANCEL_FLOOR_MS`.

    Two signals cannot become two dialogs, and no flag is needed to say so:
    `press` cancels the pending gesture on its way out, so whichever signal
    arrives first takes the timer with it and the other finds nothing pending.
    A first draft carried an `emitted` boolean as well; sabotaging it changed
    no test's outcome, because it was guarding a case `cancel` had already
    closed.
  */
  let pending: {
    timer: ReturnType<typeof setTimeout>;
    x: number;
    y: number;
    path: string;
    startedAt: number;
  } | null = null;
  const cancel = () => {
    if (pending === null) return;
    clearTimeout(pending.timer);
    pending = null;
  };
  const press = (path: string) => {
    cancel();
    ref.current.onPress(path);
  };

  const events = EditorView.domEventHandlers({
    mousedown(event, view) {
      if (!(event.metaKey || event.ctrlKey)) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) return false;
      const span = noteLinkAt(spansOf(view), pos);
      if (span === null) return false;
      /*
        Handled here rather than on `click`: the browser has already moved the
        caret by then, and on a modified click macOS also raises a context menu
        on some inputs. Returning true is what stops both.
      */
      event.preventDefault();
      ref.current.onOpen(span.path);
      return true;
    },
    touchstart(event, view) {
      cancel();
      if (event.touches.length !== 1) return false;
      const touch = event.touches[0]!;
      const pos = view.posAtCoords({ x: touch.clientX, y: touch.clientY });
      if (pos === null) return false;
      const span = noteLinkAt(spansOf(view), pos);
      if (span === null) return false;
      pending = {
        x: touch.clientX,
        y: touch.clientY,
        path: span.path,
        startedAt: Date.now(),
        timer: setTimeout(() => press(span.path), LONG_PRESS_MS),
      };
      // Deliberately `false`: the touch keeps behaving like a touch — the caret
      // still lands, the note still scrolls — until the timer decides it was a
      // press. Claiming the event here would break scrolling over any note with
      // a link in it, which is most of them.
      return false;
    },
    touchmove(event) {
      if (pending === null) return false;
      const touch = event.touches[0];
      if (touch === undefined) return false;
      const drifted =
        Math.abs(touch.clientX - pending.x) > LONG_PRESS_SLOP ||
        Math.abs(touch.clientY - pending.y) > LONG_PRESS_SLOP;
      if (drifted) cancel();
      return false;
    },
    touchend() {
      cancel();
      return false;
    },
    touchcancel() {
      /*
        **The one handler that must not do the obvious thing.** A cancel over a
        finger that has not drifted is, on iOS, the platform's long-press
        recogniser taking the touch — so the timer is left to run and the press
        still lands. A cancel that arrives before `PRESS_CANCEL_FLOOR_MS` is
        something interrupting a touch that had not become anything yet, and is
        dropped.
      */
      if (pending !== null && Date.now() - pending.startedAt < PRESS_CANCEL_FLOOR_MS) cancel();
      return false;
    },
    contextmenu(event) {
      /*
        Only while one of our touch gestures is live. A right-click on a
        pointer device reaches this handler too and must keep the browser's own
        menu, which is why this reads `pending` rather than the event.
      */
      if (pending === null) return false;
      // Explicit rather than relying on the `true` below: the system menu
      // coming up over the dialog is the failure this prevents, and it should
      // not depend on a library's convention for what a handled event means.
      event.preventDefault();
      press(pending.path);
      return true;
    },
  });

  return [decorations, tooltip, events, linkTheme];
}

/** A user agent, or nothing, without assuming there is a browser. */
function navigatorAgent(): string | undefined {
  return typeof navigator === "undefined" ? undefined : navigator.userAgent;
}

/**
 * The link's own look, and the tooltip's.
 *
 * Colours come from the editor's CSS custom properties rather than from the
 * design tokens directly: the guest bundle runs inside a WebView that is handed
 * a palette at mount (`webview/styles.ts`), and a token imported here would be
 * the *build's* palette rather than the viewer's — dark links on a light phone.
 */
const linkTheme = EditorView.theme({
  /*
    `--lp-link` and friends are the same variables `livePreview.ts` draws
    everything else from, and they are set per mount: `themeVars` in `host.ts`
    for the WebView, and the web editor's own wrapper for the browser. A colour
    imported from the design tokens here would be the *build's* palette rather
    than the viewer's — dark links on a light phone.
  */
  ".cm-note-link": {
    color: "var(--lp-link)",
    textDecoration: "underline",
    textUnderlineOffset: "2px",
    cursor: "pointer",
    /*
      Safari's own long-press menu, off — over this text and nowhere else.
      Long press *is* this feature's gesture on a touch screen, and the system
      callout is the other thing that answers to it. Scoped to the link span so
      the rest of the note keeps every selection affordance it has.
    */
    WebkitTouchCallout: "none",
  },
  ".cm-note-link-tooltip": {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    padding: "6px 9px",
    borderRadius: "8px",
    border: "1px solid var(--lp-code-bg)",
    background: "var(--lp-bg)",
    color: "var(--lp-content)",
    font: "12px/1.4 system-ui, sans-serif",
    maxWidth: "320px",
    boxShadow: "0 6px 20px rgba(0,0,0,0.18)",
  },
  ".cm-note-link-name": { fontWeight: "500", wordBreak: "break-all" },
  ".cm-note-link-hint": { color: "var(--lp-muted)" },
});
