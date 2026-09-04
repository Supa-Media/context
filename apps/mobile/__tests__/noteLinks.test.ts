import { describe, expect, test } from "@jest/globals";
import {
  LONG_PRESS_MS,
  LONG_PRESS_SLOP,
  followChord,
  noteLinkAt,
  noteLinksIn,
} from "../features/console/files/noteLinks";
import { knownNotePaths } from "../features/console/files/paths";

/**
 * A LINK TO ANOTHER NOTE IS A LINK YOU CAN FOLLOW.
 *
 * `[[../../2-products/context-lc/overview]]` rendered as that exact string —
 * not coloured, not clickable — in an app whose notes are mostly links to each
 * other. The owner's words: "links like [[…]] dont actually link to the page
 * they are referencing".
 *
 * What is asserted here is the part with the decisions in it, which is *which
 * text becomes a link and how far it reaches*. The gesture layer is a CodeMirror
 * extension and is covered by `editorLinks.test.ts` against a mounted editor;
 * the resolution is `@context/shared`'s and is covered on both sides of the
 * boundary it spans.
 *
 * The two decisions worth pinning here:
 *
 *  - **The span is the whole link, not the target.** A person aims at the
 *    words, and in `[label](path.md)` the words are the label — which is
 *    exactly the part the parser does not return.
 *  - **Existence is not required, and a bare name is.** The tree loads folder
 *    by folder, so this surface cannot answer "does that note exist"; requiring
 *    it would make a link into an unexpanded folder render as prose. A bare
 *    `[[name]]` is the opposite case — it has no path at all until something
 *    resolves the name — so it is drawn only when the paths on hand settle it.
 */

const NOTE = "1-projects/persistence/overview.md";
const KNOWN = [NOTE, "2-products/context-lc/overview.md", "3-resources/unique.md"];

const linksIn = (text: string, paths: readonly string[] = KNOWN) =>
  noteLinksIn(text, { path: NOTE, paths });

describe("what becomes a link", () => {
  test("the link from the bug report, resolved", () => {
    const text = "see [[../../2-products/context-lc/overview]] for the shape";
    expect(linksIn(text)).toEqual([
      { from: 4, to: 44, path: "2-products/context-lc/overview.md" },
    ]);
    expect(text.slice(4, 44)).toBe("[[../../2-products/context-lc/overview]]");
  });

  test("the span covers the brackets, the alias and an embed's marker", () => {
    for (const written of [
      "[[../../2-products/context-lc/overview]]",
      "[[../../2-products/context-lc/overview|the app]]",
      "![[../../2-products/context-lc/overview]]",
      "[[../../2-products/context-lc/overview#shape]]",
    ]) {
      const text = `x ${written} y`;
      const [span] = linksIn(text);
      expect(span).toBeDefined();
      expect(text.slice(span!.from, span!.to)).toBe(written);
    }
  });

  test("an inline link's span covers its label, which is the part you aim at", () => {
    const text = "read [the overview](../../2-products/context-lc/overview.md) first";
    const [span] = linksIn(text);
    expect(text.slice(span!.from, span!.to)).toBe(
      "[the overview](../../2-products/context-lc/overview.md)",
    );
  });

  test("a rooted link is a link", () => {
    expect(linksIn("[[2-products/context-lc/overview]]")).toHaveLength(1);
  });

  test("a link to a note that is not loaded is still a link", () => {
    /*
      The decision. This surface knows the folders somebody has expanded and
      nothing about the rest, so requiring existence would render the normal
      case — a link into a folder nobody has opened — as plain prose. Following
      one lands on the editor's own "that file does not exist", which is what
      Obsidian does and is honest.
    */
    const written = "[[../../4-archive/2019/something.md]]";
    expect(linksIn(written, [NOTE])).toEqual([
      { from: 0, to: written.length, path: "4-archive/2019/something.md" },
    ]);
  });

  test("several links on one line are several links", () => {
    const spans = linksIn("[[../a]] and [[../b]] and [[../c]]");
    expect(spans.map((span) => span.path)).toEqual([
      "1-projects/a.md",
      "1-projects/b.md",
      "1-projects/c.md",
    ]);
  });
});

