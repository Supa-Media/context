import { describe, expect, test } from "@jest/globals";
import { queryWords, reasonFor } from "../features/console/layout/everywhereSearch";
import { previewBlocks, withoutTitle } from "../features/console/layout/NotePreview";
import {
  RICH_POINTER_ROW_HEIGHT,
  editedLabel,
  metaLine,
  rowHeight,
  rowTop,
  wordRuns,
} from "../features/design/components/PaletteResultRow";
import { POINTER_ROW_HEIGHT, TOUCH_ROW_HEIGHT } from "../features/design/components/PaletteRow";
import type { PaletteItem } from "../features/console/files/palette";

/**
 * ⌘K's answers say why (board B1, leadership weekly 2026-10-17). "Has your
 * words" could not tell a note with every word from one with a single word,
 * and that is the ranking: the reason counts. These pin the counting, the
 * bolding, the dates and the arithmetic the list scrolls by.
 */

describe("the reason counts words", () => {
  test("a name hit and a meaning hit keep their plain reasons", () => {
    expect(reasonFor("rent plan", { title: "Rent plan 2026" })).toBe("In the name");
    expect(reasonFor("rent plan", { title: "Lease", meaningOnly: true })).toBe("Same topic, different words");
  });

  test("a strict hit has every word, said as a number", () => {
    expect(reasonFor("launch pricing plan", { title: "Board notes" })).toBe("Has all 3 words");
  });

  test("a loose hit says how many of the words it has, counted where they show", () => {
    expect(reasonFor("launch pricing plan", { title: "Board notes", snippet: "the launch pricing", loose: true })).toBe(
      "Has 2 of 3 words",
    );
  });

  test("a loose hit is never none and never all, since the index said it was some", () => {
    expect(reasonFor("launch pricing plan", { title: "Board notes", loose: true })).toBe("Has 1 of 3 words");
    expect(
      reasonFor("launch pricing plan", { title: "Board notes", snippet: "launch pricing plan", loose: true }),
    ).toBe("Has 2 of 3 words");
  });

  test("one word is 'your word', and short or repeated words count once or not at all", () => {
    expect(reasonFor("pricing", { title: "Board notes" })).toBe("Has your word");
    expect(queryWords("a to the Plan plan")).toEqual(["the", "plan"]);
  });
});

describe("the words typed are bold where they appear", () => {
  test("a word starting like one typed is marked whole, and the rest is not", () => {
    expect(wordRuns("Avocados and plans", ["avocado"])).toEqual([
      { text: "Avocados", matched: true },
      { text: " and plans", matched: false },
    ]);
  });

  test("one- and two-letter words mark nothing, and empty text is no runs", () => {
    expect(wordRuns("to be or not", ["to", "or"])).toEqual([{ text: "to be or not", matched: false }]);
    expect(wordRuns("", ["plan"])).toEqual([]);
  });

  test("the runs put back exactly the text they were cut from", () => {
    const text = "Pricing — plan, the PLAN; planning!";
    expect(
      wordRuns(text, ["plan"])
        .map((run) => run.text)
        .join(""),
    ).toBe(text);
  });
});

describe("when a note was last written", () => {
  const now = new Date(2026, 9, 17, 15, 0).getTime();
  test("today, yesterday, a date this year, a date with its year", () => {
    expect(editedLabel(new Date(2026, 9, 17, 0, 5).getTime(), now)).toBe("edited today");
    expect(editedLabel(new Date(2026, 9, 16, 23, 59).getTime(), now)).toBe("edited yesterday");
    expect(editedLabel(new Date(2026, 8, 12).getTime(), now)).toBe("edited Sep 12");
    expect(editedLabel(new Date(2025, 8, 12).getTime(), now)).toBe("edited Sep 12, 2025");
  });

  test("the row's last line is where, then when, and where alone without a date", () => {
    const item: PaletteItem = { id: "a.md", label: "A", kind: "note", detail: "@acme · Projects" };
    expect(metaLine({ ...item, edited: new Date(2026, 8, 12).getTime() }, now)).toBe("@acme · Projects · edited Sep 12");
    expect(metaLine(item, now)).toBe("@acme · Projects");
  });
});

describe("the list scrolls by arithmetic", () => {
  const answer: PaletteItem = { id: "a.md", label: "A", kind: "note", workspace: { slug: "acme", current: true } };
  const command: PaletteItem = { id: "new", label: "New note", kind: "command" };

  test("an answer is a tall row and everything else keeps its height", () => {
    expect(rowHeight(answer, false)).toBe(RICH_POINTER_ROW_HEIGHT);
    expect(rowHeight(command, false)).toBe(POINTER_ROW_HEIGHT);
    expect(rowHeight(command, true)).toBe(TOUCH_ROW_HEIGHT);
  });

  test("a row starts where the rows above it end", () => {
    const items = [answer, command, answer];
    expect(rowTop(items, 0, false)).toBe(0);
    expect(rowTop(items, 2, false)).toBe(RICH_POINTER_ROW_HEIGHT + POINTER_ROW_HEIGHT);
    expect(rowTop(items, 99, false)).toBe(2 * RICH_POINTER_ROW_HEIGHT + POINTER_ROW_HEIGHT);
  });
});

describe("the preview is the note's words, not its Markdown", () => {
  test("front matter goes, headings stay headings, marks and link targets go", () => {
    const blocks = previewBlocks(
      "---\nstatus: active\n---\n# Plan\n\nOne **tier** at `launch`.\n\n- [x] Done\n- [[Partner list|The partners]] and [site](https://example.com)\n",
    );
    expect(blocks).toEqual([
      { heading: true, text: "Plan" },
      { heading: false, text: "One tier at launch." },
      { heading: false, text: "• Done" },
      { heading: false, text: "• The partners and site" },
    ]);
  });

  test("a long note is a screen of it, never the whole", () => {
    const blocks = previewBlocks(Array.from({ length: 40 }, (_, index) => `Line ${index} ${"x".repeat(200)}`).join("\n"));
    expect(blocks.length).toBeLessThanOrEqual(14);
    expect(blocks.reduce((sum, block) => sum + block.text.length, 0)).toBeLessThanOrEqual(1401);
    expect(blocks[blocks.length - 1]!.text.endsWith("…")).toBe(true);
  });
});

describe("the preview does not say the title twice", () => {
  test("a first heading that is the title, or the start of it, goes", () => {
    const blocks = [
      { heading: true, text: "Pricing plan for the spring launch" },
      { heading: false, text: "One tier." },
    ];
    expect(withoutTitle(blocks, "Pricing plan for the spring launch and the partner programme")).toEqual([blocks[1]]);
    expect(withoutTitle(blocks, "pricing plan for the spring launch")).toEqual([blocks[1]]);
  });

  test("a first heading that says something else, or a first line, stays", () => {
    const heading = [{ heading: true, text: "Partners" }];
    const line = [{ heading: false, text: "Pricing plan for the spring launch" }];
    expect(withoutTitle(heading, "Pricing plan")).toEqual(heading);
    expect(withoutTitle([{ heading: true, text: "Planning ahead" }], "Plan")).toEqual([{ heading: true, text: "Planning ahead" }]);
    expect(withoutTitle(line, "Pricing plan for the spring launch")).toEqual(line);
  });
});
