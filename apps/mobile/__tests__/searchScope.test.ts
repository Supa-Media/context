/**
 * @jest-environment jsdom
 */

import { describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { searchScopeNote } from "../features/console/files/palette";
import type { FolderListing } from "../features/console/files/types";

// The palette reads the home indicator for its sheet. Not this file's subject,
// and jsdom has no provider — same stub `paletteRender.test.ts` uses.
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * **What ⌘K actually searched, said while it is still useful.**
 *
 * The palette is built from `itemsFromListings` — the folder listings already
 * in memory — so it searches what somebody has expanded and nothing else. That
 * was stated only in the *no matches* view, which is the one moment it is least
 * needed: a search over a six-hundred-note context that returns four rows looks
 * exactly like a complete answer, and nothing on screen suggested otherwise. The
 * failure is silent and expensive — the person concludes the note is not there
 * and writes it again.
 *
 * The rule the line follows is the census's, from CLAUDE.md: **a floor is never
 * printed as a total**, and absent is never zero.
 */

function listing(path: string, files: number, truncated = false): FolderListing {
  return {
    path,
    folderDefault: "private",
    truncated,
    manifestUsable: true,
    entries: Array.from({ length: files }, (_, index) => ({
      kind: "file" as const,
      path: path === "" ? `note-${index}.md` : `${path}/note-${index}.md`,
      name: `note-${index}.md`,
      visibility: "private" as const,
      inherited: "private" as const,
      exception: false,
      readOnly: false,
    })),
  };
}

describe("the line the palette prints above its results", () => {
  test("nothing loaded prints no line at all", () => {
    /*
      Absent is not zero. "Searching 0 notes in 0 folders" on a first paint is
      the console saying something false about somebody's context — the same
      mistake the storage card's note census refuses by rendering no tile
      rather than an em dash.
    */
    expect(searchScopeNote({})).toBeNull();
    // A folder that has been *asked for* and has not landed is a present key
    // with an `undefined` value, and it counts for nothing either.
    expect(searchScopeNote({ "1-projects": undefined })).toBeNull();
  });

  test("it counts the notes and the folders it actually has", () => {
    const note = searchScopeNote({ "": listing("", 2), "1-projects": listing("1-projects", 3) });
    expect(note).toBe(
      "Searching 5 notes in 2 folders you have opened. " +
        "The rest of this context has not been read yet.",
    );
  });

  test("one of each reads as one of each", () => {
    expect(searchScopeNote({ "": listing("", 1) })).toContain("Searching 1 note in 1 folder");
  });

  test("a truncated listing makes the count a floor", () => {
    /*
      `noteCountTruncated`'s rule, applied here: a folder the server could not
      list in full is a folder this search only partly covered, so the number
      travels with a `+` and is never printed as a total.
    */
    const note = searchScopeNote({ "": listing("", 4, true) })!;
    expect(note).toContain("Searching 4+ notes");
  });

  test("it never claims to have covered the context", () => {
    // The half that matters. Whatever the numbers say, the sentence must not
    // read as a complete search.
    for (const listings of [
      { "": listing("", 1) },
      { "": listing("", 40), "2-areas": listing("2-areas", 9, true) },
    ]) {
      expect(searchScopeNote(listings)).toContain("has not been read yet");
    }
  });
});

/* -------------------------------------------------------------------------- */

describe("the palette shows it whether or not it found anything", () => {
  const { Palette } =
    require("../features/design/components/Palette") as typeof import("../features/design/components/Palette");

  function mount(props: { items: { id: string; label: string; kind: "note" }[] }) {
    Object.defineProperty(document.documentElement, "clientWidth", {
      value: 1280,
      configurable: true,
    });
    Object.defineProperty(document.documentElement, "clientHeight", {
      value: 800,
      configurable: true,
    });
    window.dispatchEvent(new Event("resize"));

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
    act(() => {
      root.render(
        createElement(Palette, {
          items: props.items,
          placeholder: "Go to a note",
          scopeNote: "Searching 5 notes in 2 folders you have opened.",
          onChoose: () => {},
          onDismiss: () => {},
        }),
      );
    });
    return {
      find: (testID: string) =>
        document.body.querySelector<HTMLElement>(`[data-testid="${testID}"]`),
      unmount: () => {
        act(() => root.unmount());
        container.remove();
      },
    };
  }

  test("with results", () => {
    // The state the old copy said nothing in, and the only one that misleads.
    const palette = mount({ items: [{ id: "a.md", label: "a.md", kind: "note" }] });
    expect(palette.find("palette-scope")?.textContent).toContain("Searching 5 notes");
    expect(palette.find("palette-row-0")).not.toBeNull();
    palette.unmount();
  });

  test("and with none", () => {
    const palette = mount({ items: [] });
    expect(palette.find("palette-scope")?.textContent).toContain("Searching 5 notes");
    expect(palette.find("palette-empty")).not.toBeNull();
    palette.unmount();
  });
});
