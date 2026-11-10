/**
 * The Tex page's Pages list as the app reads it (`features/tex/pages/pagesRead.ts`):
 * what the gateway answers, with anything malformed dropped.
 */
import { describe, expect, test } from "@jest/globals";
import { readPages } from "../features/tex/pages/pagesRead";

describe("the pages a chat's turns wrote", () => {
  test("keeps well formed pages in order", () => {
    expect(readPages({ pages: [{ context: "seyi", path: "trips/lisbon.page.md", title: "Lisbon", at: 5 }] })).toEqual([
      { context: "seyi", path: "trips/lisbon.page.md", title: "Lisbon", at: 5 },
    ]);
  });

  test("drops a plain note, a path that climbs, a bad workspace", () => {
    expect(
      readPages({
        pages: [
          { context: "seyi", path: "a.md", title: "A", at: 1 },
          { context: "seyi", path: "../a.page.md", title: "A", at: 1 },
          { context: "Bad Slug", path: "a.page.md", title: "A", at: 1 },
          "nope",
        ],
      }),
    ).toEqual([]);
  });

  test("a chat with no history yet has no pages; anything else is unread", () => {
    expect(readPages({ manifest: null, entries: [] })).toEqual([]);
    expect(readPages({ pages: "x" })).toBeNull();
    expect(readPages([])).toBeNull();
  });
});
