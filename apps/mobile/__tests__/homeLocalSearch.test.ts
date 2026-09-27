/**
 * The homepage's search, over the notes held in the tab.
 *
 * Before this the homepage's browser rejected every search ("This console
 * cannot search"), so a visitor typing three letters got "That search could not
 * be run" under a list of file names. Its notes are all in memory, so it
 * answers the way a workspace's index does: the note by its title, and the
 * line that matched.
 */

import { describe, expect, test } from "@jest/globals";
import { searchLocalNotes, snippetFor } from "../features/home/localSearch";

const NOTES = {
  "01-context.md": "---\ntitle: wth is this\n---\n# wth is this\n\ncontext is a notes app for you, your team, claude.\n",
  "02-pricing.md": "# Pricing\n\nfree, you cheapo\n",
  "03-devlog.md":
    "# devlog\n\n- shipped onboarding, **private** sharing and a [new tree](/tree) for everyone who asked for one\n",
  "Legal/drawing.excalidraw.md": "# Excalidraw Data\n\nprivate pricing\n",
};

describe("searchLocalNotes", () => {
  test("a title match comes before a body match, and each hit is named by its title", () => {
    const answer = searchLocalNotes(NOTES, "pri");
    expect(answer.hits.map((hit) => [hit.path, hit.title])).toEqual([
      ["02-pricing.md", "Pricing"],
      ["03-devlog.md", "devlog"],
    ]);
  });

  test("a body match carries the words around it, without the Markdown", () => {
    const [hit] = searchLocalNotes(NOTES, "private").hits;
    expect(hit?.snippets).toEqual(["shipped onboarding, private sharing and a new tree for everyone…"]);
  });

  test("the heading that is the title is not quoted back as the snippet", () => {
    const [hit] = searchLocalNotes(NOTES, "wth").hits;
    expect(hit?.path).toBe("01-context.md");
    expect(hit?.snippets).toEqual([]);
  });

  test("a drawing's data is not searched as words", () => {
    expect(searchLocalNotes(NOTES, "excalidraw").hits).toEqual([]);
  });

  test("the answer is complete, and says so", () => {
    const answer = searchLocalNotes(NOTES, "nothing like this");
    expect(answer).toEqual({
      hits: [],
      indexMissing: false,
      indexIncomplete: false,
      reducedRecall: false,
      reducedRecallNotes: [],
    });
  });

  test("an empty query finds nothing rather than everything", () => {
    expect(searchLocalNotes(NOTES, "   ").hits).toEqual([]);
  });
});

describe("snippetFor", () => {
  test("cuts a long line to a window around the match", () => {
    const line = `${"a".repeat(100)} needle ${"b".repeat(100)}`;
    const snippet = snippetFor(line, "needle", "Title")!;
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet).toContain("needle");
    expect(snippet.length).toBeLessThan(90);
  });
});
