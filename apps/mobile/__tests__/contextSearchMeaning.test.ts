/**
 * A palette row built from a search hit keeps the server's mark for a note
 * found by meaning alone, and only for that note.
 */

import { describe, expect, test } from "@jest/globals";
import { itemsFromHits } from "../features/console/files/useContextSearch";

describe("hits found by meaning", () => {
  test("carry the mark into the palette row; word hits do not", () => {
    const items = itemsFromHits([
      { path: "1-projects/plan.md", title: "Plan", snippets: ["the plan"] },
      { path: "2-areas/home/rent.md", title: "Rent", snippets: ["standing order"], meaningOnly: true },
    ]);
    expect(items.map((item) => [item.id, item.meaningOnly === true])).toEqual([
      ["1-projects/plan.md", false],
      ["2-areas/home/rent.md", true],
    ]);
    expect("meaningOnly" in items[0]!).toBe(false);
  });
});
