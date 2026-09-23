import { RangeSetBuilder, type EditorState, type Extension } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
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

import { selectionTouches } from "./livePreview";
import { webUrl } from "./webUrl";

export { webUrl } from "./webUrl";

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
 * ## One click follows it, and the caret keeps a way in
 *
 * This was ⌘-click (Ctrl elsewhere), with a tooltip naming the chord, because
 * the text under the pointer is text somebody may be about to retype and a
 * mistyped path lives *inside* a link. The reasoning was sound and the
 * conclusion was wrong: a modifier is invisible, so the feature had to announce
 * its own keystroke to exist at all, and the gesture everybody already has —
 * pointing at a link and clicking it — did nothing. Obsidian follows on a plain
 * click and so does this now.
 *
 * What made that safe is that **the caret keeps two ways in**, and they are the
 * whole of the old argument's answer:
 *
 *  - **⌥/Alt-click** places the caret and navigates nothing. It is the
 *    deliberate "I am editing this link" gesture.
 *  - **A click on a link that already holds the caret** places the caret too.
 *    Live preview has already unfolded that link to its `[[…]]` source, and
 *    source is text: clicking text puts the caret in it. So the way to fix a
 *    path is the way you were already going to try — click into it, then click
 *    again — rather than a chord you have to be told about.
 *
 * ⌘/Ctrl-click opens the note **behind** the one you are reading, which is what
 * the modifier means in a browser and is the one thing the old binding was
 * quietly spending. Middle-click is the same. On an Apple keyboard the Ctrl
 * half is deliberately dropped: Ctrl-click *is* a right-click there, and
 * claiming it would take the note's own context menu away over every link.
 *
 * On a touch screen a **tap** follows — a tap is not an ambiguous gesture, so
 * the confirmation sheet that used to stand in front of a long press is gone,
 * and with it the whole `touchcancel`/`contextmenu` reading of WebKit's
 * long-press recogniser. Long press is selection again, as it is everywhere
 * else in the note.
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
 * ## A web link opens too
 *
 * `[site](https://example.com)`, `<https://…>` and a bare `https://…` were
 * drawn as links and a click put the caret in them — the owner's words:
 * "clicking on a [regular](link.com) does not work". They follow on the same
 * click, with the same two ways into their text, and open wherever the host
 * says (`onOpenUrl`): a new tab on the web, the real browser from the desktop
 * shell, and on a phone after a sheet naming the address, because that is the
 * one message the web view sends that leaves the app. What counts as a web
 * address is `webUrl.ts`, which allow-lists the scheme.
 *
 * Resolution is `@context/shared`'s — the same engine that rewrites these links
 * when a note moves, so what the editor calls a link and what a rename follows
 * are the same set by construction. They would otherwise drift into a state
 * where following a link worked and renaming its target did not, or the
 * reverse.
 */

/**
 * Where a followed link lands.
 *
 * `"foreground"` is the click: the note opens and you go to it. `"background"`
 * is ⌘-click and middle-click: the note opens in a tab behind, and the caret,
 * the scroll position and the note in front of you are all left alone.
 *
 * Carried as a *mode* rather than as two callbacks because the host decides
 * what a tab is — on a phone there is no strip and both modes are the same
 * arrival — and a second callback would push that decision into every caller.
 */
export type NoteLinkOpen = "foreground" | "background";

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
  /** A click, a ⌘-click, a middle-click, or a tap. */
  onOpen: (path: string, mode: NoteLinkOpen) => void;
  /**
   * A link out of the bucket was clicked — a web page or an email address,
   * already checked by `webUrl`. Absent means this surface cannot open one,
   * and such a link then takes the caret like any other text.
   */
  onOpenUrl?: (url: string) => void;
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
    /*
      `[site](example.com/page)` is a web page somebody forgot the scheme on,
      not a note in a folder called `example.com` — see `webUrl`. Left to
      `webLinkAt`, which opens it, rather than drawn as a note that is not there.
    */
    if (link.kind === "inline" && webUrl(link.target) !== null) continue;
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

