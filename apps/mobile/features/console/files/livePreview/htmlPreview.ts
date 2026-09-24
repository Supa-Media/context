/**
 * `html-preview` fences: which ones are drawn, the sandboxed document they are
 * drawn from, and the iframe widget that draws them.
 *
 * Part of the Live Preview extension; `../livePreview.ts` is the facade that
 * re-exports the public names and holds the module map.
 */

import type { EditorState } from "@codemirror/state";
import { WidgetType } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import { revealSelection } from "./engagement";
import { selectionTouches } from "./reveal";

/* --------------------------- rendered previews ---------------------------- */

/**
 * The one fence tag this editor draws instead of printing, and the whole of the
 * convention: no new file format, no frontmatter switch, no per-note setting.
 *
 * ```` ```html-preview ```` is opt-in because a plain ```` ```html ```` block is
 * somebody quoting HTML — a snippet they are debugging, a fragment they are
 * explaining — and a note that talks about markup must not start executing it.
 */
export const HTML_PREVIEW_TAG = "html-preview";

/**
 * A fence that will be drawn, and the markup it will be drawn from.
 *
 * `from`/`to` are the whole fence including both ```` ``` ```` lines, because
 * that is the range the widget stands in for and the range the caret has to
 * touch to get the source back.
 */
export interface HtmlPreview {
  readonly from: number;
  readonly to: number;
  /** The fence's body, exactly as the file holds it. Never rewritten. */
  readonly html: string;
}

/** The first word of a fence's info string, lower-cased, or `null`. */
function fenceTag(
  doc: { sliceString: (from: number, to: number) => string },
  fence: SyntaxNode,
): string | null {
  const info = fence.getChild("CodeInfo");
  if (info === null) return null;
  const first = doc.sliceString(info.from, info.to).trim().split(/\s+/)[0];
  return first === undefined || first === "" ? null : first.toLowerCase();
}

/**
 * What is between a fence's two ```` ``` ```` lines, read off the text.
 *
 * Off the *text* rather than off a `CodeText` child, and that is not
 * incidental: `FENCE_LANGUAGES` makes the grammar parse the inside of an
 * `html`, `css` or `js` fence into real nodes, so "the fence's content" is one
 * leaf for some tags and a subtree for others. A tag that is wired up today is
 * one dependency bump away from being wired up tomorrow, and a preview that
 * silently renders half its diagram would be the failure. Two line boundaries
 * are exact whatever the grammar does inside them.
 *
 * An unterminated fence — the state a note is in for as long as somebody is
 * typing one — has a single `CodeMark`, and its body runs to the end of the
 * node.
 */
function fenceBody(
  doc: { lineAt: (pos: number) => { from: number; to: number }; length: number; sliceString: (from: number, to: number) => string },
  fence: SyntaxNode,
): string {
  const marks = fence.getChildren("CodeMark");
  const open = marks[0];
  if (open === undefined) return "";
  const start = doc.lineAt(open.from).to + 1;
  if (start > doc.length) return "";
  const close = marks.length > 1 ? marks[marks.length - 1] : null;
  const end = close === null ? fence.to : doc.lineAt(close.from).from - 1;
  return start >= end ? "" : doc.sliceString(start, end);
}

/**
 * Every `html-preview` fence that should be drawn right now.
 *
 * Pure over the state, like every other pass in this file, and conditional on
 * the selection like the mark-hiding is: **a drawn diagram becomes its own
 * fence again the moment the caret enters it.** That is this file's central
 * rule — you cannot edit syntax you cannot see — and a diagram is the case
 * where breaking it would hurt most, because the markup underneath is the only
 * place the diagram can be changed.
 *
 * Two fences are deliberately left as text rather than drawn:
 *
 *  - **One that does not start at the margin.** A fence indented inside a list
 *    item does not occupy whole lines, and a block widget can only replace
 *    whole lines. An honest code block beats a widget that eats half a list.
 *  - **One with an empty body.** There is nothing to draw, and a zero-height
 *    frame is a gap in the note that nothing explains.
 *
 * `frontEnd` excludes the frontmatter, for the reason `hangingIndents` states:
 * metadata is drawn as metadata, and a `---` block that happens to contain a
 * fence is still YAML.
 */
export function htmlPreviews(state: EditorState, frontEnd = 0): HtmlPreview[] {
  const previews: HtmlPreview[] = [];
  const selection = revealSelection(state);
  syntaxTree(state).iterate({
    from: 0,
    to: state.doc.length,
    enter(node) {
      if (node.from < frontEnd) return;
      if (node.name !== "FencedCode") return;
      const fence = node.node;
      if (fenceTag(state.doc, fence) !== HTML_PREVIEW_TAG) return;
      if (
        state.doc.lineAt(fence.from).from !== fence.from ||
        state.doc.lineAt(fence.to).to !== fence.to
      ) {
        return;
      }
      if (selectionTouches({ from: fence.from, to: fence.to }, selection)) return;
      const html = fenceBody(state.doc, fence);
      if (html.trim() === "") return;
      previews.push({ from: fence.from, to: fence.to, html });
    },
  });
  return previews;
}

