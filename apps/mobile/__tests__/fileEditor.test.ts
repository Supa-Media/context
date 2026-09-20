/**
 * The file editor's logic, without a renderer.
 *
 * Everything here is a pure module by design (see `jest.config.js`): the
 * console's tests run in plain node, so the rules worth pinning — what a
 * conflict does to an unsaved draft, which files get a visibility marker, what
 * a paste turns into — live outside the components rather than inside them.
 *
 * The one that matters most is the marker rule. "Mark only what differs from
 * the folder default" is a data property, not a style, and it is the thing
 * somebody will eventually be tempted to "fix" by labelling everything.
 */

import { describe, expect, test } from "@jest/globals";
import {
  ancestorsOf,
  baseName,
  describeDeleteForever,
  describeMoveProblem,
  describeNameProblem,
  displayName,
  duplicateName,
  ensureMarkdown,
  formatBytes,
  isFolderPlaceholder,
  joinPath,
  moveTargetFor,
  parentPath,
  restoreTargetFor,
  withoutSortPrefix,
} from "../features/console/files/paths";
import {
  buildTreeRows,
  findEntry,
  foldersToRefresh,
  listedEntries,
  markerFor,
  namesIn,
  targetFolder,
} from "../features/console/files/tree";
import { loadedCounts } from "../features/console/files/contextFoot";
import {
  editorReducer,
  emptyEditor,
  guardLeaving,
  isDirty,
  saveButton,
  type EditorState,
} from "../features/console/files/editor";
import { afterPaste, planPaste, put } from "../features/console/files/clipboard";
import { highlightMarkdown } from "../features/console/files/highlight";
import type { FileEntry, FolderListing, OpenNote } from "../features/console/files/types";

/* -------------------------------------------------------------------------- */
/*                                    paths                                   */
/* -------------------------------------------------------------------------- */

describe("path arithmetic", () => {
  test("parent and base, including at the root", () => {
    expect(parentPath("1-projects/foo.md")).toBe("1-projects");
    expect(parentPath("index.md")).toBe("");
    expect(baseName("1-projects/foo.md")).toBe("foo.md");
    expect(baseName("index.md")).toBe("index.md");
    expect(joinPath("", "index.md")).toBe("index.md");
    expect(joinPath("1-projects", "foo.md")).toBe("1-projects/foo.md");
  });

  test("ancestors, root first, so the tree can expand to a selection", () => {
    expect(ancestorsOf("1-projects/plans/q3.md")).toEqual(["1-projects", "1-projects/plans"]);
    expect(ancestorsOf("index.md")).toEqual([]);
  });

  test("a new note becomes markdown whether or not you typed the extension", () => {
    expect(ensureMarkdown("plan")).toBe("plan.md");
    expect(ensureMarkdown("plan.md")).toBe("plan.md");
    expect(ensureMarkdown("  plan  ")).toBe("plan.md");
    expect(ensureMarkdown("plan.MD")).toBe("plan.MD");
  });

  test("bytes read as a glance, not an audit", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(900)).toBe("900 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(2_500_000)).toBe("2.4 MB");
    expect(formatBytes(undefined)).toBe("");
  });

  test("an archived path knows where it came from", () => {
    expect(restoreTargetFor("4-archive/2026-08-26T09-14-02-113Z/1-projects/foo.md")).toBe(
      "1-projects/foo.md",
    );
    expect(restoreTargetFor("1-projects/foo.md")).toBeNull();
  });
});

describe("names the bucket would refuse", () => {
  test("an empty name", () => {
    expect(describeNameProblem("   ")).toMatch(/Give it a name/);
  });

  test("a slash, with the alternative offered", () => {
    expect(describeNameProblem("a/b.md")).toMatch(/Use Move/);
  });

  /** `.history/` and `.audit/` are real folders they can see from Obsidian. */
  test("a leading dot, explained rather than just refused", () => {
    expect(describeNameProblem(".secret.md")).toMatch(/history and audit/);
  });

  test("privacy.md, because it is generated", () => {
    expect(describeNameProblem("privacy.md")).toMatch(/generated from your visibility settings/);
  });

  test("a control character", () => {
    expect(describeNameProblem("a\u0000b.md")).toMatch(/cannot store/);
    expect(describeNameProblem("a\\b.md")).toMatch(/cannot store/);
  });

  test("an ordinary name is fine", () => {
    expect(describeNameProblem("Q3 plan.md")).toBeNull();
  });
});

