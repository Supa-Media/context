/**
 * @jest-environment jsdom
 */

/**
 * The handoff to the search page ("See all results") — the last row, reached
 * by wrapping ↑ from the top, and never what Enter reaches by accident.
 *
 * Split out of `paletteRender.test.ts`; see `fixtures.ts` in this folder for
 * the module-level rationale and the mounting harness these tests share.
 *
 * "See all results", and the two ways it must not break what is already here.
 *
 * The overlay is a navigator: ten rows, Enter opens the highlighted one, gone.
 * The search page is the other question — read around a subject, narrow the
 * scope, open a result and come back — and the handoff between them is one row
 * at the bottom of the list.
 *
 * A row, and not a button in the chrome, because the chrome is not on the path
 * a keyboard takes. So the assertions below are about the *list*: that the row
 * is in it, that ↑ reaches it, that Enter on it opens the page, and — the one
 * that would be silent — that Enter anywhere else still opens a note. The
 * obvious wrong implementation makes Enter always open the page, which looks
 * correct in a demo where nobody has pressed ↓.
 *
 * Sabotage: intercepting the row in `onChoose` instead of in `choose` reddens
 * "…and the note it names, not the row" alone; rendering it outside `matches`
 * reddens the two keyboard checks and leaves the click one green, which is
 * exactly the shape of the defect that motivates putting it in the list.
 *
 * There is no "Ask about…" row any more: it handed the query to the in-app
 * chat, which was removed (2026-10-10). One test below says so.
 */

import { describe, expect, test } from "@jest/globals";
import { DESKTOP, PHONE, mount } from "./fixtures";

describe("seeing all the results", () => {
  test("the row is absent with nothing to hand over to", () => {
    const palette = mount(DESKTOP);
    palette.type("note");
    expect(palette.rowLabels().join(" ")).not.toContain("See all results");
    palette.unmount();
  });

  test("and absent for an empty query, which is not a search", () => {
    const palette = mount(DESKTOP, { onSeeAll: () => {} });
    expect(palette.rowLabels().join(" ")).not.toContain("See all results");
    palette.unmount();
  });

  test("it is the last row, and the keyboard reaches it", () => {
    const seen: string[] = [];
    const palette = mount(DESKTOP, { onSeeAll: (query: string) => seen.push(query) });
    palette.type("note");

    const labels = palette.rowLabels();
    expect(labels[labels.length - 1]).toContain("See all results for “note”");

    // Up from the top row wraps onto the last one, which is the handoff.
    palette.press("ArrowUp");
    palette.press("Enter");
    expect(seen).toEqual(["note"]);
    expect(palette.chosen).toEqual([]);
    palette.unmount();
  });

  test("…and the note it names, not the row, is what Enter opens elsewhere", () => {
    const seen: string[] = [];
    const palette = mount(DESKTOP, { onSeeAll: (query: string) => seen.push(query) });
    palette.type("note");
    palette.press("Enter");

    expect(seen).toEqual([]);
    expect(palette.chosen.map((item) => item.id)).toEqual(["3-resources/notes-on-storage.md"]);
    palette.unmount();
  });

  test("with nothing matching, the handoff is the only row there is", () => {
    const seen: string[] = [];
    const palette = mount(DESKTOP, {
      onSeeAll: (query: string) => seen.push(query),
      noMatchMessage: "Nothing loaded matches that.",
    });
    palette.type("ikenna");

    // The one case where "Enter opens the search page" is unambiguously what
    // somebody meant: the overlay has failed to answer and the row is the only
    // thing under the caret.
    expect(palette.rowLabels()).toHaveLength(1);
    palette.press("Enter");
    expect(seen).toEqual(["ikenna"]);
    palette.unmount();
  });

  test("the handoff row does not silence what the overlay knows", () => {
    // The regression this exists to stop: with `onSeeAll` wired, the list is
    // never empty — the handoff is always in it — so an emptiness check over
    // `matches` retires "still being indexed", "could not be run" and the
    // caller's own `noMatchMessage`, in the one palette those three were
    // written for. The row is a way out, not an answer, and the copy is about
    // answers.
    const textFor = (state: "indexing" | "failed"): string => {
      const palette = mount(DESKTOP, {
        onSeeAll: () => {},
        search: { onQuery: () => {}, items: [], state },
        noMatchMessage: "Nothing loaded matches that.",
      });
      palette.type("ikenna");
      const text = palette.find("palette-empty")?.textContent ?? "";
      // ...and it is beside the handoff rather than instead of it.
      const labels = palette.rowLabels();
      palette.unmount();
      expect(labels.join(" ")).toContain("See all results");
      return text;
    };

    expect(textFor("indexing")).toContain("still being indexed");
    expect(textFor("failed")).toContain("could not be run");

    const palette = mount(DESKTOP, {
      onSeeAll: () => {},
      search: { onQuery: () => {}, items: [], state: "idle" },
      noMatchMessage: "Nothing loaded matches that.",
    });
    palette.type("ikenna");
    expect(palette.find("palette-empty")?.textContent).toBe("Nothing loaded matches that.");
    palette.unmount();
  });

  test("a press works too, for a thumb that has no arrow keys", () => {
    const seen: string[] = [];
    const palette = mount(PHONE, { onSeeAll: (query: string) => seen.push(query) });
    palette.type("note");
    palette.click(`palette-row-${palette.rowLabels().length - 1}`);
    expect(seen).toEqual(["note"]);
    expect(palette.chosen).toEqual([]);
    palette.unmount();
  });
});

describe("no asking instead of navigating", () => {
  test("there is no Ask row, whatever is typed", () => {
    const palette = mount(DESKTOP, { onSeeAll: () => {} });
    palette.type("what did we decide about pricing");
    expect(palette.rowLabels().join(" ")).not.toContain("Ask about");
    palette.unmount();
  });
});
