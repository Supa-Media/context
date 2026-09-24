import { describe, expect, test } from "@jest/globals";
import {
  decorationsFor,
  frontmatterRange,
  htmlPreviews,
  HtmlPreviewWidget,
  livePreviewStyles,
  previewDocument,
  stateFor,
} from "./fixtures";

/* -------------------------------------------------------------------------- */

/**
 * A FENCE TAGGED `html-preview` IS DRAWN AS THE THING IT DESCRIBES.
 *
 * The convention is the tag and nothing else: no new file format, no
 * frontmatter switch, no per-note setting. A note carrying a diagram is still a
 * plain Markdown file that `cat`, GitHub and Obsidian all show as a labelled
 * code block.
 *
 * **Everything in this block is about one attribute.** Anyone can email
 * `<name>@context.lc`, so a note this renders may have been written by a
 * stranger — and the console it renders in holds a live authenticated Convex
 * connection. A bare `sandbox` is what stops the markup being code, and it is
 * the browser's guarantee rather than one of ours. The cases below assert on
 * the attribute because it is the whole security model; `e2e/webkit/` asserts
 * that a script in the fence actually fails to run, which is the part jsdom
 * cannot prove — it does not enforce iframe sandboxing at all, so a passing
 * jsdom test there would be a false green.
 */