describe("moves that cannot work are refused before the round trip", () => {
  test("into itself", () => {
    expect(describeMoveProblem("1-projects", "1-projects/plans", new Set())).toMatch(
      /inside itself/,
    );
    expect(describeMoveProblem("1-projects", "1-projects", new Set())).toMatch(
      /folder you are moving/,
    );
  });

  test("to where it already is", () => {
    expect(describeMoveProblem("1-projects/a.md", "1-projects", new Set())).toMatch(
      /already there/,
    );
  });

  test("onto an existing name — a move never overwrites", () => {
    expect(describeMoveProblem("1-projects/a.md", "2-areas", new Set(["a.md"]))).toMatch(
      /already has something called a\.md/,
    );
  });

  test("a legal move says nothing and lands where you would expect", () => {
    expect(describeMoveProblem("1-projects/a.md", "2-areas", new Set(["b.md"]))).toBeNull();
    expect(moveTargetFor("1-projects/a.md", "2-areas")).toBe("2-areas/a.md");
    expect(moveTargetFor("1-projects/a.md", "")).toBe("a.md");
  });
});

describe("duplicate naming matches the server's", () => {
  test("Obsidian's convention", () => {
    expect(duplicateName("foo.md", new Set())).toBe("foo copy.md");
    expect(duplicateName("foo.md", new Set(["foo copy.md"]))).toBe("foo copy 2.md");
  });

  test("a folder keeps its whole name", () => {
    expect(duplicateName("plans", new Set())).toBe("plans copy");
  });
});

/* -------------------------------------------------------------------------- */
/*                          what a row is called                              */
/* -------------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------------- */
/*                        the folder placeholder is not a row                 */
/* -------------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------------- */
/*                              the marker rule                               */
/* -------------------------------------------------------------------------- */

function file(path: string, over: Partial<FileEntry> = {}): FileEntry {
  return {
    kind: "file",
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    visibility: "private",
    inherited: "private",
    exception: false,
    readOnly: false,
    ...over,
  };
}

function folder(path: string, visibility: "private" | "team" = "private"): FileEntry {
  return {
    kind: "folder",
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    visibility,
    inherited: visibility,
    exception: false,
    readOnly: false,
  };
}

function listing(path: string, entries: FileEntry[]): FolderListing {
  return {
    path,
    folderDefault: "private",
    entries,
    truncated: false,
    manifestUsable: true,
  };
}

