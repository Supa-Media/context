/**
 * @jest-environment jsdom
 */

/**
 * Searching the whole context, and the notice saying where the answer came
 * from.
 *
 * Split out of `paletteRender.test.ts`; see `fixtures.ts` in this folder for
 * the module-level rationale and the mounting harness these tests share.
 *
 * The palette's second half: results from asking the bucket, rather than from
 * filtering the folders somebody happened to have open.
 *
 * The failure modes these exist for are all silent:
 *
 *  - **"No matches" for a search that has not answered.** The palette knows
 *    three states in which absence is not evidence — running, still indexing,
 *    failed — and every one of them renders as "nothing matches" if the empty
 *    copy is picked from the match count alone. That is a worse lie than the
 *    honest "only folders you have opened are searched" this replaced.
 *  - **A result listed twice.** A note that is both loaded and a content hit
 *    is one note. The de-duplication is invisible until the day somebody
 *    searches for a note they already have open.
 *  - **The keyboard stopping at the local rows.** Arrows walking only the
 *    first half, with the answer to the query sitting below the last reachable
 *    row, looks exactly like a search that found nothing.
 */

import { describe, expect, test } from "@jest/globals";
import { DESKTOP, type PaletteItem, mount } from "./fixtures";

describe("the palette's whole-context search", () => {
  const HITS: PaletteItem[] = [
    { id: "2-areas/people/ikenna.md", label: "Ikenna", detail: "2-areas/people", kind: "note" },
    { id: "1-projects/hiring.md", label: "Hiring", detail: "1-projects · met Ikenna", kind: "note" },
  ];

  test("results are listed under their own heading, below what is loaded", () => {
    const palette = mount(DESKTOP, {
      search: { onQuery: () => {}, items: HITS, state: "ready" },
    });
    palette.type("note");

    // The loaded notes still rank first: they matched on their names, which is
    // what the person is looking at, and they were there with no round trip.
    const rows = palette.rowLabels();
    const at = (text: string) => rows.findIndex((row) => row.includes(text));
    expect(at("Ikenna")).toBeGreaterThan(-1);
    expect(at("Ikenna")).toBeGreaterThan(at("notes-on-storage.md"));
    expect(palette.find("palette-search-heading")?.textContent).toBe("In your notes");
  });

  test("a note that is both loaded and a search hit is listed once", () => {
    const palette = mount(DESKTOP, {
      search: {
        onQuery: () => {},
        // The same id as a loaded item, which is exactly what a search for a
        // note you already have open returns.
        items: [{ id: "0-inbox/today.md", label: "today.md", kind: "note" }],
        state: "ready",
      },
    });
    palette.type("today");

    expect(palette.rowLabels().filter((row) => row.includes("today.md"))).toHaveLength(1);
    expect(palette.find("palette-search-heading")).toBeNull();
  });

  test("the keyboard walks into the search results", () => {
    const palette = mount(DESKTOP, {
      search: { onQuery: () => {}, items: HITS, state: "ready" },
    });
    palette.type("ikenna");

    // Nothing loaded matches "ikenna", so the first row is a search hit and
    // Enter must open it — the case where the two halves are one list or the
    // palette is useless.
    palette.press("Enter");
    expect(palette.chosen).toHaveLength(1);
    expect(palette.chosen[0].id).toBe("2-areas/people/ikenna.md");
  });

  test("the query is handed to the search as it is typed", () => {
    const queries: string[] = [];
    const palette = mount(DESKTOP, {
      search: { onQuery: (query) => queries.push(query), items: [], state: "idle" },
    });
    palette.type("ike");

    // Debouncing is the caller's, so the palette must not swallow anything:
    // a palette that only reported the query on submit would make the search
    // fire once, after the person had already given up.
    expect(queries).toContain("ike");
  });

  test("an unanswered search never renders as 'nothing matches'", () => {
    // One at a time: `Modal` portals into `document.body` and every query here
    // is document-wide, so a palette left open would answer the next one's
    // assertions. See this file's header, note 2.
    const emptyTextFor = (state: "searching" | "indexing" | "failed"): string => {
      const palette = mount(DESKTOP, {
        search: { onQuery: () => {}, items: [], state },
        noMatchMessage: "Nothing loaded matches that.",
      });
      palette.type("ikenna");
      const text = palette.find("palette-empty")?.textContent ?? "";
      palette.unmount();
      return text;
    };

    expect(emptyTextFor("searching")).toContain("Searching");
    expect(emptyTextFor("indexing")).toContain("still being indexed");
    expect(emptyTextFor("indexing")).not.toContain("Nothing loaded");
    expect(emptyTextFor("failed")).toContain("could not be run");
  });

  test("with no search wired, the palette is the filter it always was", () => {
    const palette = mount(DESKTOP, { noMatchMessage: "Nothing loaded matches that." });
    palette.type("ikenna");

    expect(palette.find("palette-search-heading")).toBeNull();
    expect(palette.find("palette-empty")?.textContent).toBe("Nothing loaded matches that.");
  });
});

/**
 * An answer from the copy on the device says so, above the rows it qualifies.
 * `useContextSearch` decides the sentence; this pins that the palette draws it
 * where the first row cannot push it away, draws nothing when there is none,
 * and that a device search with no rows does not say "keep typing to search
 * the rest of this context".
 */
describe("where the answer came from", () => {
  const FOUND: PaletteItem[] = [
    { id: "2-areas/people/layomi.md", label: "Layomi", detail: "2-areas/people", kind: "note" },
  ];

  test("a notice is drawn above the list, under the device's own heading", () => {
    const palette = mount(DESKTOP, {
      search: {
        onQuery: () => {},
        items: FOUND,
        state: "ready",
        notice: "Searched the copy on this device.",
        heading: "On this device",
      },
    });
    palette.type("layomi");
    expect(palette.find("palette-search-notice")?.textContent).toBe(
      "Searched the copy on this device.",
    );
    expect(palette.find("palette-search-heading")?.textContent).toBe("On this device");
    palette.unmount();
  });

  test("nothing is drawn when the bucket answered", () => {
    const palette = mount(DESKTOP, { search: { onQuery: () => {}, items: FOUND, state: "ready" } });
    palette.type("layomi");
    expect(palette.find("palette-search-notice")).toBeNull();
    palette.unmount();
  });

  test("a device search that found nothing does not say 'keep typing'", () => {
    const palette = mount(DESKTOP, {
      noMatchMessage: "Nothing loaded matches that. Keep typing to search the rest of this context.",
      search: {
        onQuery: () => {},
        items: [],
        state: "ready",
        notice: "Searched the copy on this device.",
        emptyMessage: "Nothing on this device matches that.",
      },
    });
    palette.type("zzzzqqq");
    expect(palette.find("palette-empty")?.textContent).toBe("Nothing on this device matches that.");
    palette.unmount();
  });
});
