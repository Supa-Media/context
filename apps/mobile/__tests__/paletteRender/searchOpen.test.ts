/**
 * @jest-environment jsdom
 */

/**
 * Opening a search result is reported at its position in the list shown, once
 * per search. The palette's half: a tap on a row the search returned reports
 * that row's 1-based position; a row that was only loaded reports nothing.
 * The once-per-search rule and the row pairing live in `searchOpenReport.ts`,
 * wired here the way `useListings` wires them, so this test runs the real reporter.
 *
 * See `fixtures.ts` for the mounting harness.
 */

import { describe, expect, test } from "@jest/globals";
import { DESKTOP, type PaletteItem, mount } from "./fixtures";
import { createSearchOpenReporter } from "../../features/console/files/searchOpenReport";

const HITS: PaletteItem[] = [
  { id: "2-areas/people/ikenna.md", label: "Ikenna", detail: "2-areas/people", kind: "note" },
  { id: "1-projects/hiring.md", label: "Hiring", detail: "1-projects · met Ikenna", kind: "note" },
  { id: "1-projects/roadmap.md", label: "Roadmap", detail: "1-projects · Ikenna's", kind: "note" },
];

function wired() {
  const reported: [string, number][] = [];
  const reporter = createSearchOpenReporter({
    reportOpen: (row, position) => {
      reported.push([row, position]);
    },
    reportAgain: () => {},
  });
  // What `useListings.search` does: the search starts, and its answer's row id arrives.
  const answered = reporter.searchStarted(Date.now());
  answered("row-1");
  const palette = mount(DESKTOP, {
    search: { onQuery: () => {}, items: HITS, state: "ready" },
    onSearchOpen: (_item, position) => reporter.opened(position),
  });
  return { palette, reported, reporter };
}

describe("opening a search result reports its position", () => {
  test("tapping result #2 reports position 2 against the search's row", () => {
    const { palette, reported } = wired();
    palette.type("ikenna");
    palette.click("palette-row-1");

    expect(reported).toEqual([["row-1", 2]]);
    expect(palette.chosen.map((item) => item.id)).toEqual(["1-projects/hiring.md"]);
  });

  test("a second open of the same search reports nothing", () => {
    const { palette, reported } = wired();
    palette.type("ikenna");
    palette.click("palette-row-1");
    palette.click("palette-row-2");

    expect(reported).toEqual([["row-1", 2]]);
    // The open itself still happens: only the timing is once per search.
    expect(palette.chosen).toHaveLength(2);
  });

  test("a new search reports its own opens against its own row", () => {
    const { palette, reported, reporter } = wired();
    palette.type("ikenna");
    palette.click("palette-row-1");

    // What `useListings.search` does at the start of every search, then its answer's row arrives.
    reporter.searchStarted(Date.now() + 120_000)("row-2");
    palette.click("palette-row-0");

    expect(reported).toEqual([["row-1", 2], ["row-2", 1]]);
  });

  test("a loaded row that the search did not return is not reported", () => {
    const reported: number[] = [];
    const palette = mount(DESKTOP, {
      search: { onQuery: () => {}, items: [], state: "ready" },
      onSearchOpen: (_item, position) => reported.push(position),
    });
    palette.type("today");
    palette.click("palette-row-0");

    expect(reported).toEqual([]);
    expect(palette.chosen).toHaveLength(1);
  });
});