describe("what deliberately does not", () => {
  test("an external URL", () => {
    expect(linksIn("[docs](https://context.lc/x.md)")).toEqual([]);
  });

  test("an anchor into this note", () => {
    expect(linksIn("[top](#heading)")).toEqual([]);
  });

  test("anything inside code", () => {
    expect(linksIn("`[[../a]]`")).toEqual([]);
    expect(linksIn("```\n[[../a]]\n```")).toEqual([]);
  });

  test("a target that walks above the root", () => {
    expect(linksIn("[[../../../../../etc/passwd]]")).toEqual([]);
  });

  test("a bare name the paths on hand cannot settle", () => {
    // Two notes answer to `overview`, so there is no destination to open. A
    // link drawn here would be a control that does nothing.
    expect(linksIn("[[overview]]")).toEqual([]);
    expect(linksIn("[[nothing-like-this]]")).toEqual([]);
  });

  test("…and one they can", () => {
    expect(linksIn("[[unique]]").map((span) => span.path)).toEqual(["3-resources/unique.md"]);
  });

  test("nothing at all, when this surface does not know which note is open", () => {
    // A relative link has nothing to be relative to. Drawing one anyway would
    // mean resolving `../a` against the root and opening the wrong note.
    expect(noteLinksIn("[[../a]]", { path: null, paths: KNOWN })).toEqual([]);
  });
});

describe("the link under a position", () => {
  const spans = linksIn("see [[../../2-products/context-lc/overview]] here");

  test("anywhere inside it, including both edges", () => {
    for (const pos of [4, 20, 44]) {
      expect(noteLinkAt(spans, pos)?.path).toBe("2-products/context-lc/overview.md");
    }
  });

  test("and nothing outside it", () => {
    expect(noteLinkAt(spans, 3)).toBeNull();
    expect(noteLinkAt(spans, 47)).toBeNull();
  });
});

describe("the chord the tooltip names", () => {
  /*
    It goes in front of a person, so naming the wrong key is worse than naming
    none. Read from the user agent rather than from `Platform.OS`: the editor is
    a web surface on both hosts, and what decides the key is the keyboard
    attached to the browser — an iPad with a Magic Keyboard is a Mac here, and a
    Windows browser is not, however the app around it was built.
  */
  test("⌘ on Apple hardware", () => {
    for (const agent of [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
    ]) {
      expect(followChord(agent)).toBe("⌘");
    }
  });

  test("Ctrl everywhere else, including where there is no agent at all", () => {
    expect(followChord("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("Ctrl");
    expect(followChord("Mozilla/5.0 (X11; Linux x86_64)")).toBe("Ctrl");
    expect(followChord(undefined)).toBe("Ctrl");
  });
});

describe("the press is a press and not a tap or a scroll", () => {
  test("the thresholds are the ones a thumb produces", () => {
    // Not arbitrary: below ~300ms is a tap and above ~600ms is a wait, and a
    // thumb rolls several pixels on any press it holds. Pinned so a change to
    // either is a decision rather than a typo.
    expect(LONG_PRESS_MS).toBeGreaterThanOrEqual(350);
    expect(LONG_PRESS_MS).toBeLessThanOrEqual(600);
    expect(LONG_PRESS_SLOP).toBeGreaterThanOrEqual(6);
    expect(LONG_PRESS_SLOP).toBeLessThanOrEqual(16);
  });
});

describe("the paths this surface happens to know", () => {
  test("every loaded note, sorted, folders and non-markdown left out", () => {
    const listings = {
      "": {
        entries: [
          { kind: "folder", path: "1-projects" },
          { kind: "file", path: "index.md" },
        ],
      },
      "1-projects": {
        entries: [
          { kind: "file", path: "1-projects/b.md" },
          { kind: "file", path: "1-projects/a.md" },
          { kind: "file", path: "1-projects/diagram.png" },
        ],
      },
      "2-areas": undefined,
    };
    expect(knownNotePaths(listings)).toEqual(["1-projects/a.md", "1-projects/b.md", "index.md"]);
  });

  test("the same folders produce the same array, so nothing is resent for nothing", () => {
    // It crosses the WebView bridge on native. An unsorted rebuild would repost
    // the whole list every time a folder collapsed.
    const listings = { "": { entries: [{ kind: "file", path: "b.md" }] }, x: { entries: [{ kind: "file", path: "a.md" }] } };
    expect(knownNotePaths(listings)).toEqual(knownNotePaths({ x: listings.x, "": listings[""] }));
  });
});
