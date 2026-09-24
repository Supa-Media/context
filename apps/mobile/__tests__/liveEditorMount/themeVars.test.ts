/**
 * @jest-environment jsdom
 */

import { describe, expect, test } from "@jest/globals";
import { mount } from "./fixtures";

/**
 * THE PALETTE THIS HALF DECLARES AND THE PALETTE ITS STYLES READ ARE THE SAME
 * SET.
 *
 * Everything drawn inside the editor names its colours as `--lp-*` custom
 * properties rather than as values, because the identical rules run inside the
 * iOS WebView where the palette arrives over a bridge (`webview/host.ts`'s
 * `themeVars`). That only works while both hosts declare the whole set.
 *
 * The bug this exists to stop shipped, and shipped invisibly: `--lp-content`
 * and `--lp-body` were declared by the guest and not by this half. An unknown
 * custom property makes its *whole declaration* invalid at computed-value time
 * — it is not an error and it is not a fallback to something sensible — so
 * `color: var(--lp-content)` silently became `inherit`, and CodeMirror's own
 * base theme (`li[aria-selected] { background: #17c; color: white }`) won the
 * completion list instead. That is white ink on the light ground, in a
 * dropdown, on the surface most people use. On a phone it was correct the whole
 * time, which is why looking at the app never found it.
 *
 * So this asserts the relationship rather than the two lists: mount the editor,
 * read every stylesheet actually in the document, and require that every
 * property any of them *reads* is one `ensureStyles` *declares*. A rule added
 * later that reaches for `--lp-danger` fails here rather than in a screenshot.
 */
