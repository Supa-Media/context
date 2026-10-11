import type { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";

import { webUrl } from "./webUrl";

/**
 * What a gesture on a link means, apart from the editor it happens in: which
 * web address is under a position, which keyboard is attached, whether a click
 * opens behind, and how far a tap may drift. Split from `noteLinks.ts`, which
 * re-exports all of it, so that file stays the extension.
 */

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
export const MIDDLE_BUTTON = 1;

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