/** A link out of the bucket, and what opening it opens. */
export interface WebLinkSpan {
  from: number;
  to: number;
  url: string;
}

/**
 * The web link at `pos`, as the grammar reads the document, or `null`.
 *
 * Three shapes: `[label](https://…)`, `<https://…>`, and a bare `https://…`
 * or `www.…` that GFM makes a link on its own. The span is the whole construct,
 * as with a note link, because the words are what a person aims at.
 *
 * From the syntax tree rather than from `parseLinks`, because the question is
 * what live preview has *drawn* as a link, and it draws what the tree says.
 */
export function webLinkAt(state: EditorState, pos: number): WebLinkSpan | null {
  let found: WebLinkSpan | null = null;
  syntaxTree(state).iterate({
    from: pos,
    to: pos,
    enter(node) {
      if (found !== null || node.name === "Image") return false;
      if (node.name === "Link" || node.name === "Autolink") {
        const target = node.node.getChild("URL");
        const url = target === null ? null : webUrl(state.sliceDoc(target.from, target.to));
        if (url !== null) found = { from: node.from, to: node.to, url };
        return false;
      }
      if (node.name === "URL") {
        const url = webUrl(state.sliceDoc(node.from, node.to));
        if (url !== null) found = { from: node.from, to: node.to, url };
        return false;
      }
      return undefined;
    },
  });
  return found;
}

/**
 * Whether this keyboard is an Apple one.
 *
 * Read from the user agent because what it decides goes in front of a person
 * and reaches their hands: which modifier opens a link behind, and which word
 * the tooltip uses for it. It is deliberately not read from `Platform.OS` —
 * the editor is a web surface on both hosts, so what matters is the keyboard
 * attached to the browser and not what compiled the app around it. A native
 * iPad with a Magic Keyboard is a Mac for this purpose, and a Windows browser
 * is not, however the app was built.
 */
export function isAppleKeyboard(agent: string | undefined): boolean {
  return /mac|iphone|ipad|ipod/i.test(agent ?? "");
}

/** `⌘` on an Apple keyboard, `Ctrl` everywhere else. The tooltip's word. */
export function followChord(agent: string | undefined): string {
  return isAppleKeyboard(agent) ? "⌘" : "Ctrl";
}

/**
 * Whether this click asks for the note to open **behind** the one on screen.
 *
 * ⌘ on an Apple keyboard, Ctrl everywhere else, and the middle button
 * anywhere — the browser's own vocabulary for "open in a background tab".
 *
 * **Ctrl is not honoured on an Apple keyboard, and that asymmetry is the
 * point.** Ctrl-click there *is* a right-click: the OS raises a context menu
 * from it, and an extension that claimed it would take the note's own
 * right-click menu away over every link while looking, on every other
 * platform, like it worked.
 */
export function opensBehind(
  event: { button: number; metaKey: boolean; ctrlKey: boolean },
  agent: string | undefined,
): boolean {
  if (event.button === MIDDLE_BUTTON) return true;
  return isAppleKeyboard(agent) ? event.metaKey : event.ctrlKey;
}

/** The auxiliary button. `button` is 0 primary, 1 auxiliary, 2 secondary. */
const MIDDLE_BUTTON = 1;

/**
 * How far a finger may drift and still be a tap. Beyond this it is a scroll.
 *
 * A note is a scroller and most notes have links in them, so a tap that
 * survived a drag would navigate on an ordinary flick down the page — the
 * gesture people make most.
 */
export const TAP_SLOP = 10;

/**
 * How long a finger may stay down and still be a tap.
 *
 * Above this it is a long press, which is **not** this extension's gesture any
 * more: it is a selection, and the platform's own recogniser is welcome to it.
 * The ceiling is what keeps the two apart without the page having to guess at
 * WebKit's intentions, which is what the `touchcancel` and `contextmenu`
 * handling that used to live here was doing.
 */