describe("every --lp-* the editor's styles read is one this half declares", () => {
  /**
   * The `--lp-*` properties the **base** `.cm-lp-root` rule declares.
   *
   * Deliberately not "declared anywhere in the sheet". The compact media query
   * re-declares `--lp-content` at the phone measure, and counting that would
   * let a property that exists only inside the query pass this test while being
   * undefined at every width above the breakpoint — which is the desktop
   * console, which is where the bug was reported. The first `.cm-lp-root {` in
   * the sheet is the unconditional one; brace-matching from it takes that block
   * and nothing nested after it.
   */
  function declaredIn(css: string): Set<string> {
    const open = css.indexOf(".cm-lp-root {");
    if (open === -1) return new Set();
    let depth = 0;
    let end = open;
    for (let at = css.indexOf("{", open); at < css.length; at += 1) {
      if (css[at] === "{") depth += 1;
      else if (css[at] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = at;
          break;
        }
      }
    }
    const block = css.slice(open, end);
    return new Set([...block.matchAll(/(--lp-[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  }

  /** The `--lp-*` properties read by `var()` anywhere in a block of CSS. */
  function readIn(css: string): Set<string> {
    return new Set([...css.matchAll(/var\(\s*(--lp-[a-z0-9-]+)/g)].map((m) => m[1]));
  }

  /**
   * Every stylesheet in the document, as text.
   *
   * CodeMirror's `EditorView.theme` goes in through `style-mod`, which may use
   * `insertRule` rather than `textContent` — so both are read. Taking them out
   * of the live document rather than importing the modules is the point: a
   * theme this file forgot to import would be a hole in the guard, and a theme
   * the editor really mounts cannot be.
   */
  function stylesheetsInDocument(): string {
    const sheets: string[] = [];
    for (const element of [...document.querySelectorAll("style")]) {
      const text = element.textContent ?? "";
      if (text !== "") {
        sheets.push(text);
        continue;
      }
      const sheet = (element as HTMLStyleElement).sheet;
      if (sheet === null) continue;
      try {
        for (const rule of [...sheet.cssRules]) sheets.push(rule.cssText);
      } catch {
        // A stylesheet jsdom will not enumerate is one this guard skips rather
        // than fails on; the interesting ones are all readable.
      }
    }
    return sheets.join("\n");
  }

  test("nothing reads a property that was never set", () => {
    const m = mount({ value: "# note\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n", editable: true });

    const ours = document.getElementById("context-live-preview-styles");
    expect(ours).not.toBeNull();
    const declared = declaredIn(ours?.textContent ?? "");

    // The four the bug was about, named so a regression says which is missing
    // rather than only that one is.
    for (const property of ["--lp-content", "--lp-bg", "--lp-body", "--lp-mono"]) {
      expect([...declared]).toContain(property);
    }

    const missing = [...readIn(stylesheetsInDocument())].filter(
      (property) => !declared.has(property),
    );
    expect(missing).toEqual([]);

    m.unmount();
  });

  /**
   * The completion list is the surface the bug was reported on, so it is named
   * rather than left to the sweep above: it is themed by `linkComplete.ts`,
   * which is a different file from the one that declares the palette, and that
   * distance is the whole reason the two drifted.
   */
  test("including the completion list, which is themed in another file", () => {
    const m = mount({ value: "x", editable: true });
    const declared = declaredIn(
      document.getElementById("context-live-preview-styles")?.textContent ?? "",
    );

    const completion = stylesheetsInDocument()
      .split("\n")
      .filter((line) => line.includes("tooltip-autocomplete") || line.includes("cm-completion"))
      .join("\n");
    // If this is empty the guard below proves nothing — the theme did not mount.
    expect(completion).not.toBe("");

    for (const property of readIn(completion)) expect([...declared]).toContain(property);
    m.unmount();
  });

  /**
   * The reading measure is a `--lp-*` like any other, so it is subject to the
   * sweep above — but it is the first one that is not a colour or a face, and
   * a missing colour is at least visible. A missing *measure* is a note that
   * still looks fine and reads at 150 characters a line, which is the failure
   * this whole change exists to stop, so it is named here too.
   */
  test("including the reading measure, which the iOS host also has to send", () => {
    const m = mount({ value: "# note\n\nprose\n", editable: true });
    const declared = declaredIn(
      document.getElementById("context-live-preview-styles")?.textContent ?? "",
    );
    expect([...declared]).toContain("--lp-measure");
    m.unmount();
  });
});

/**
 * THE NOTE IS A COLUMN, NOT THE WIDTH OF THE WINDOW.
 *
 * Measured in Chromium at 1440x900 before this existed: the element holding
 * the first sentence of the console's own demo note was 1160px wide, with
 * `max-width: none` on every one of its first eight ancestors — about 150
 * characters to a line, twice a comfortable measure. It survived because the
 * fixture note was hard-wrapped in `placeholderData.ts`, so every screenshot
 * showed a tidy column that the layout had nothing to do with.
 *
 * jsdom does not lay anything out, so these assert the *rules* and
 * `e2e/webkit/readingMeasure.spec.ts` asserts the rendered result in a real
 * engine at both viewports. Both are needed: a rule that is present and does
 * not bind is exactly what was there before.
 */
describe("the rendered note has a reading measure", () => {
  /**
   * One rule's declarations, by its selector, out of the mounted stylesheet.
   *
   * Comments are stripped rather than left in: these rules carry long ones,
   * and a test asserting a property is *absent* would otherwise be satisfied
   * or defeated by prose about it.
   */
  function block(selector: string): string {
    const css = (
      document.getElementById("context-live-preview-styles")?.textContent ?? ""
    ).replace(/\/\*[\s\S]*?\*\//g, "");
    const at = css.indexOf(`${selector} {`);
    if (at === -1) return "";
    return css.slice(at, css.indexOf("}", at));
  }

  test("the column is measured and centred, and it is the column rather than the line", () => {
    const m = mount({ value: "# note\n\nprose\n", editable: true });

    const content = block(".cm-lp-root .cm-content");
    expect(content).toContain(
      "padding-inline: max(0px, calc((100% - var(--lp-measure) * 1em) / 2))",
    );

    /*
      The unit is added HERE and not where the property is declared. A
      font-relative length inside a custom property may be resolved at the
      declaring element or at the using one, and engines differ — and the
      wrapper this is declared on is Times New Roman at 16px while the note is
      a sans at 14.5px, so the two answers are different lengths. Shipped as
      `62ch`, that read 75 characters a line in Chromium and 91 in WebKit on
      the same runner.
    */
    expect(block(".cm-lp-root")).toMatch(/--lp-measure:\s*\d+;/);

    /*
      Padding rather than `max-width: var(--lp-measure); margin-inline: auto`,
      which draws the identical column. Measured in Chromium: the max-width
      recipe leaves `.cm-content` 572px wide inside a 1192px pane, and a click
      in the 310px either side lands on `.cm-scroller` and does not focus the
      editor — half the note's apparent area stops being the editing surface.
      With padding the element stays full width, so CodeMirror still maps a
      click in the margin to the nearest position.
    */
    expect(content).not.toContain("max-width");

    /*
      On `.cm-content` rather than on `.cm-line`: a table, a form and a
      rendered diagram are block children of the same element, and measuring
      the lines alone would leave each of those starting at a different left
      edge from the paragraph above it. If a future edit moves the constraint
      down to the line, this is the test that should have to be deleted
      deliberately.
    */
    expect(block(".cm-lp-root .cm-line")).not.toContain("max-width");

    m.unmount();
  });

  /**
   * WHAT IS ALLOWED TO BE WIDER THAN THE PROSE: nothing.
   *
   * A table is the case with a real argument on the other side — twelve
   * columns in 68 characters is cramped — and it still loses, because a block
   * wider than the text it sits between has to start left of that text, and a
   * document with two left edges reads as broken layout rather than as a wide
   * table. What a wide table gets instead is its own horizontal scroller, so
   * it stays inside the column and the note never scrolls sideways as a whole.
   */
  test("a table wider than the measure scrolls inside the column rather than widening it", () => {
    const m = mount({
      value: "# note\n\n| a | b | c |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n",
      editable: false,
    });

    // The rendered grid really is on screen: without this the rules below are
    // about a selector nothing matches.
    expect(document.querySelectorAll(".cm-lp-grid").length).toBeGreaterThan(0);

    expect(block(".cm-lp-grid")).toContain("overflow-x: auto");
    // And the table inside it is sized by its content up to the column's own
    // width — never past it, which is what would drag the column open.
    expect(block(".cm-lp-grid-table")).toContain("max-width: 100%");

    m.unmount();
  });
});
