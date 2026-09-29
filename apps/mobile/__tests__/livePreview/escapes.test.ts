import { describe, expect, test } from "@jest/globals";
import { visibleText } from "./fixtures";
import { parseInline } from "../../features/share/markdown";

/*
  A BACKSLASH ESCAPE IS SYNTAX, NOT A CHARACTER THE AUTHOR WANTED SHOWN.

  Reported with a screenshot of a Bible-verse callout ending "the things that
  you want\." — the kind of text a paste or another app writes, `\.` so a
  sentence-final period can never start a list. CommonMark reads `\.` as ".",
  and so do Obsidian and every published page elsewhere; this editor and the
  shared page printed the backslash.

  SABOTAGE: drop the `Escape` branch in `hiddenMarkRanges`
  and the editor cases fail; drop the escape branch in `parseInline` and the
  shared-page cases fail.
*/

const REPORTED = [
  "> [!bible] [gal 5:17 LSB](https://example.com/gal-5-17)",
  "> For the flesh sets its desire against the Spirit, so that you do not do the things that you want\\.",
].join("\n");

describe("the editor draws an escaped character as the character", () => {
  test("the reported callout: no backslash before the period", () => {
    expect(visibleText(`${REPORTED}\n\nend`, 1000)).toContain("the things that you want.");
    expect(visibleText(`${REPORTED}\n\nend`, 1000)).not.toContain("\\.");
  });

  test("every escapable punctuation mark, mid-sentence", () => {
    expect(visibleText("a \\* b \\_ c \\# d \\[e\\]\n\nend", 1000)).toBe("a * b _ c # d [e]\n\nend");
  });

  test("the caret on the escape brings the backslash back, so it can be edited", () => {
    const doc = "want\\.\n\nend";
    expect(visibleText(doc, 5)).toBe(doc);
    expect(visibleText(doc, 4)).toBe(doc);
  });

  test("a backslash before a letter is not an escape and stays", () => {
    expect(visibleText("C:\\Users\n\nend", 1000)).toBe("C:\\Users\n\nend");
  });

  test("inside inline code a backslash is literal", () => {
    expect(visibleText("run `a\\.b` now\n\nend", 1000)).toBe("run a\\.b now\n\nend");
  });
});

describe("a shared page draws an escaped character as the character", () => {
  const text = (source: string) =>
    parseInline(source)
      .map((run) => ("text" in run ? run.text : ""))
      .join("");

  test("the reported sentence", () => {
    expect(text("so that you do not do the things that you want\\.")).toBe(
      "so that you do not do the things that you want.",
    );
  });

  test("an escaped asterisk is not emphasis", () => {
    const runs = parseInline("\\*not bold\\*");
    expect(runs).toEqual([{ kind: "text", text: "*not bold*" }]);
  });

  test("a backslash before a letter stays", () => {
    expect(text("C:\\Users")).toBe("C:\\Users");
  });

  test("inside inline code a backslash is literal", () => {
    expect(parseInline("`a\\.b`")).toEqual([{ kind: "code", text: "a\\.b" }]);
  });
});
