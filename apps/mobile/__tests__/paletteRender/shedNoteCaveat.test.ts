/**
 * @jest-environment jsdom
 */

/**
 * A shed note's caveat, fixed above the list.
 *
 * Split out of `paletteRender.test.ts`; see `fixtures.ts` in this folder for
 * the module-level rationale and the mounting harness these tests share.
 *
 * `reducedRecallNotes` says something a person who just got few or no
 * results needs, and it needs to be the same fact an AI client already
 * reads off the same field (`docs/decisions/search.md`, "A shed index must
 * say so to the caller it happened to"). Three things distinguish it from
 * every other empty-list caveat this palette already draws:
 *
 *  - it does not resolve by searching again, so unlike `indexing` it must
 *    stay on screen beside real hits, not only beside none;
 *  - it must never grow with the mailbox, so a long list is named to a
 *    bound and the remainder counted rather than dropped or silently cut;
 *  - visibility is not this component's to decide — the array it is handed
 *    is already filtered upstream, so the palette must render exactly that
 *    array and nothing it derives, adds, or infers on its own.
 */

import { describe, expect, test } from "@jest/globals";
import { DESKTOP, REDUCED_RECALL_DISPLAY_LIMIT, mount } from "./fixtures";

describe("a shed note's caveat", () => {
  test("says nothing when nothing was shed", () => {
    const palette = mount(DESKTOP, {
      search: { onQuery: () => {}, items: [], state: "idle", reducedRecallNotes: [] },
    });
    expect(palette.find("palette-reduced-recall")).toBeNull();
    palette.unmount();
  });

  test("is silent when the field is absent altogether", () => {
    // Every existing caller of `PaletteSearch` predates this field, and none
    // of them must be forced to pass it — absent must read as "none", not as
    // a crash or an empty banner.
    const palette = mount(DESKTOP, {
      search: { onQuery: () => {}, items: [], state: "idle" },
    });
    expect(palette.find("palette-reduced-recall")).toBeNull();
    palette.unmount();
  });

  test("names the affected note, and says it still exists", () => {
    const palette = mount(DESKTOP, {
      search: {
        onQuery: () => {},
        items: [],
        state: "ready",
        reducedRecallNotes: ["0-inbox/email/name-at-example-com/2026-09-07.md"],
      },
    });
    const text = palette.find("palette-reduced-recall")?.textContent ?? "";
    expect(text).toContain("0-inbox/email/name-at-example-com/2026-09-07.md");
    expect(text).toContain("still exists");
    expect(text).toContain("opening it always shows it whole");
    palette.unmount();
  });

  test("stays up beside a screen full of real hits — it does not resolve by searching again", () => {
    // `indexing` is folded away the moment there are hits on screen (see "an
    // unanswered search never renders as 'nothing matches'" above); this must
    // not be, because a shed note's gap does not close on its own the way an
    // index catching up does.
    const palette = mount(DESKTOP, {
      search: {
        onQuery: () => {},
        items: [{ id: "1-projects/foo.md", label: "foo.md", detail: "1-projects", kind: "note" }],
        state: "ready",
        reducedRecallNotes: ["0-inbox/email/name-at-example-com/2026-09-07.md"],
      },
    });
    expect(palette.rowLabels().length).toBeGreaterThan(0);
    expect(palette.find("palette-reduced-recall")).not.toBeNull();
    palette.unmount();
  });

  test("is fixed above the list, not a row inside it that scrolling can hide", () => {
    const palette = mount(DESKTOP, {
      search: {
        onQuery: () => {},
        items: [],
        state: "ready",
        reducedRecallNotes: ["0-inbox/email/name-at-example-com/2026-09-07.md"],
      },
    });
    const notice = palette.find("palette-reduced-recall");
    const list = palette.find("palette-list");
    expect(notice).not.toBeNull();
    expect(list).not.toBeNull();
    // A sibling that precedes the scrolling list in the DOM, rather than a
    // node the list itself contains — which is what would let a long result
    // set push it out of view.
    expect(list!.contains(notice!)).toBe(false);
    palette.unmount();
  });

  test("a long list is named to a bound, and the rest is counted rather than dropped or grown", () => {
    const affected = Array.from(
      { length: REDUCED_RECALL_DISPLAY_LIMIT + 4 },
      (_, index) => `0-inbox/email/name-at-example-com/2026-09-${String(index + 1).padStart(2, "0")}.md`,
    );
    const palette = mount(DESKTOP, {
      search: { onQuery: () => {}, items: [], state: "ready", reducedRecallNotes: affected },
    });
    const text = palette.find("palette-reduced-recall")?.textContent ?? "";

    for (const path of affected.slice(0, REDUCED_RECALL_DISPLAY_LIMIT)) {
      expect(text).toContain(path);
    }
    for (const path of affected.slice(REDUCED_RECALL_DISPLAY_LIMIT)) {
      expect(text).not.toContain(path);
    }
    expect(text).toContain(`+${affected.length - REDUCED_RECALL_DISPLAY_LIMIT} more`);
    // The claim never grows with the mailbox: doubling the shed count again
    // must not double the rendered text.
    const doubled = [
      ...affected,
      ...affected.map((path) => path.replace("2026-09", "2026-10")),
    ];
    const bigger = mount(DESKTOP, {
      search: { onQuery: () => {}, items: [], state: "ready", reducedRecallNotes: doubled },
    });
    const biggerText = bigger.find("palette-reduced-recall")?.textContent ?? "";
    expect(biggerText.length).toBeLessThan(text.length + 40);
    bigger.unmount();
    palette.unmount();
  });

  test("renders exactly what it was handed — visibility is not re-derived here", () => {
    // Visibility is decided upstream (`canSee`, applied before this ever
    // reaches the console); the palette's own job is to draw the array it is
    // given, unfiltered and unaugmented. A path with no matching row among
    // `items` and no relation to the typed query still has to appear, and a
    // future "only show it if it also matches the query" or "cross-check
    // against loaded listings" change is exactly the kind of re-derivation
    // that could quietly turn this into a way to learn a note exists.
    const givenOnly = "2-areas/nowhere-the-query-points/unrelated-note.md";
    const palette = mount(DESKTOP, {
      search: {
        onQuery: () => {},
        items: [],
        state: "ready",
        reducedRecallNotes: [givenOnly],
      },
    });
    palette.type("something-else-entirely");
    const text = palette.find("palette-reduced-recall")?.textContent ?? "";
    expect(text).toContain(givenOnly);
    palette.unmount();
  });
});