describe("a row is marked only when it differs from the folder it is in", () => {
  test("a file that inherits its folder's default gets no marker", () => {
    expect(markerFor(file("2-areas/a.md"))).toBeUndefined();
    expect(
      markerFor(file("1-projects/a.md", { visibility: "team", inherited: "team" })),
    ).toBeUndefined();
  });

  test("a private note in a shared folder is marked private", () => {
    expect(
      markerFor(file("1-projects/pay.md", { visibility: "private", inherited: "team", exception: true })),
    ).toBe("private");
  });

  test("a shared note in a private folder is marked team", () => {
    expect(
      markerFor(file("2-areas/handbook.md", { visibility: "team", inherited: "private", exception: true })),
    ).toBe("team");
  });

  /**
   * A folder is held to the same rule as a file, against its *parent's*
   * default.
   *
   * This is the half that changed. A folder used to print its own default
   * unconditionally, which on a bucket laid out the standard way put a label
   * beside every one of the PARA roots — five labels stating the two facts the
   * root already states. What is left is the folder somebody deliberately made
   * different, which is the only one worth a glance.
   *
   * `parentDefault` is the *listing's* default, not the folder's own. Passing
   * the folder's own would make every folder match itself and mark nothing,
   * which is the mistake this pair of cases exists to catch.
   */
  test("a folder is marked only when its default differs from its parent's", () => {
    expect(markerFor(folder("2-areas", "private"), "private")).toBeUndefined();
    expect(markerFor(folder("1-projects", "team"), "team")).toBeUndefined();
    expect(markerFor(folder("1-projects", "team"), "private")).toBe("team");
    expect(markerFor(folder("2-areas", "private"), "team")).toBe("private");
  });

  /**
   * With no parent default in hand, a folder keeps the old, safe answer.
   *
   * The argument is optional so a caller holding only an entry — there is one
   * in the landing page's demo data — gets a label rather than a silent
   * `undefined`. Over-labelling is a worse screen; under-labelling is a wrong
   * one.
   */
  test("a folder with no parent default given still states its own", () => {
    expect(markerFor(folder("2-areas", "private"))).toBe("private");
    expect(markerFor(folder("1-projects", "team"))).toBe("team");
  });

  /**
   * Stated as the property rather than as cases: in a folder where nothing is
   * unusual, the tree draws no file markers at all. That is the noise the rule
   * exists to remove.
   */
  test("a folder full of ordinary notes produces no file markers", () => {
    const rows = buildTreeRows({
      listings: {
        "": listing("", [folder("2-areas")]),
        "2-areas": listing("2-areas", [
          file("2-areas/a.md"),
          file("2-areas/b.md"),
          file("2-areas/c.md"),
        ]),
      },
      expanded: new Set(["2-areas"]),
      selectedPath: null,
    });
    const fileRows = rows.filter((row) => row.kind === "file");
    expect(fileRows).toHaveLength(3);
    expect(fileRows.every((row) => row.marker === undefined)).toBe(true);
    // And the folder is unmarked too: `listing("")` defaults to `private`, so
    // a private `2-areas` inside it is the ordinary case, not the notable one.
    expect(rows.find((row) => row.kind === "folder")?.marker).toBeUndefined();
  });

  /**
   * The whole tree, drawn silent.
   *
   * The property the rule is *for*, stated once at the level a person sees:
   * open a context where every folder and every note takes the default and
   * there is not one label on the screen. Before this, the same context drew
   * one on every folder row.
   */
  test("a context where nothing is unusual draws no markers at all", () => {
    const rows = buildTreeRows({
      listings: {
        "": listing("", [folder("1-projects"), folder("2-areas"), file("index.md")]),
        "1-projects": listing("1-projects", [file("1-projects/plan.md")]),
        "2-areas": listing("2-areas", [file("2-areas/a.md")]),
      },
      expanded: new Set(["1-projects", "2-areas"]),
      selectedPath: null,
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.marker === undefined)).toBe(true);
  });

  /**
   * And the one exception is the only thing on it.
   *
   * The counterpart to the case above, so "draws nothing" cannot be satisfied
   * by a rule that draws nothing ever.
   */
  test("one deliberately shared folder is the only marked row", () => {
    const rows = buildTreeRows({
      listings: {
        "": listing("", [folder("1-projects", "team"), folder("2-areas")]),
        "1-projects": listing("1-projects", [file("1-projects/plan.md")]),
      },
      expanded: new Set(["1-projects"]),
      selectedPath: null,
    });
    const marked = rows.filter((row) => row.marker !== undefined);
    expect(marked.map((row) => [row.path, row.marker])).toEqual([["1-projects", "team"]]);
  });
});

