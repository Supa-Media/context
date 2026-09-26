/**
 * `livePreview.ts` IS A FACADE, AND THESE ARE THE PROMISES THAT MAKE IT ONE.
 *
 * The Live Preview extension was one 4,985-line file and is now a facade over
 * `features/console/files/livePreview/`. Every caller — the editor setup, the
 * webview bundle, a dozen suites — still imports `./livePreview`, so the split
 * is only safe while three things stay true, and each is checked here rather
 * than claimed in a comment:
 *
 *  - **The public surface did not move.** The facade exports exactly the value
 *    names the single file exported, no more and no fewer.
 *  - **Every CodeMirror object is still one object.** A `StateField` defined
 *    twice is two fields: a transaction that sets one leaves the other at its
 *    default, and nothing throws. So the facade's `writingTable` must be the
 *    module's, and `livePreview()` must install the same instances, in the same
 *    order, that it always did.
 *  - **Imports only point down.** A module under `livePreview/` that imported
 *    the facade — or each other in a circle — would evaluate half-initialised
 *    under one import order and fine under another.
 */

import { describe, expect, test } from "@jest/globals";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import * as facade from "../features/console/files/livePreview";
import { editorEngaged } from "../features/console/files/livePreview/engagement";
import { taskToggle } from "../features/console/files/livePreview/listWidgets";
import { writingTable } from "../features/console/files/livePreview/writingTable";

const FILES = resolve(__dirname, "..", "features", "console", "files");
const MODULES = join(FILES, "livePreview");

/** The value exports of `livePreview.ts` before it was split, sorted. */
const PUBLIC_VALUES = [
  "CalloutTitleWidget",
  "HTML_PREVIEW_TAG",
  "HtmlPreviewWidget",
  "TableGridWidget",
  "alignmentsIn",
  "calloutLabel",
  "callouts",
  "codeHighlighting",
  "completedTasks",
  "decorationsFor",
  "editorEngaged",
  "engageEditor",
  "fenceHighlightStyle",
  "focusGridCell",
  "frontmatterBlock",
  "frontmatterRange",
  "hangingIndents",
  "hiddenMarkRanges",
  "htmlPreviews",
  "listGlyphs",
  "livePreview",
  "livePreviewStyles",
  "markdownLanguage",
  "previewDocument",
  "revealUnitFor",
  "selectionTouches",
  "showTableSource",
  "stopWritingTable",
  "styleClassFor",
  "tableGrids",
  "tableLines",
  "toggleMarkerInCell",
  "writingTable",
];

describe("the facade's public surface", () => {
  test("exports exactly the values the single file exported", () => {
    expect(Object.keys(facade).sort()).toEqual(PUBLIC_VALUES);
  });
});

describe("every state object is still a single object", () => {
  test("the facade re-exports the modules' own fields, not copies", () => {
    expect(facade.writingTable).toBe(writingTable);
    expect(facade.editorEngaged).toBe(editorEngaged);
  });

  test("livePreview() installs the same instances, in the same order", () => {
    const first = facade.livePreview();
    const second = facade.livePreview();
    expect(first).toHaveLength(6);
    expect(first[0]).toBe(editorEngaged);
    expect(first[1]).toBe(writingTable);
    expect(first[5]).toBe(taskToggle);
    // Shared module-level values are shared across calls...
    for (const index of [0, 1, 5]) expect(second[index]).toBe(first[index]);
    // ...and the decorations field is created per call, as it always was.
    expect(second[4]).not.toBe(first[4]);
  });
});

describe("the stylesheet is still one sheet, in its original order", () => {
  test("the heading ladder opens it and the project-list rules close it", () => {
    const css = facade.livePreviewStyles;
    expect(css.startsWith("\n.cm-lp-h1, .cm-lp-h2, .cm-lp-h3, .cm-lp-h4, .cm-lp-h5, .cm-lp-h6 {\n")).toBe(
      true,
    );
    expect(css.endsWith("  .cm-lp-list-menu-new { height: 36px; font-size: 16px; }\n}\n")).toBe(true);
  });

  test("the slices are joined without a seam", () => {
    const css = facade.livePreviewStyles;
    // Each slice starts on a new line and ends on its last character, so a join
    // that added or dropped a newline would show up at one of these boundaries.
    for (const [before, after] of [
      [".cm-lp-h4, .cm-lp-h5, .cm-lp-h6 { font-size: 1.05em; }\n/*", "A note's metadata"],
      ["text-decoration-thickness: 1px;\n}\n/*", "AN EDITABLE table"],
      [".cm-lp-rule { color: var(--lp-muted); }\n/*", "A FORM, DRAWN"],
      [".cm-lp-form-hint { font-size: 0.85em; margin-top: 6px; }\n/*", "IMAGES IN A NOTE"],
      ["  padding: 6px 0;\n}\n/*", "A FOLDER LIST"],
      ["  .cm-lp-list-value:not(:last-child) { display: none; }\n}\n/*", "PROJECTS AND GROUPS"],
    ] as const) {
      const at = css.indexOf(before);
      expect(at).toBeGreaterThan(-1);
      expect(css.slice(at + before.length, at + before.length + 40)).toContain(after);
    }
    const order = [".cm-lp-h1 {", ".cm-lp-frontmatter {", ".cm-lp-grid {", ".cm-lp-form {", ".cm-lp-images {", ".cm-lp-list {", ".cm-lp-list-group {"];
    const positions = order.map((selector) => css.indexOf(selector));
    expect(positions.every((position) => position > -1)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});

describe("imports under livePreview/ only point down", () => {
  function sourcesUnder(directory: string): string[] {
    return readdirSync(directory).flatMap((name) => {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) return sourcesUnder(path);
      return path.endsWith(".ts") ? [path] : [];
    });
  }

  /** Local imports of one file, resolved to absolute `.ts` paths where they exist. */
  function localImports(file: string): string[] {
    const source = readFileSync(file, "utf8");
    // `from "…"` and a bare side-effect `import "…"` alike: either one evaluates
    // the target first.
    return [...source.matchAll(/^(?:import|export)\b[^;]*?"(\.{1,2}\/[^"]+)"/gms)].map((match) =>
      resolve(dirname(file), match[1]!),
    );
  }

  const files = sourcesUnder(MODULES);

  test("there is something to check", () => {
    expect(files.length).toBeGreaterThanOrEqual(15);
  });

  test("no module imports the facade", () => {
    const facadePath = join(FILES, "livePreview");
    for (const file of files) {
      expect({ file: relative(FILES, file), imports: localImports(file).includes(facadePath) }).toEqual({
        file: relative(FILES, file),
        imports: false,
      });
    }
  });

  test("the modules form no cycle", () => {
    const graph = new Map<string, string[]>();
    for (const file of files) {
      const withoutExtension = file.replace(/\.ts$/, "");
      graph.set(
        withoutExtension,
        localImports(file).filter((target) => target.startsWith(MODULES + "/")),
      );
    }
    const done = new Set<string>();
    const cycles: string[] = [];
    const visit = (node: string, path: string[]): void => {
      if (path.includes(node)) {
        cycles.push([...path.slice(path.indexOf(node)), node].map((p) => relative(MODULES, p)).join(" -> "));
        return;
      }
      if (done.has(node)) return;
      for (const next of graph.get(node) ?? []) visit(next, [...path, node]);
      done.add(node);
    };
    for (const node of graph.keys()) visit(node, []);
    expect(cycles).toEqual([]);
  });
});
