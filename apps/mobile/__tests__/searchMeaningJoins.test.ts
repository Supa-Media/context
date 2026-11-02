/**
 * The words half drawn first, the meaning half joining below it (the search
 * tune-up, Dev2's pick, 2026-10-27; board M2), as `withMeaningRows` decides.
 *
 * Sabotage record (temporary local edits, reverted, as measured):
 *   meaning rows put before the words   → "nothing already drawn moves" fails
 *   the `close` rule dropped            → "a weak topic match stays out…" fails
 *   the `close` rule applied always     → "when the words found nothing…" fails
 */

import { describe, expect, test } from "@jest/globals";
import { withMeaningRows, type BlendedResult } from "../features/console/search/results";

const row = (path: string, extra: Partial<BlendedResult> = {}): BlendedResult => ({
  workspaceId: "ws1",
  slug: "supa",
  displayName: "Supa",
  path,
  title: path,
  snippet: "",
  ...extra,
});

describe("meaning joins the words", () => {
  test("nothing already drawn moves, and a note the words found is not repeated", () => {
    const words = [row("a.md"), row("b.md")];
    const joined = withMeaningRows(words, [row("b.md", { meaningOnly: true, close: true }), row("c.md", { meaningOnly: true, close: true })]);
    expect(joined.map((r) => r.path)).toEqual(["a.md", "b.md", "c.md"]);
    expect(joined[2]?.meaningOnly).toBe(true);
  });

  test("a weak topic match stays out once the words found notes with every word", () => {
    const joined = withMeaningRows([row("a.md")], [row("weak.md", { meaningOnly: true, close: false }), row("close.md", { meaningOnly: true, close: true })]);
    expect(joined.map((r) => r.path)).toEqual(["a.md", "close.md"]);
  });

  test("when the words found nothing, or only some of the words, every meaning row joins", () => {
    const meaning = [row("weak.md", { meaningOnly: true, close: false })];
    expect(withMeaningRows([], meaning).map((r) => r.path)).toEqual(["weak.md"]);
    expect(withMeaningRows([row("a.md", { loose: true })], meaning).map((r) => r.path)).toEqual(["a.md", "weak.md"]);
  });

  test("the same path in another workspace is another note", () => {
    const joined = withMeaningRows([row("a.md")], [row("a.md", { workspaceId: "ws2", meaningOnly: true, close: true })]);
    expect(joined.length).toBe(2);
  });
});