describe("building tree rows", () => {
  const listings = {
    "": listing("", [folder("1-projects", "team"), file("index.md")]),
    "1-projects": listing("1-projects", [
      folder("1-projects/plans"),
      file("1-projects/a.md", { visibility: "team", inherited: "team" }),
      file("1-projects/pay.md", { visibility: "private", inherited: "team", exception: true }),
    ]),
  };

  test("a collapsed folder shows only itself", () => {
    const rows = buildTreeRows({ listings, expanded: new Set(), selectedPath: null });
    expect(rows.map((row) => row.path)).toEqual(["1-projects", "index.md"]);
  });

  test("an expanded folder shows its children one level deeper", () => {
    const rows = buildTreeRows({
      listings,
      expanded: new Set(["1-projects"]),
      selectedPath: "1-projects/pay.md",
    });
    expect(rows.map((row) => row.path)).toEqual([
      "1-projects",
      "1-projects/plans",
      "1-projects/a.md",
      "1-projects/pay.md",
      "index.md",
    ]);
    expect(rows.find((row) => row.path === "1-projects/a.md")?.depth).toBe(1);
    expect(rows.find((row) => row.path === "1-projects/pay.md")?.selected).toBe(true);
  });

  /**
   * "Not loaded" and "empty" are different sentences to put in front of
   * somebody looking at their own notes, so they are different rows.
   */
  test("an expanded folder whose listing has not arrived says so", () => {
    const rows = buildTreeRows({
      listings: { "": listings[""] },
      expanded: new Set(["1-projects"]),
      selectedPath: null,
    });
    expect(rows.map((row) => row.kind)).toEqual(["folder", "loading", "file"]);
  });

  test("a genuinely empty folder says that instead", () => {
    const rows = buildTreeRows({
      listings: { ...listings, "1-projects/plans": listing("1-projects/plans", []) },
      expanded: new Set(["1-projects", "1-projects/plans"]),
      selectedPath: null,
    });
    expect(rows.some((row) => row.kind === "empty")).toBe(true);
  });

  test("names in a folder, for collision checks", () => {
    expect([...namesIn(listings, "1-projects")].sort()).toEqual(["a.md", "pay.md", "plans"]);
    expect(namesIn(listings, "nowhere").size).toBe(0);
  });

  test("finding an entry by path", () => {
    expect(findEntry(listings, "1-projects/pay.md")?.exception).toBe(true);
    expect(findEntry(listings, "1-projects/ghost.md")).toBeNull();
  });
});

describe("only the folders a change touched are refetched", () => {
  test("a move refreshes both ends", () => {
    expect(foldersToRefresh(["1-projects/a.md", "2-areas/a.md"])).toEqual([
      "1-projects",
      "2-areas",
    ]);
  });

  test("a root-level change refreshes the root", () => {
    expect(foldersToRefresh(["index.md"])).toEqual([""]);
  });

  /** A folder default cascades, so everything loaded beneath it is stale. */
  test("a folder visibility change refreshes everything under it", () => {
    expect(
      foldersToRefresh(["1-projects"], {
        cascadeFrom: "1-projects",
        loaded: ["", "1-projects", "1-projects/plans", "2-areas"],
      }),
    ).toEqual(["", "1-projects", "1-projects/plans"]);
  });
});

/* -------------------------------------------------------------------------- */
/*                             the editor's state                             */
/* -------------------------------------------------------------------------- */

const NOTE: OpenNote = {
  path: "1-projects/a.md",
  text: "# A\n",
  etag: "e1",
  visibility: "team",
  inherited: "team",
  exception: false,
  readOnly: false,
};

function opened(): EditorState {
  return editorReducer(emptyEditor, { type: "opened", note: NOTE });
}

describe("unsaved changes", () => {
  test("a freshly opened note is clean", () => {
    const state = opened();
    expect(state.status).toBe("clean");
    expect(isDirty(state)).toBe(false);
    expect(guardLeaving(state).allowed).toBe(true);
  });

  test("typing makes it dirty, and no longer blocks navigation", () => {
    /*
      This asserted the opposite until autosave: an unsaved draft refused to
      let anybody open another note, because the single editor slot would have
      thrown it away. It is written on the way out now (`select` flushes), so
      the refusal was a prompt in front of a problem that no longer exists —
      which is the "bugging people to save" the change is about.

      The two states that still refuse are `conflict` and `error`; see
      `autosave.test.ts`, which owns that policy.
    */
    const state = editorReducer(opened(), { type: "edited", text: "# A\n\nmore" });
    expect(state.status).toBe("dirty");
    expect(isDirty(state)).toBe(true);
    expect(guardLeaving(state)).toEqual({ allowed: true });
  });

  test("typing back to the original text is not a change", () => {
    let state = editorReducer(opened(), { type: "edited", text: "# B\n" });
    state = editorReducer(state, { type: "edited", text: "# A\n" });
    expect(state.status).toBe("clean");
    expect(isDirty(state)).toBe(false);
  });

  test("discarding restores what the server has", () => {
    let state = editorReducer(opened(), { type: "edited", text: "# B\n" });
    state = editorReducer(state, { type: "discarded" });
    expect(state.draft).toBe("# A\n");
    expect(isDirty(state)).toBe(false);
  });

  test("a read-only note cannot be edited at all", () => {
    const manifest = editorReducer(emptyEditor, {
      type: "opened",
      note: { ...NOTE, path: "privacy.md", readOnly: true },
    });
    const after = editorReducer(manifest, { type: "edited", text: "everything: team" });
    expect(after.draft).toBe(NOTE.text);
    expect(saveButton(after)).toEqual({ label: "Read-only", disabled: true });
  });
});

