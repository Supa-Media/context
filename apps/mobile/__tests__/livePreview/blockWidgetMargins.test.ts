/**
 * @jest-environment jsdom
 */

/**
 * A BLOCK WIDGET'S ROOT NEVER CARRIES A VERTICAL MARGIN.
 *
 * CodeMirror measures a block widget by its border box, so a margin on the
 * widget's root is space on screen the editor does not know about. Every line
 * below it is then drawn lower than the editor believes, and a click or tap
 * resolves to a position above the one aimed at. On a note with a few blocks
 * the drift adds up line by line: the owner's report of 2026-09-30 was every
 * homepage footer link opening the devlog, and "my cursor wouldn't land where
 * expected when I had different blocks on the page".
 *
 * Measured in Chromium on one note holding a table, an image, an html preview,
 * a list and a join box: the drift below them was 13, 33, 49 and 59px, and
 * 0 everywhere once spacing moved into padding (or into a wrapper's padding,
 * where the root has a border or a fill to keep).
 *
 * jsdom lays nothing out, so this holds the rule on the stylesheets instead.
 *
 * Sabotage record: `margin: 0.4em 0` put back on `.cm-lp-grid` fails the first
 * test; the cast row returned without its wrapper fails the last.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "@jest/globals";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { FormWidget } from "../../features/console/files/formBlock";
import {
  decorationsFor,
  livePreviewStyles,
  markdownLanguage,
} from "../../features/console/files/livePreview";
import { CastWidget } from "../../features/console/files/livePreview/castBlock";
import { HtmlPreviewWidget } from "../../features/console/files/livePreview/htmlPreview";

/** The web editor's own sheet, read as source: it is built from theme colours at runtime. */
const WEB_SHEET = readFileSync(
  join(__dirname, "../../features/console/files/liveEditorWeb/stylesheet.ts"),
  "utf8",
);

/** The element each block widget's `toDOM` returns, by class. */
const BLOCK_WIDGET_ROOTS = [
  "cm-lp-grid",
  "cm-lp-grid-live",
  "cm-lp-images",
  "cm-lp-preview-block",
  "cm-lp-list",
  "cm-lp-cast-block",
  "cm-lp-join",
  "cm-lp-form-block",
  "cm-lp-title-note",
];

/** Every declaration block whose selector ends on `.root`, from either sheet. */
function rulesFor(root: string): string[] {
  const found: string[] = [];
  // The web sheet interpolates theme values, whose braces are not CSS.
  for (const sheet of [livePreviewStyles, WEB_SHEET.replace(/\$\{[^}]*\}/g, "x")]) {
    const rule = /([^{}]+)\{([^{}]*)\}/g;
    for (const match of sheet.matchAll(rule)) {
      const selectors = match[1]!.split(",").map((selector) => selector.trim());
      if (selectors.some((selector) => new RegExp(`(^|\\s)\\.${root}$`).test(selector))) {
        found.push(match[2]!);
      }
    }
  }
  return found;
}

describe("block widgets are measured whole", () => {
  test.each(BLOCK_WIDGET_ROOTS)("`.%s` has no vertical margin", (root) => {
    for (const body of rulesFor(root)) {
      // Comments can mention margins; only declarations count.
      const declarations = body.replace(/\/\*[\s\S]*?\*\//g, "");
      expect(declarations).not.toMatch(/(^|[\s;])margin(-top|-bottom|-block[\w-]*)?\s*:/);
    }
  });

  test("each root is styled at all, so a renamed class cannot pass by matching nothing", () => {
    for (const root of BLOCK_WIDGET_ROOTS) expect(rulesFor(root).length).toBeGreaterThan(0);
  });

  test("the bordered or filled cards are wrapped, so they keep their spacing", () => {
    const view = new EditorView({ state: EditorState.create({ doc: "" }) });
    try {
      expect(new CastWidget(3).toDOM(view).className).toBe("cm-lp-cast-block");
      expect(new HtmlPreviewWidget("<p>hi</p>").toDOM().className).toBe("cm-lp-preview-block");
      // The form's wrapper is added where the editor draws it, so ask the editor.
      const doc = ["```form", "id: f", "responses: r.md", "fields:", "  - { name: a, type: line }", "```"].join("\n");
      const state = EditorState.create({ doc, extensions: [markdownLanguage(), EditorState.readOnly.of(true)] });
      const forms: FormWidget[] = [];
      decorationsFor(state).between(0, doc.length, (_from, _to, value) => {
        const widget = (value.spec as { widget?: unknown }).widget;
        if (widget instanceof FormWidget) forms.push(widget);
      });
      expect(forms.map((form) => form.toDOM().className)).toEqual(["cm-lp-form-block"]);
    } finally {
      view.destroy();
    }
  });
});
