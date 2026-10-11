/**
 * A SHARED LINK'S REACH, AS THE CONSOLE'S TREE.
 *
 * The share page draws the console (Dev2, 2026-10-09), so what a link reaches
 * is turned into listings and note bodies (`sharedTree`). The property that
 * matters is that this adds nothing: every row is a path the server returned,
 * only the note on screen carries a body, and nothing about a folder is
 * claimed that the server did not say.
 */

import { describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isLoaded, sharedTree } from "../features/share/sharedTree";
import type { SharedNote } from "../features/share/share";

function note(over: Partial<SharedNote> = {}): SharedNote {
  return {
    path: "1-projects/grant/collab.md",
    text: "# Grant Writing Collab\n\n- [ ] Revise the application\n",
    kind: "note",
    entries: [],
    entryPath: "1-projects/grant/collab.md",
    links: ["1-projects/grant/budget.md", "3-resources/funder-rules.md", "1-projects/grant/collab.md"],
    openToAnyone: true,
    collecting: false,
    editableInContext: null,
    ...over,
  };
}

function rows(tree: ReturnType<typeof sharedTree>): string[] {
  return Object.values(tree.listings)
    .flatMap((listing) => listing.entries.map((entry) => `${entry.kind}:${entry.path}`))
    .sort();
}

describe("sharedTree", () => {
  test("a note link lists the note and the notes it links to, under their folders", () => {
    const tree = sharedTree(note(), "read only");
    expect(rows(tree)).toEqual([
      "file:1-projects/grant/budget.md",
      "file:1-projects/grant/collab.md",
      "file:3-resources/funder-rules.md",
      "folder:1-projects",
      "folder:1-projects/grant",
      "folder:3-resources",
    ]);
    expect(tree.defaultSelection).toBe("1-projects/grant/collab.md");
    expect(new Set(tree.defaultExpanded)).toEqual(new Set(["1-projects", "1-projects/grant", "3-resources"]));
    expect(tree.readOnlyReason).toBe("read only");
  });

  test("only the note on screen has a body", () => {
    const tree = sharedTree(note(), "r");
    expect(Object.keys(tree.notes)).toEqual(["1-projects/grant/collab.md"]);
  });

  test("a note reached from the entry keeps the entry note in the tree, without its body", () => {
    const tree = sharedTree(
      note({ path: "1-projects/grant/budget.md", text: "# Budget", links: [] }),
      "r",
    );
    expect(rows(tree)).toContain("file:1-projects/grant/collab.md");
    expect(Object.keys(tree.notes)).toEqual(["1-projects/grant/budget.md"]);
  });

  test("a folder link lists exactly what the server listed inside it", () => {
    const tree = sharedTree(
      note({
        kind: "folder",
        path: "1-projects/grant",
        entryPath: "1-projects/grant",
        text: null,
        links: [],
        entries: [
          { path: "1-projects/grant/collab.md", name: "collab.md", kind: "file" },
          { path: "1-projects/grant/drafts", name: "drafts", kind: "folder" },
        ],
      }),
      "r",
    );
    expect(tree.listings["1-projects/grant"]!.entries.map((entry) => entry.path)).toEqual([
      "1-projects/grant/drafts",
      "1-projects/grant/collab.md",
    ]);
    expect(tree.notes).toEqual({});
    expect(tree.defaultSelection).toBe("1-projects/grant");
  });

  test("no row is marked as an exception or read-only file", () => {
    const tree = sharedTree(note(), "r");
    for (const listing of Object.values(tree.listings)) {
      for (const entry of listing.entries) {
        expect(entry.exception).toBe(false);
        expect(entry.readOnly).toBe(false);
      }
    }
  });

  test("only the note on screen counts as loaded", () => {
    expect(isLoaded(note(), "1-projects/grant/collab.md")).toBe(true);
    expect(isLoaded(note(), "1-projects/grant/budget.md")).toBe(false);
    expect(isLoaded(note(), "1-projects/grant")).toBe(false);
  });
});

describe("the shared console cannot edit", () => {
  const source = readFileSync(join(__dirname, "..", "features", "share", "SharedConsole.tsx"), "utf8");

  test("its file browser is the landing page's read-only one", () => {
    expect(source).toContain("useStaticFileBrowser(");
    expect(source).not.toMatch(/useFileBrowser\(|useLocalFileBrowser\(/);
  });
});