describe("saving", () => {
  test("a successful save makes the draft the new baseline", () => {
    let state = editorReducer(opened(), { type: "edited", text: "# B\n" });
    state = editorReducer(state, { type: "saveStarted" });
    expect(saveButton(state)).toEqual({ label: "Saving…", disabled: true });
    state = editorReducer(state, {
      type: "saveSucceeded",
      etag: "e2",
      conflictCheck: "conditional",
    });
    expect(state.status).toBe("saved");
    expect(state.etag).toBe("e2");
    expect(isDirty(state)).toBe(false);
    expect(state.message).toBe("Saved.");
  });

  /**
   * B2 and Wasabi accept `If-Match` and write anyway. The probe already caught
   * that at connect time; the editor's job is not to pretend otherwise.
   */
  test("a bucket without conditional writes is told the truth about it", () => {
    let state = editorReducer(opened(), { type: "edited", text: "# B\n" });
    state = editorReducer(state, {
      type: "saveSucceeded",
      etag: "e2",
      conflictCheck: "read-compare",
    });
    expect(state.message).toMatch(/best-effort/);
  });

  test("an ordinary failure keeps the draft and says why", () => {
    let state = editorReducer(opened(), { type: "edited", text: "# B\n" });
    state = editorReducer(state, {
      type: "saveFailed",
      error: { code: "STORAGE_FAILED", message: "Your bucket did not complete that request." },
    });
    expect(state.status).toBe("error");
    expect(state.draft).toBe("# B\n");
    expect(state.message).toMatch(/did not complete/);
    expect(saveButton(state).disabled).toBe(false);
  });
});

