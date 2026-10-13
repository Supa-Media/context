import { describe, expect, test } from "@jest/globals";
import { decorationsFor, stateFor } from "./fixtures";
import { darkColors, lightColors } from "../../features/design/tokens/colors";
import { themeVars } from "../../features/console/files/webview/host";
import { inlineTags } from "../../../mcp/src/lists/inlineTags.js";

/*
  #TAGS WRITTEN IN A NOTE ARE DRAWN AS TAGS.

  Reported with a screenshot of "#bible-character #expandonthis" drawn as plain
  text (the owner, 2026-10-13). The editor marks the same words lists and search
  count (`lists/inlineTags.js`), as a pill in the accent.

  SABOTAGE: drop `tagGrammar` from `markdownLanguage()` and every case that
  expects a tag fails; drop the caret rule in `decorationsFor` and "plain while
  the caret is in it" fails; let the grammar fire after any character and the
  mid-word case fails.
*/

/** The text painted as a tag, run by run. */
function tagged(doc: string, cursor = doc.length): string[] {
  const state = stateFor(doc, cursor);
  const out: string[] = [];
  decorationsFor(state).between(0, state.doc.length, (from, to, value) => {
    const spec = value.spec as { class?: string };
    if (spec.class === "cm-lp-tag") out.push(state.doc.sliceString(from, to));
  });
  return out;
}

describe("the editor draws #tags as tags", () => {
  test("the reported line", () => {
    expect(tagged("#bible-character #expandonthis\n\nend")).toEqual(["#bible-character", "#expandonthis"]);
  });

  test("anywhere in a paragraph, a list or a heading", () => {
    expect(tagged("Why split? #expandonthis now\n\n- item #todo\n\n## Heading #draft\n\nend")).toEqual([
      "#expandonthis",
      "#todo",
      "#draft",
    ]);
  });

  test("never a heading, a number, a mid-word hash, a link, a URL or code", () => {
    const doc = [
      "# Heading",
      "",
      "issue #12, C#sharp and page#top",
      "",
      "[see](#section) and <https://x.test/#frag> and https://x.test/a#b",
      "",
      "`#code` and [[note#heading]]",
      "",
      "```",
      "#fenced",
      "```",
      "",
      "end",
    ].join("\n");
    expect(tagged(doc)).toEqual([]);
  });

  test("plain while the caret is in it, so typing one shows what is typed", () => {
    const doc = "a #tag word\n\nend";
    expect(tagged(doc, 5)).toEqual([]);
    expect(tagged(doc)).toEqual(["#tag"]);
  });

  test("marks exactly the tags lists and search count", () => {
    const doc = "#one (#two) #2026 #three/ x#four #five.\n\nend";
    expect(tagged(doc).map((tag) => tag.slice(1))).toEqual(inlineTags(doc));
  });

  test("drawn in the accent, the same in both themes", () => {
    const { livePreviewStyles } = require("../../features/console/files/livePreview") as {
      livePreviewStyles: string;
    };
    const rule = /\.cm-lp-tag \{([^}]*)\}/.exec(livePreviewStyles)?.[1] ?? "";
    expect(rule).toContain("var(--lp-tag)");
    for (const colors of [darkColors, lightColors]) {
      expect(themeVars(colors, undefined, true)["--lp-tag"]).toBe(colors.accentText);
    }
  });
});