describe("html-preview fences", () => {
  const DIAGRAM = [
    "# Map",
    "",
    "```html-preview",
    '<div class="box">drawn</div>',
    "```",
    "",
    "after",
  ].join("\n");

  /** Every preview widget the real decoration set carries, in document order. */
  function widgetsIn(doc: string, cursor = 10_000): HtmlPreviewWidget[] {
    const state = stateFor(doc, cursor);
    const found: HtmlPreviewWidget[] = [];
    decorationsFor(state).between(0, state.doc.length, (_from, _to, value) => {
      const spec = value.spec as { widget?: unknown };
      if (spec.widget instanceof HtmlPreviewWidget) found.push(spec.widget);
    });
    return found;
  }

  test("the fence's own body is what gets rendered, without its fence lines", () => {
    const previews = htmlPreviews(stateFor(DIAGRAM, 10_000));
    expect(previews).toHaveLength(1);
    expect(previews[0]!.html).toBe('<div class="box">drawn</div>');
  });

  /**
   * Opting in is the entire convention. A plain HTML block in somebody's note
   * — a snippet they are quoting, a fragment they are debugging — must stay a
   * code block, or every note that talks about HTML starts executing it.
   */
  /**
   * Every fixture here ends in a line of prose, and that line is load-bearing.
   *
   * The caret is parked at the end of the document to say "not in the fence",
   * and `selectionTouches` is inclusive at both ends — so a document that *is*
   * the fence leaves nowhere to stand, the reveal rule fires, and a test
   * asserting "this tag does not render" passes for the wrong reason. It did:
   * the first version of the two cases below went green against an
   * implementation that rendered every fence in the file, whatever its tag.
   */
  const afterFence = (tag: string, body = "<div>x</div>") =>
    ["```" + tag, body, "```", "", "after"].join("\n");

  test("a fence tagged `html` is not a preview", () => {
    const plain = afterFence("html", "<div>quoted</div>");
    expect(htmlPreviews(stateFor(plain, 10_000))).toEqual([]);
    expect(widgetsIn(plain)).toEqual([]);
  });

  test("neither is any other tag, nor an untagged fence", () => {
    for (const tag of ["", "js", "css", "htmlpreview", "html-previews", "preview", "HTML"]) {
      expect(htmlPreviews(stateFor(afterFence(tag), 10_000))).toEqual([]);
    }
  });

  test("the tag itself is what decides, and it is matched whole", () => {
    // The positive control for the two cases above: the same fixture shape,
    // the only difference being the tag, renders. Without this a check that
    // rendered nothing at all would pass every negative case here.
    expect(htmlPreviews(stateFor(afterFence("html-preview"), 10_000))).toHaveLength(1);
    // Case-insensitively, and with a second word after it — a fence written
    // ```` ```HTML-Preview title=… ```` is still the author opting in.
    expect(htmlPreviews(stateFor(afterFence("HTML-Preview"), 10_000))).toHaveLength(1);
    expect(htmlPreviews(stateFor(afterFence("html-preview wide"), 10_000))).toHaveLength(1);
  });

  /* ---------------------------------------------------------------------- */

  /**
   * The other half of the sandbox, and it is not about code at all.
   *
   * CSS alone can fetch — a background image, a webfont — and a fetch from a
   * note somebody emailed you is a read receipt on a document you did not ask
   * for. `default-src 'none'` is what stops it; `img-src data:` is what still
   * lets a diagram carry its own inline artwork.
   */
  test("the frame's document carries a CSP that permits no network at all", () => {
    const doc = previewDocument("<div>x</div>");
    expect(doc).toContain("default-src 'none'");
    expect(doc).toContain("style-src 'unsafe-inline'");
    expect(doc).toContain("img-src data:");
    // No `https:`, no `*`, and no scheme a stylesheet could reach out over.
    expect(doc).not.toMatch(/(?:img|font|default)-src[^;"]*https?:/);
  });

  test("the fence's content is inside that document, unaltered", () => {
    // Not sanitized, not escaped, not rewritten. The browser is the boundary —
    // a filter of ours would be a second mechanism nobody tests.
    const html = '<div class="cmap" style="--x:1">a &amp; b</div>';
    expect(previewDocument(html)).toContain(html);
  });

  /* ---------------------------------------------------------------------- */

  /**
   * The Live Preview rule, which this file argues for at length: you cannot
   * edit syntax you cannot see. A drawn diagram must become its own fence
   * again the moment the caret enters it, exactly as `## Heading` does.
   */
  test("the caret entering the block gives the raw fence back", () => {
    const at = DIAGRAM.indexOf('<div class="box">');
    expect(htmlPreviews(stateFor(DIAGRAM, at))).toEqual([]);
    expect(widgetsIn(DIAGRAM, at)).toEqual([]);
  });

  test("and a caret on either boundary counts as inside", () => {
    const from = DIAGRAM.indexOf("```html-preview");
    const to = from + "```html-preview\n<div class=\"box\">drawn</div>\n```".length;
    expect(htmlPreviews(stateFor(DIAGRAM, from))).toEqual([]);
    expect(htmlPreviews(stateFor(DIAGRAM, to))).toEqual([]);
  });

  test("a caret elsewhere in the note leaves it drawn", () => {
    expect(htmlPreviews(stateFor(DIAGRAM, 2))).toHaveLength(1);
  });

  /* ---------------------------------------------------------------------- */

  test("the rendered block replaces whole lines and nothing else is drawn inside it", () => {
    const state = stateFor(DIAGRAM, 10_000);
    const preview = htmlPreviews(state)[0]!;
    expect(state.doc.lineAt(preview.from).from).toBe(preview.from);
    expect(state.doc.lineAt(preview.to).to).toBe(preview.to);

    // No `cm-lp-fence`, and no hidden CodeMark ranges, inside a range the
    // widget has already replaced — overlapping a block replacement with the
    // decorations it swallowed is a range-set error waiting for the one note
    // that has both.
    const inside: string[] = [];
    decorationsFor(state).between(preview.from, preview.to, (from, _to, value) => {
      const spec = value.spec as { class?: string; widget?: unknown };
      if (spec.widget instanceof HtmlPreviewWidget) return;
      if (from >= preview.from && from < preview.to) inside.push(spec.class ?? "replace");
    });
    expect(inside).toEqual([]);
  });

  test("a fence nobody can replace cleanly is left as text", () => {
    // Indented inside a list item: the fence does not start at the margin, so a
    // block widget cannot stand in for whole lines. An honest code block beats
    // a widget that eats half a list.
    const nested = ["- item", "  ```html-preview", "  <div>x</div>", "  ```"].join("\n");
    expect(htmlPreviews(stateFor(nested, 10_000))).toEqual([]);
  });

  test("an empty preview fence draws nothing", () => {
    const empty = ["```html-preview", "```"].join("\n");
    expect(htmlPreviews(stateFor(empty, 10_000))).toEqual([]);
  });

  test("an unterminated preview fence still draws what it has", () => {
    /*
      The state every fence passes through while somebody is typing one, and it
      needs a line above it to be observable at all: an unterminated fence runs
      to the end of the document, so the only caret positions left are inside
      it, where the reveal rule correctly shows the source.
    */
    const open = ["# Title", "", "```html-preview", "<div>x</div>"].join("\n");
    const previews = htmlPreviews(stateFor(open, 0));
    expect(previews).toHaveLength(1);
    expect(previews[0]!.html).toBe("<div>x</div>");
  });

  test("nothing inside the frontmatter is ever a preview", () => {
    // The same rule every other pass in this file follows: metadata is drawn as
    // metadata. A `---` block that happens to contain a fence is still YAML.
    const doc = ["---", "```html-preview", "<div>x</div>", "```", "---", "", "# Title"].join("\n");
    const state = stateFor(doc, 10_000);
    const front = frontmatterRange(doc);
    expect(front).not.toBeNull();
    expect(htmlPreviews(state, front!.to)).toEqual([]);
  });

  test("two previews in one note are two widgets", () => {
    const doc = [DIAGRAM, "", "```html-preview", "<p>second</p>", "```", "", "end"].join("\n");
    expect(htmlPreviews(stateFor(doc, 10_000))).toHaveLength(2);
    expect(widgetsIn(doc)).toHaveLength(2);
  });

  /**
   * Widget identity, and it is load-bearing rather than an optimisation: the
   * decoration set is rebuilt on every keystroke and every cursor move, and a
   * widget that reported itself new each time would tear the iframe down and
   * reload the document under the reader's eyes several times a second.
   */
  test("an unchanged preview is the same widget", () => {
    const [a] = widgetsIn(DIAGRAM, 2);
    const [b] = widgetsIn(DIAGRAM, 5);
    expect(a!.eq(b!)).toBe(true);
  });

  test("a changed preview is not", () => {
    const other = DIAGRAM.replace("drawn", "redrawn");
    expect(widgetsIn(DIAGRAM)[0]!.eq(widgetsIn(other)[0]!)).toBe(false);
  });

  /* ---------------------------------------------------------------------- */

  test("a click on the frame reaches the editor, so the block can reveal itself", () => {
    // The frame is a separate document and swallows its own clicks. Without
    // `pointer-events: none` on it there is no way to get the source back with
    // a pointer at all — the one interaction the reveal rule is about.
    expect(livePreviewStyles).toMatch(/\.cm-lp-preview-frame\b[^}]*pointer-events:\s*none/s);
    const widget = widgetsIn(DIAGRAM)[0]!;
    expect(widget.ignoreEvent()).toBe(false);
  });

  test("the widget it builds is the preview widget, and it is the only widget here", () => {
    // `htmlPreviewFrame.test.ts` mounts this one and reads the attribute that
    // is the whole security model; it runs under jsdom, which this file
    // deliberately does not.
    expect(widgetsIn(DIAGRAM)).toHaveLength(1);
    expect(widgetsIn(DIAGRAM)[0]).toBeInstanceOf(HtmlPreviewWidget);
  });

  test("the box is clipped, so a layout cannot draw over the console", () => {
    expect(livePreviewStyles).toMatch(/\.cm-lp-preview\b[^}]*overflow:\s*hidden/s);
    expect(livePreviewStyles).toMatch(/\.cm-lp-preview-frame\b[^}]*max-height/s);
  });

  test("a note mixing a preview with every other construct still builds", () => {
    const doc = [
      "---",
      "updated: 2026-09-11",
      "---",
      "",
      "# Title",
      "",
      "- [ ] a task with **bold** and [a link](x.md)",
      "",
      "```html-preview",
      "<div>drawn</div>",
      "```",
      "",
      "```js",
      "const x = 1;",
      "```",
      "",
      "| a | b |",
      "| --- | --- |",
      "| 1 | 2 |",
    ].join("\n");
    expect(() => decorationsFor(stateFor(doc, 10_000))).not.toThrow();
    expect(() => decorationsFor(stateFor(doc, 0))).not.toThrow();
    expect(() => decorationsFor(stateFor(doc, [0, doc.length]))).not.toThrow();
  });
});