export const TAP_MAX_MS = 500;

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
    if (span === null) return webTooltip(view, pos);
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
        /*
          It names the note, and then says what the two modifiers do. It no
          longer has to teach the gesture that *opens* the link, which is the
          difference between an affordance and a feature's only documentation.
        */
        hint.textContent = `Click to open · ${followChord(navigatorAgent())} behind · ⌥ edit`;
        dom.append(name, hint);
        return { dom };
      },
    };
  });

  /** The same card over a web link: where it goes, and how to edit it instead. */
  const webTooltip = (view: EditorView, pos: number): Tooltip | null => {
    if (ref.current.onOpenUrl === undefined) return null;
    const web = webLinkAt(view.state, pos);
    if (web === null) return null;
    return {
      pos: web.from,
      end: web.to,
      above: true,
      create: () => {
        const dom = document.createElement("div");
        dom.className = "cm-note-link-tooltip";
        const name = document.createElement("span");
        name.className = "cm-note-link-name";
        name.textContent = web.url;
        const hint = document.createElement("span");
        hint.className = "cm-note-link-hint";
        hint.textContent = "Click to open · ⌥ edit";
        dom.append(name, hint);
        return { dom };
      },
    };
  };

  /**
   * Whether this link is currently showing its source, with a caret in it.
   *
   * The second of the two ways into a link's text, and the one nobody has to
   * be told about: live preview unfolds the link the selection touches, so
   * what is under the pointer at that moment is `[[…]]` rather than a rendered
   * link. Clicking source has to put the caret where somebody aimed, exactly
   * as clicking any other text does.
   *
   * `selectionTouches` is **live preview's own predicate**, imported rather
   * than re-derived, because the question here is precisely the one it
   * answers: is this link drawn as source right now? Two implementations of it
   * would drift into a state where the editor shows a path and a click on that
   * path navigates instead of putting a caret in it.
   *
   * **`hasFocus` is what stops a freshly opened note eating its first click.**
   * A view that nobody has clicked into still has a selection — at position 0
   * — so a note whose first characters are a link would count as "the caret is
   * in it" before anybody had touched it, and following that link would do
   * nothing. An unfocused editor has no caret anybody can see and nobody is
   * editing it; there is nothing there to protect.
   */
  const ranges = (view: EditorView): { from: number; to: number }[] =>
    view.state.selection.ranges.map((range) => ({ from: range.from, to: range.to }));

  const editing = (view: EditorView, span: { from: number; to: number }): boolean =>
    view.hasFocus && selectionTouches(span, ranges(view));

  /**
   * What is under the pointer: a note to open, a web address to open, or
   * nothing. A note link wins where both could answer, because the note
   * resolver is the one that knows this bucket.
   *
   * A web link is only offered when the surface can open one — without
   * `onOpenUrl` it stays text the caret goes into, which is what it was.
   */
  const targetAtCoords = (
    view: EditorView,
    x: number,
    y: number,
  ): { from: number; to: number; path?: string; url?: string } | null => {
    const pos = view.posAtCoords({ x, y });
    if (pos === null) return null;
    const note = noteLinkAt(spansOf(view), pos);
    if (note !== null) return note;
    if (ref.current.onOpenUrl === undefined) return null;
    return webLinkAt(view.state, pos);
  };

  /** Follow what `targetAtCoords` found. */
  const follow = (target: { path?: string; url?: string }, mode: NoteLinkOpen): void => {
    if (target.path !== undefined) ref.current.onOpen(target.path, mode);
    else if (target.url !== undefined) ref.current.onOpenUrl?.(target.url);
  };

  /*
    A tap is state that belongs to one gesture, so it is held here rather than
    on the view: two fingers are two touches and only the first of them can be
    a tap.

    **This is all that is left of the long press**, and the deletion is the
    feature. The old gesture had to be told apart from a scroll *and* from
    WebKit's own long-press recogniser, which claims a stationary touch and
    announces it by sending `touchcancel` — so this module carried a timer, a
    cancel floor, a `contextmenu` handler and a rule about which of two signals
    got to fire first, and the host carried a confirmation dialog in front of
    all of it. A tap needs none of that: it is over before any of those
    recognisers has an opinion, and it is not ambiguous, so there is nothing to
    ask about.
  */
  let tap: { x: number; y: number; path?: string; url?: string; startedAt: number } | null = null;
  const forget = () => {
    tap = null;
  };

  const events = EditorView.domEventHandlers({
    mousedown(event, view) {
      // The secondary button is the context menu's, and `rightClick.web.ts`
      // draws it over links like anything else.
      if (event.button !== 0 && event.button !== MIDDLE_BUTTON) return false;
      /*
        ⌥ is the deliberate "I am editing this link" gesture, and it is checked
        before anything is even looked up: whatever is under the pointer, this
        click belongs to the caret.
      */
      if (event.altKey) return false;
      const span = targetAtCoords(view, event.clientX, event.clientY);
      if (span === null) return false;
      // The link is unfolded to its source and somebody is working inside it.
      if (editing(view, span)) return false;
      /*
        Handled on `mousedown` rather than on `click`: the browser has already
        moved the caret by then, and preventing the default here is what stops
        both that and, on a middle click, the paste-on-select some platforms
        still do.
      */
      event.preventDefault();
      follow(span, opensBehind(event, navigatorAgent()) ? "background" : "foreground");
      return true;
    },
    touchstart(event, view) {
      forget();
      if (event.touches.length !== 1) return false;
      const touch = event.touches[0]!;
      const span = targetAtCoords(view, touch.clientX, touch.clientY);
      if (span === null) return false;
      /*
        THE PHONE'S WAY INTO A LINK'S TEXT, and without it there is none.

        A touch screen has no ⌥, so the caret rule is the *only* one of the two
        escape hatches it has — and a tap that always followed would make the
        characters inside a link unreachable on a phone, which is the whole
        objection the old ⌘-click rule was built around, surviving on one
        platform.

        It reads as: tap beside the link to put the caret there, which unfolds
        it to source (live preview reveals what the selection touches, ends
        included), and tap again to land in the path. The same two taps a
        pointer spends, without the modifier.
      */
      if (editing(view, span)) return false;
      tap = {
        x: touch.clientX,
        y: touch.clientY,
        path: span.path,
        url: span.url,
        startedAt: Date.now(),
      };
      // Deliberately `false`: the touch keeps behaving like a touch — the note
      // still scrolls, the caret still lands — until `touchend` decides it was
      // a tap. Claiming the event here would break scrolling over any note
      // with a link in it, which is most of them.
      return false;
    },
    touchmove(event) {
      if (tap === null) return false;
      const touch = event.touches[0];
      if (touch === undefined) return false;
      const drifted =
        Math.abs(touch.clientX - tap.x) > TAP_SLOP || Math.abs(touch.clientY - tap.y) > TAP_SLOP;
      if (drifted) forget();
      return false;
    },
    touchend(event) {
      if (tap === null) return false;
      const { startedAt } = tap;
      const target = tap;
      forget();
      // Held too long: a selection, and the platform's to finish.
      if (Date.now() - startedAt > TAP_MAX_MS) return false;
      /*
        Claimed, unlike `touchstart`. The synthetic click a browser sends after
        a touch would otherwise land on the note we have just left and put a
        caret in it — the arriving note scrolled to wherever the finger was.
      */
      event.preventDefault();
      follow(target, "foreground");
      return true;
    },
    touchcancel() {
      /*
        An ordinary give-up now, which it could not be while a long press lived
        here: a cancel over a stationary finger was iOS *recognising* the
        gesture, so the handler had to keep a timer running through it. A tap
        that the platform takes away was not a tap.
      */
      forget();
      return false;
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
      Safari's own long-press callout is deliberately **not** suppressed any
      more. It was off here because long press used to be this feature's
      gesture and the system menu was the other thing answering to it; now a
      tap follows the link and a long press is a selection, so a link is the
      one piece of text in the note with no reason left to behave differently
      from the rest of it.
    */
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