/**
 * What the frame is allowed to reach, which is nothing.
 *
 * The `sandbox` attribute already stops the note being code. This stops it
 * being a **beacon**: `background:url(https://…)` needs no JavaScript, and a
 * fetch from a note a stranger emailed you is a read receipt on a document you
 * did not ask for — it tells the sender the moment you opened it, and which
 * note. `default-src 'none'` closes that, and `img-src data:` still lets a
 * diagram carry its own artwork inline. There is no `font-src`: a webfont is a
 * fetch like any other.
 */
const PREVIEW_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";

/**
 * The document the frame is handed, with the fence's markup inside it verbatim.
 *
 * **Nothing here filters anything, and that is the design rather than a gap.**
 * Writing an HTML sanitizer means maintaining a list of tags and attributes
 * against everyone who has ever found a way past one, and it would buy nothing:
 * the browser already refuses to run script in a bare-`sandbox` frame, for
 * free, with no bypass surface of our making. A second mechanism nobody tests
 * is not defence in depth.
 *
 * Exported so its own test can read it without a DOM.
 *
 * `color-scheme: light` and a white ground are the one opinion this document
 * holds, and it is the opposite of the rule the rest of this file follows about
 * never baking a colour in. The reason is that the host's `--lp-*` custom
 * properties cannot cross into the frame — a sandboxed document inherits no
 * cascade from its parent — so a diagram authored against a light ground, which
 * is every diagram anybody has written so far, would be dark ink on a dark
 * console. A preview is a drawing with a palette of its own, like an image, and
 * an image keeps its own background in dark mode too.
 */
export function previewDocument(html: string): string {
  return `<!doctype html>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">
<style>
html { color-scheme: light; background: #ffffff; }
/* The frame is sized by the host and clipped by it; nothing in here scrolls. */
html, body { margin: 0; padding: 0; overflow: hidden; }
body { padding: 12px; box-sizing: border-box; font-family: system-ui, -apple-system, sans-serif; }
</style>
${html}
`;
}

/**
 * A diagram, drawn by the browser, in a frame that cannot run a line of code.
 *
 * ## The threat, stated once
 *
 * **Anyone can email `<name>@context.lc`** — that is the ingestion design, not
 * a gap in it. So a note this renders may have been written by a stranger, and
 * the console it renders in holds a live authenticated Convex connection. The
 * danger was never HTML or CSS; it is script execution inside that session.
 *
 * ## The mitigation is one attribute, and it is the browser's
 *
 * A `sandbox` attribute with an empty value denies **everything** the frame
 * could otherwise do, script execution included. There is no allow-list to keep
 * current and nothing of ours to get wrong.
 *
 *  - **`allow-scripts` is never added.** It would run the note's JavaScript, in
 *    an opaque origin — which still reaches `fetch`, `postMessage` to the
 *    parent, and anything the parent listens for.
 *  - **`allow-same-origin` is never added.** Together with `allow-scripts` the
 *    two are worse than either: a frame that is same-origin *and* scripted can
 *    reach `parent.document` and remove its own `sandbox` attribute.
 *
 * `__tests__/livePreview.test.ts` asserts on the attribute; `e2e/webkit/`
 * asserts that a `<script>` in the fence does not run, which is the half jsdom
 * cannot prove — jsdom does not enforce iframe sandboxing at all, so a green
 * jsdom test about script execution would be a false green.
 *
 * ## Why `pointer-events: none` on the frame
 *
 * The frame is a separate document and swallows its own clicks. Without this
 * there is no pointer route back to the source at all: you could see the
 * diagram and never click into the fence that draws it, which is precisely the
 * "an editor that hides syntax you cannot edit" failure this file exists to
 * avoid. The preview has nothing to interact with anyway — no scripts, and a
 * link in a bare-sandbox frame cannot navigate.
 */
export class HtmlPreviewWidget extends WidgetType {
  constructor(private readonly html: string) {
    super();
  }
  /*
    Compared on the markup, and load-bearing rather than an optimisation: the
    decoration set is rebuilt on every keystroke and every cursor move, and a
    widget that reported itself new each time would tear the iframe down and
    reload its document under the reader's eyes several times a second.
  */
  eq(other: HtmlPreviewWidget): boolean {
    return other.html === this.html;
  }
  toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-lp-preview";
    const frame = document.createElement("iframe");
    frame.className = "cm-lp-preview-frame";
    /*
      The empty string is the value that denies everything. `setAttribute` with
      "" rather than a property assignment, because `frame.sandbox = ""` writes
      through a `DOMTokenList` and reads back as an empty list that is easy to
      mistake for an absent attribute in a test. The attribute is the security
      model; it is set in the plainest way there is.
    */
    frame.setAttribute("sandbox", "");
    frame.setAttribute("srcdoc", previewDocument(this.html));
    // A frame with no title is an unlabelled region to a screen reader, and
    // there is nothing inside this one it could read out instead.
    frame.setAttribute("title", "Rendered preview");
    frame.setAttribute("loading", "lazy");
    wrap.append(frame);
    return wrap;
  }
  /* A click on the preview should place the caret, which is what reveals it. */
  ignoreEvent(): boolean {
    return false;
  }
}
