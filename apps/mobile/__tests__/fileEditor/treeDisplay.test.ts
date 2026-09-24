/**
 * What a row is called, and what a row is not: the display-name rule and the
 * folder-placeholder filter that hides a folder's own `README.md` from the
 * tree.
 *
 * Split out of `fileEditor.test.ts`; see `fixtures.ts` in this folder.
 */

import { describe, expect, test } from "@jest/globals";
import { displayName, isFolderPlaceholder, withoutSortPrefix } from "../../features/console/files/paths";
import { buildTreeRows, listedEntries, namesIn } from "../../features/console/files/tree";
import { loadedCounts } from "../../features/console/files/contextFoot";
import { file, folder, listing } from "./fixtures";

/**
 * `.md` and the sort number are stripped for display and for nothing else.
 *
 * The danger this pins is not that a row reads `README` — it is that the same
 * function is reached for the next time something needs "the name", and a note
 * gets renamed `foo` in somebody's bucket. `privacy.md`'s exact-note rules only
 * address `.md` paths, so such a note would silently lose its own visibility on
 * the way past. The sort number is worse: a write that dropped `1-` would move
 * a whole folder, its subtree and every `[[1-projects/…]]` link into it. Hence:
 * `TreeRow.name` is what is on disk, `TreeRow.label` is what is drawn, and they
 * are separate fields rather than one field and a convention.
 */
describe("the display name", () => {
  test("a note is drawn without its extension", () => {
    expect(displayName("README.md")).toBe("README");
    expect(displayName("3efac11d4eead8832e5b1236.md")).toBe("3efac11d4eead8832e5b1236");
    // Case, because a bucket will happily hold `NOTES.MD`.
    expect(displayName("NOTES.MD")).toBe("NOTES");
  });

  test("an attachment keeps its name", () => {
    // The extension is the one thing distinguishing this from the note beside
    // it, so it is information rather than noise.
    expect(displayName("diagram.png")).toBe("diagram.png");
    expect(displayName("notes.md.bak")).toBe("notes.md.bak");
  });

  test("a file called nothing but an extension keeps it, rather than becoming blank", () => {
    expect(displayName(".md")).toBe(".md");
  });

  test("a sort number is drawn off the front", () => {
    // The whole of PARA, which is what `scaffold.ts` writes into a new bucket.
    expect(displayName("0-inbox")).toBe("inbox");
    expect(displayName("1-projects")).toBe("projects");
    expect(displayName("2-areas")).toBe("areas");
    expect(displayName("3-resources")).toBe("resources");
    expect(displayName("4-archive")).toBe("archive");
    // Two digits, because nine folders is not many.
    expect(displayName("04-archive")).toBe("archive");
    expect(displayName("10-someday")).toBe("someday");
    // Both trims, in either order, on one name.
    expect(displayName("1-plan.md")).toBe("plan");
  });

  test("a date is not a sort number", () => {
    /*
      THE FAILURE THIS EXISTS TO REFUSE.

      A daily note is the single most common thing a filename is a date, and
      `2026-09-18` drawn as `09-18` is not untidy, it is the wrong file. Four
      digits is a year; a month-first date is caught by the digit after the
      hyphen. Both directions of the bias — show the number rather than eat
      half a date — are the point.
    */
    expect(displayName("2026-09-18.md")).toBe("2026-09-18");
    expect(displayName("12-25-christmas.md")).toBe("12-25-christmas");
    expect(displayName("1-2.md")).toBe("1-2");
    // The archive's own timestamped folders, which `restoreTargetFor` reads
    // back as a path — a segment drawn short here would name no folder at all.
    expect(displayName("2026-08-26T09-14-02-113Z")).toBe("2026-08-26T09-14-02-113Z");
  });

  test("a number with no name after it is a name", () => {
    expect(displayName("1-")).toBe("1-");
    // Not `.md`, which is a name this product reserves for plumbing.
    expect(displayName("1-.hidden")).toBe("1-.hidden");
  });

  test("only a hyphen separates, and only at the front", () => {
    expect(displayName("1 projects")).toBe("1 projects");
    expect(displayName("1_projects")).toBe("1_projects");
    expect(displayName("1.projects")).toBe("1.projects");
    expect(displayName("q1-budget.md")).toBe("q1-budget");
  });

  test("nothing but a sort number ever comes off the front", () => {
    /*
      The property rather than the cases — held from outside the rule, so a
      regex "improvement" that starts eating a letter, a second hyphen or the
      middle of a name fails here even if somebody updates the cases above to
      match their new answer.
    */
    for (const name of [
      "1-projects",
      "2026-09-18.md",
      "12-25-christmas.md",
      "1-",
      "1-.hidden",
      "README.md",
      "q1-budget.md",
      "1 projects",
      "2026-08-26T09-14-02-113Z",
      "",
    ]) {
      const drawn = withoutSortPrefix(name);
      expect(name.endsWith(drawn)).toBe(true);
      const dropped = name.slice(0, name.length - drawn.length);
      expect(dropped === "" || /^\d{1,2}-$/.test(dropped)).toBe(true);
    }
  });

  test("two siblings may draw the same, and that is the stated cost", () => {
    /*
      Pinned rather than guarded. A label that depended on which siblings
      happened to be loaded would read differently in the tree, the tab strip
      and the breadcrumb for one folder — see `SORT_PREFIX`. Rename, Move and
      the palette all still spell the number out, which is where somebody who
      has made this collision finds out they have.
    */
    expect(displayName("1-plan")).toBe(displayName("2-plan"));
  });

  test("the row carries both, and the one on disk is untouched", () => {
    const rows = buildTreeRows({
      listings: { "": listing("", [file("README.md"), folder("1-projects")]) },
      expanded: new Set(),
      selectedPath: null,
    });

    const note = rows.find((row) => row.kind === "file")!;
    expect(note.label).toBe("README");
    // The two that address the bucket are unchanged, which is the whole point.
    expect(note.name).toBe("README.md");
    expect(note.path).toBe("README.md");

    const dir = rows.find((row) => row.kind === "folder")!;
    expect(dir.label).toBe("projects");
    expect(dir.name).toBe("1-projects");
    expect(dir.path).toBe("1-projects");
  });
});

