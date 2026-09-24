/**
 * @jest-environment jsdom
 */

/**
 * The handoff to the search page ("See all results") and the handoff to the
 * agent ("Ask about…") — both last rows, both reached by wrapping ↑ from the
 * top, and both must never be what Enter reaches by accident.
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
 * "Ask about…", and the one thing it must never do.
 *
 * The palette is a navigator first. Somebody typing `pricing` almost always
 * wants the note, and a row that answers a question costs a model call, several
 * seconds and somebody's money — so it must never be what Enter reaches by
 * accident. **The ordering is the whole guard**: the cursor rests on the first
 * row, this is the last one, and the tests below are about that rather than
 * about the row's copy.
 *
 * The case where an answer is the right default — nothing matched — needs no
 * rule of its own, and the test for it says why: the two handoffs are then the
 * only rows, `See all` is still first, and somebody who wanted an answer
 * presses ↓ once.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. The two handoff rows swapped, so Ask comes before See all.
 *     → **2 fail**: `with nothing matching, search is still what Enter
 *     reaches` and `it is the last row of all`.
 *  2. `askItem` returning a row for an empty query.
 *     → **1 fails**: `absent for an empty query, which is not a question`.
 *  3. The `ASK_ID` arm added to `onChoose` instead of to `choose`, which is
 *     the shape the `See all` record already names for its own row.
 *     → **1 fails**: `the note it names, not the row, is what Enter opens
 *     elsewhere` — the *existing* one, which is the useful part: a second
 *     handoff intercepted in the wrong place breaks the first one's guarantee
 *     rather than its own.
 */

import { describe, expect, test } from "@jest/globals";
import { act } from "react";
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

describe("asking instead of navigating", () => {
  test("the row is absent with nobody to ask", () => {
    const palette = mount(DESKTOP);
    palette.type("note");
    expect(palette.rowLabels().join(" ")).not.toContain("Ask about");
    palette.unmount();
  });

  test("absent for an empty query, which is not a question", () => {
    const palette = mount(DESKTOP, { onAsk: () => {} });
    expect(palette.rowLabels().join(" ")).not.toContain("Ask about");
    palette.unmount();
  });

  test("it is the last row of all", () => {
    const palette = mount(DESKTOP, { onAsk: () => {}, onSeeAll: () => {} });
    palette.type("note");

    const labels = palette.rowLabels();
    expect(labels[labels.length - 1]).toContain("Ask about “note”");
    // ...and search is the row above it, not below.
    expect(labels[labels.length - 2]).toContain("See all results");
    palette.unmount();
  });

  test("the keyboard reaches it, and hands over what was typed", () => {
    const asked: string[] = [];
    const palette = mount(DESKTOP, { onAsk: (query: string) => asked.push(query) });
    palette.type("what did we decide about pricing");

    // Up from the top wraps onto the last row, which is this one.
    palette.press("ArrowUp");
    palette.press("Enter");

    expect(asked).toEqual(["what did we decide about pricing"]);
    expect(palette.chosen).toEqual([]);
    palette.unmount();
  });

  /**
   * The guard, stated as the thing that would be silent. An implementation
   * that made Enter always ask looks correct in a demo where nobody has
   * pressed ↓ — and costs a model call on every note somebody opens.
   */
  test("Enter on a note still opens the note", () => {
    const asked: string[] = [];
    const palette = mount(DESKTOP, { onAsk: (query: string) => asked.push(query) });
    palette.type("note");
    palette.press("Enter");

    expect(asked).toEqual([]);
    expect(palette.chosen.map((item) => item.id)).toEqual(["3-resources/notes-on-storage.md"]);
    palette.unmount();
  });

  test("with nothing matching, search is still what Enter reaches", () => {
    const asked: string[] = [];
    const seen: string[] = [];
    const palette = mount(DESKTOP, {
      onAsk: (query: string) => asked.push(query),
      onSeeAll: (query: string) => seen.push(query),
      noMatchMessage: "Nothing loaded matches that.",
    });
    palette.type("ikenna");

    expect(palette.rowLabels()).toHaveLength(2);
    palette.press("Enter");
    expect(seen).toEqual(["ikenna"]);
    expect(asked).toEqual([]);

    // ...and one press down is the whole cost of the other answer.
    palette.press("ArrowDown");
    palette.press("Enter");
    expect(asked).toEqual(["ikenna"]);
    palette.unmount();
  });

  test("a press works as well as a keystroke", () => {
    const asked: string[] = [];
    const palette = mount(DESKTOP, { onAsk: (query: string) => asked.push(query) });
    palette.type("pricing");
    const rows = palette.all('[data-testid^="palette-row-"]');
    const last = rows[rows.length - 1]!;
    act(() => {
      last.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      last.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      last.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(asked).toEqual(["pricing"]);
    palette.unmount();
  });
});