describe("a conflict never silently clobbers, in either direction", () => {
  function conflicted(): EditorState {
    let state = editorReducer(opened(), { type: "edited", text: "# Mine\n" });
    state = editorReducer(state, { type: "saveStarted" });
    return editorReducer(state, {
      type: "saveFailed",
      error: {
        code: "CONFLICT",
        message: "That file changed somewhere else while you were editing it.",
        currentEtag: "e9",
      },
    });
  }

  test("the draft survives — losing what somebody typed is the worst outcome here", () => {
    const state = conflicted();
    expect(state.status).toBe("conflict");
    expect(state.draft).toBe("# Mine\n");
    expect(state.message).toMatch(/changed somewhere else/);
    expect(state.conflictEtag).toBe("e9");
  });

  test("typing more does not clear the conflict", () => {
    const state = editorReducer(conflicted(), { type: "edited", text: "# Mine, more\n" });
    expect(state.status).toBe("conflict");
    expect(state.conflictEtag).toBe("e9");
  });

  test("the save button says plainly what pressing it would do", () => {
    expect(saveButton(conflicted())).toEqual({ label: "Overwrite theirs", disabled: false });
  });

  test("choosing theirs replaces the draft and clears the conflict", () => {
    const state = editorReducer(conflicted(), {
      type: "reloaded",
      note: { ...NOTE, text: "# Theirs\n", etag: "e9" },
    });
    expect(state.status).toBe("clean");
    expect(state.draft).toBe("# Theirs\n");
    expect(state.conflictEtag).toBeUndefined();
  });

  /**
   * Choosing "keep mine" rebases onto the etag that is actually current — so
   * the next save is still a conditional write, against a version the person
   * has been shown. It is an override, not a switch that turns the check off.
   */
  test("choosing yours rebases onto the current etag rather than disabling the check", () => {
    const state = editorReducer(conflicted(), { type: "conflictOverridden" });
    expect(state.status).toBe("dirty");
    expect(state.etag).toBe("e9");
    expect(state.draft).toBe("# Mine\n");
    expect(state.conflictEtag).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/*                                  clipboard                                 */
/* -------------------------------------------------------------------------- */

describe("copy, cut and paste", () => {
  test("a copy into an empty folder keeps its name", () => {
    expect(planPaste(put("copy", "1-projects/a.md"), "2-areas", new Set())).toEqual({
      ok: true,
      action: "copy",
      from: "1-projects/a.md",
      to: "2-areas/a.md",
    });
  });

  test("a copy into its own folder takes the next free copy name", () => {
    expect(
      planPaste(put("copy", "1-projects/a.md"), "1-projects", new Set(["a.md", "a copy.md"])),
    ).toEqual({
      ok: true,
      action: "copy",
      from: "1-projects/a.md",
      to: "1-projects/a copy 2.md",
    });
  });

  test("a cut becomes a move", () => {
    expect(planPaste(put("cut", "1-projects/a.md"), "2-areas", new Set())).toEqual({
      ok: true,
      action: "move",
      from: "1-projects/a.md",
      to: "2-areas/a.md",
    });
  });

  /**
   * A move that renamed itself out of a collision would have done something
   * other than what was asked, and the original would be gone.
   */
  test("a cut onto an existing name is refused rather than renamed", () => {
    const plan = planPaste(put("cut", "1-projects/a.md"), "2-areas", new Set(["a.md"]));
    expect(plan.ok).toBe(false);
    expect(plan.ok === false && plan.reason).toMatch(/Rename one of them first/);
  });

  test("a cut into its own folder is a no-op, and says so", () => {
    const plan = planPaste(put("cut", "1-projects/a.md"), "1-projects", new Set(["a.md"]));
    expect(plan.ok).toBe(false);
    expect(plan.ok === false && plan.reason).toMatch(/already there/);
  });

  test("a folder cannot be pasted inside itself", () => {
    const plan = planPaste(put("copy", "1-projects"), "1-projects/plans", new Set());
    expect(plan.ok).toBe(false);
    expect(plan.ok === false && plan.reason).toMatch(/inside itself/);
  });

  test("pasting nothing says nothing has been copied", () => {
    const plan = planPaste(null, "1-projects", new Set());
    expect(plan.ok).toBe(false);
  });

  test("a cut is spent once it lands; a copy stays on the clipboard", () => {
    expect(afterPaste(put("cut", "1-projects/a.md"))).toBeNull();
    expect(afterPaste(put("copy", "1-projects/a.md"))).toEqual(put("copy", "1-projects/a.md"));
  });
});

/* -------------------------------------------------------------------------- */
/*                          copying into a folder                             */
/* -------------------------------------------------------------------------- */

/**
 * `copyTo(from, folder)` — the ⌥-drop — plans exactly like a copy-and-paste,
 * except that the source is an argument instead of the clipboard.
 *
 * That distinction is the whole point of the method, and it is here because
 * the drop handler used to spell it `files.copy(from); files.paste(folder)`.
 * `copy` is a state setter and `paste` reads the clipboard from the render
 * that scheduled it, so in one tick the paste never saw the copy: with an
 * empty clipboard it refused, and with somebody's pending **cut** on the
 * clipboard it moved *that* file into the drop folder — data movement nobody
 * asked for, from a gesture aimed at a different file entirely.
 *
 * These exercise the pure layer, which is where the property is provable: a
 * plan built from an explicit source is a function of that source, and the
 * clipboard is not one of its inputs.
 */
describe("copying into a folder, with the source named rather than remembered", () => {
  test("the plan follows the dragged path, whatever is on the clipboard", () => {
    const dragged = "1-projects/a.md";

    expect(planPaste(put("copy", dragged), "3-resources", new Set())).toEqual({
      ok: true,
      action: "copy",
      from: dragged,
      to: "3-resources/a.md",
    });

    // What the clipboard happens to hold at that moment — here a cut of an
    // entirely different file — would have produced this instead. Same
    // destination, wrong file, and a *move*: the old spelling's worst case,
    // kept next to the right answer so the difference is visible.
    expect(planPaste(put("cut", "2-areas/other.md"), "3-resources", new Set())).toEqual({
      ok: true,
      action: "move",
      from: "2-areas/other.md",
      to: "3-resources/other.md",
    });
  });

  test("an empty clipboard is no obstacle, because it is not consulted", () => {
    expect(planPaste(null, "3-resources", new Set()).ok).toBe(false);
    expect(planPaste(put("copy", "1-projects/a.md"), "3-resources", new Set()).ok).toBe(true);
  });

  test("a collision in the destination takes the next free copy name", () => {
    expect(
      planPaste(put("copy", "1-projects/a.md"), "2-areas", new Set(["a.md", "a copy.md"])),
    ).toEqual({
      ok: true,
      action: "copy",
      from: "1-projects/a.md",
      to: "2-areas/a copy 2.md",
    });
  });

  /**
   * Dropping a file onto the folder it already sits in is a legal copy — it is
   * how you duplicate something by dragging — where the same drop *without* ⌥
   * is refused as a move that would do nothing. The two answers differing is
   * the behaviour, not an inconsistency.
   */
  test("copying into its own folder renames; moving into it is refused", () => {
    const taken = new Set(["a.md"]);
    expect(planPaste(put("copy", "1-projects/a.md"), "1-projects", taken)).toEqual({
      ok: true,
      action: "copy",
      from: "1-projects/a.md",
      to: "1-projects/a copy.md",
    });
    expect(describeMoveProblem("1-projects/a.md", "1-projects", taken)).toMatch(/already there/);
  });
});

/* -------------------------------------------------------------------------- */
/*                             markdown tinting                               */
/* -------------------------------------------------------------------------- */

describe("the mockup's markdown tinting", () => {
  test("frontmatter delimiters and keys are tinted, values are not", () => {
    const spans = highlightMarkdown("---\nupdated: 2026-08-26\nstatus: active\n---\n\nbody\n");
    const keyText = spans
      .filter((span) => span.tone === "key")
      .map((span) => span.text)
      .join("");
    expect(keyText).toContain("---");
    expect(keyText).toContain("updated:");
    expect(keyText).toContain("status:");
    expect(keyText).not.toContain("2026-08-26");
  });

  test("a heading is tinted", () => {
    const spans = highlightMarkdown("# Title\n\nbody\n");
    expect(spans.find((span) => span.tone === "heading")?.text).toBe("# Title");
  });

  /** A `---` further down is a horizontal rule, not a second frontmatter block. */
  test("only a leading block counts as frontmatter", () => {
    const spans = highlightMarkdown("body\n\n---\n\nmore\n");
    expect(spans.every((span) => span.tone === undefined)).toBe(true);
  });

  test("plain prose is left alone, and nothing is lost", () => {
    const text = "Just some words.\nAnd a second line.\n";
    const spans = highlightMarkdown(text);
    expect(spans.map((span) => span.text).join("")).toBe(text);
    expect(spans).toHaveLength(1);
  });

  test("round-trips any input exactly", () => {
    for (const text of [
      "",
      "#no space is not a heading\n",
      "---\nonly: one\n",
      "---\na: 1\n---\n# H\n\n## H2\ntext",
    ]) {
      expect(highlightMarkdown(text).map((span) => span.text).join("")).toBe(text);
    }
  });
});

/**
 * What the permanent-delete dialog promises.
 *
 * This is a claim about `functions/lib/fileOps.ts`'s `deletePath`, not a piece
 * of styling, and it was false for as long as the console has existed: the
 * dialog said "there is no copy kept anywhere, and nothing to restore from"
 * while every save of an existing note left the version it replaced in
 * `.history/`, and `deletePath` removed only the live keys. So a note anyone
 * had ever edited kept its content in the customer's bucket after being
 * "permanently" deleted — invisible, because `.history/` is hidden from the
 * file tree and from every gateway tool, which is what made it survive review.
 *
 * `deletePath` purges that history now. These assertions are what stops the
 * sentence drifting back ahead of, or behind, what the backend does.
 */
describe("the permanent-delete sentence", () => {
  test("says the earlier versions go too, because they do", () => {
    const body = describeDeleteForever("1-projects/pay.md", false);
    expect(body).toContain("1-projects/pay.md");
    expect(body).toMatch(/earlier versions/i);
    expect(body).toMatch(/cannot be undone/i);
  });

  test("a folder is described as a folder", () => {
    const body = describeDeleteForever("1-projects", true);
    expect(body).toMatch(/Every file in 1-projects/);
    expect(body).toMatch(/earlier versions/i);
  });

  /**
   * The exact sentence that was wrong, and the shape of it. "No copy kept
   * anywhere" is a claim about the whole bucket, and this product still cannot
   * make it: a note renamed before it was deleted leaves a `.move.md` snapshot
   * under the path it used to have, which `deletePath` never sees. The dialog
   * says what goes *alongside the note*, which is true.
   */
  test("never claims there is no copy anywhere", () => {
    for (const body of [
      describeDeleteForever("1-projects/pay.md", false),
      describeDeleteForever("1-projects", true),
    ]) {
      expect(body).not.toMatch(/no copy/i);
      expect(body).not.toMatch(/nothing to restore/i);
      expect(body).not.toMatch(/no(?:where| copy) kept/i);
    }
  });

  test("still points away from archive rather than pretending this is one", () => {
    expect(describeDeleteForever("1-projects/pay.md", false)).toMatch(/archive/i);
  });

  /**
   * The half that went wrong in the other direction. Once the product tells
   * people to enable versioning as their only protection against a bad
   * overwrite, an unqualified "this cannot be undone" is false for exactly the
   * customers who took that advice — their provider still holds the noncurrent
   * version, and we cannot see or delete it.
   */
  test("does not promise erasure it cannot perform at the provider", () => {
    for (const body of [
      describeDeleteForever("1-projects/pay.md", false),
      describeDeleteForever("1-projects", true),
    ]) {
      expect(body).toMatch(/versioning/i);
      expect(body).toMatch(/only you can remove them/i);
      // Qualified, not absolute: "from here" is the whole point of the fix.
      expect(body).not.toMatch(/cannot be undone[.,]/i);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                       where a new note is created                          */
/* -------------------------------------------------------------------------- */

describe("targetFolder", () => {
  /**
   * This exists because the rule was written twice and the copies disagreed.
   * The explorer's toolbar had it right; the phone's bottom toolbar used
   * `parentPath(selectedPath)` unconditionally — and since selecting a folder
   * in the tree also expands it, `selectedPath` is *routinely* a folder. So
   * tapping `1-projects` on a phone and then `+` created the note at the root.
   */
  const listings: Record<string, FolderListing> = {
    "": {
      path: "",
      folderDefault: "private",
      truncated: false,
      manifestUsable: true,
      entries: [
        folderEntry("1-projects"),
        fileEntry("index.md"),
      ],
    },
    "1-projects": {
      path: "1-projects",
      folderDefault: "team",
      truncated: false,
      manifestUsable: true,
      entries: [fileEntry("1-projects/plan.md")],
    },
  };

  test("a selected folder is the destination", () => {
    expect(targetFolder(listings, "1-projects")).toBe("1-projects");
  });

  test("a selected note means the folder it sits in", () => {
    expect(targetFolder(listings, "1-projects/plan.md")).toBe("1-projects");
    expect(targetFolder(listings, "index.md")).toBe("");
  });

  test("nothing selected is the root, which is a real destination", () => {
    expect(targetFolder(listings, null)).toBe("");
  });

  test("an unloaded note falls back to its parent", () => {
    // Not in any listing, so `findEntry` cannot say what it is — but a note is
    // `.md` by construction (`createNote` appends it, `writeNote` refuses
    // anything else), so the extension answers.
    expect(targetFolder(listings, "2-areas/health.md")).toBe("2-areas");
  });

  test("an unloaded FOLDER is the destination, not its parent", () => {
    /*
      The case a deep link produces, and the one this used to get wrong.
      `findEntry` looks a path up in its *parent's* listing, so a folder whose
      parent has not been fetched answers `null` — and the old rule read that
      `null` as "not a folder" and went up a level. The pane meanwhile drew the
      folder, because `useFileBrowser.select` had already been given the
      extension rule. So the screen said `2-areas/health` and `+` wrote into
      `2-areas`.
    */
    expect(targetFolder(listings, "2-areas/health")).toBe("2-areas/health");
    expect(targetFolder(listings, "2-areas")).toBe("2-areas");
  });
});

function folderEntry(path: string): FileEntry {
  return {
    kind: "folder",
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    visibility: "private",
    inherited: "private",
    exception: false,
    readOnly: false,
  };
}

function fileEntry(path: string): FileEntry {
  return { ...folderEntry(path), kind: "file" };
}