/**
 * A folder's `README.md` exists so its prefix does, and the console does not
 * list it.
 *
 * What this pins is the pair of boundaries, because both of them are the kind
 * of thing a later "simplification" reaches for. Widen the rule to the root and
 * a self-hosted bucket's own readme disappears from the one screen its owner
 * reads it on. Drop the `keep` and a placeholder opened from search or from a
 * `[[link]]` is the note you are editing with no row anywhere saying where you
 * are — the tree draws a selection it does not contain.
 *
 * SABOTAGE: making `isFolderPlaceholder` match at the root as well fails
 * "a README at the root is somebody's file, not plumbing" here and the row test
 * in "the display name" above. Dropping the filter from `listedEntries` fails
 * four here and two in `folderView.test.ts`. Filtering in `buildTreeRows`
 * *after* the length check instead of before leaves the empty-folder test
 * drawing a file row.
 */
describe("the folder placeholder", () => {
  test("is the README that makes a prefix exist, and only that", () => {
    expect(isFolderPlaceholder("1-projects/README.md")).toBe(true);
    // Obsidian's own casing is as likely as ours, and they are the same file to
    // the person looking at it. Nothing here writes a key, so a loose match
    // costs a drawn row and never a touched one.
    expect(isFolderPlaceholder("1-projects/plans/readme.md")).toBe(true);
    expect(isFolderPlaceholder("1-projects/ReadMe.MD")).toBe(true);
  });

  test("a README at the root is somebody's file, not plumbing", () => {
    // The root prefix needs no key to exist, so this one was written on purpose
    // — very probably by whoever self-hosted the bucket.
    expect(isFolderPlaceholder("README.md")).toBe(false);
  });

  test("a name that merely starts the same way is a note", () => {
    expect(isFolderPlaceholder("1-projects/readme-first.md")).toBe(false);
    expect(isFolderPlaceholder("1-projects/notes/README")).toBe(false);
    expect(isFolderPlaceholder("1-projects/plans.md")).toBe(false);
  });

  test("the tree draws every other row and not this one", () => {
    const rows = buildTreeRows({
      listings: {
        "": listing("", [folder("1-projects")]),
        "1-projects": listing("1-projects", [
          file("1-projects/README.md"),
          file("1-projects/q3.md"),
        ]),
      },
      expanded: new Set(["1-projects"]),
      selectedPath: null,
    });

    expect(rows.map((row) => row.path)).toEqual(["1-projects", "1-projects/q3.md"]);
  });

  test("a folder holding nothing else reads as empty rather than as a folder with a file in it", () => {
    const rows = buildTreeRows({
      listings: {
        "": listing("", [folder("1-projects")]),
        "1-projects": listing("1-projects", [file("1-projects/README.md")]),
      },
      expanded: new Set(["1-projects"]),
      selectedPath: null,
    });

    // The `empty` row, not a `file` row — which is why the filter runs before
    // the length check rather than after it.
    expect(rows.map((row) => row.kind)).toEqual(["folder", "empty"]);
  });

  test("it is drawn while it is the note you are looking at", () => {
    const rows = buildTreeRows({
      listings: {
        "": listing("", [folder("1-projects")]),
        "1-projects": listing("1-projects", [
          file("1-projects/README.md"),
          file("1-projects/q3.md"),
        ]),
      },
      expanded: new Set(["1-projects"]),
      selectedPath: "1-projects/README.md",
    });

    const open = rows.find((row) => row.path === "1-projects/README.md");
    expect(open?.selected).toBe(true);
    // And it is the real file underneath, unchanged — the row is hidden, the
    // key is not.
    expect(open?.name).toBe("README.md");
  });

  test("a folder somebody called README.md is still a folder", () => {
    const rows = buildTreeRows({
      listings: {
        "": listing("", [folder("1-projects")]),
        "1-projects": listing("1-projects", [folder("1-projects/README.md")]),
      },
      expanded: new Set(["1-projects"]),
      selectedPath: null,
    });
    // Pathological, and the rule promises to leave a thing unlisted rather than
    // unreachable — a hidden folder is unreachable, because there is no search
    // hit or link that opens one.
    expect(rows.map((row) => row.path)).toContain("1-projects/README.md");
  });

  test("a collision check still sees it, because the bucket does", () => {
    const listings = {
      "1-projects": listing("1-projects", [file("1-projects/README.md")]),
    };
    // Hiding a row must never make the name available: `createNote` would write
    // straight over the file the folder is made of.
    expect(namesIn(listings, "1-projects").has("README.md")).toBe(true);
  });

  test("the sort is still the server's, dropped rows and all", () => {
    const entries = [
      folder("1-projects/plans"),
      file("1-projects/README.md"),
      file("1-projects/a.md"),
      file("1-projects/b.md"),
    ];
    expect(listedEntries(entries).map((entry) => entry.name)).toEqual([
      "plans",
      "a.md",
      "b.md",
    ]);
    // Folders stay ahead of files in both directions; see `orderedEntries`.
    expect(listedEntries(entries, { descending: true }).map((entry) => entry.name)).toEqual([
      "plans",
      "b.md",
      "a.md",
    ]);
  });

  test("the counts line does not count a row nobody can find", () => {
    const counts = loadedCounts({
      "": listing("", [folder("1-projects")]),
      "1-projects": listing("1-projects", [
        file("1-projects/README.md"),
        file("1-projects/q3.md"),
      ]),
    });
    // One note, not two: the line is read against the rows on screen.
    expect(counts).toBe("1 note, 1 folder");
  });
});
