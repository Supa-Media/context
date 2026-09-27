import { describe, expect, test } from "@jest/globals";

import {
  isUntitled,
  titleFor,
  untitledName,
  untitledStem,
} from "../features/console/files/untitled";
import type { FolderListing } from "../features/console/files/types";
import { proposeTitle } from "../features/console/files/linkedTitle";

/** The name a title would give the note, or `null` for none — `proposeTitle`'s answer. */
function nameFromTitle(path: string, text: string): string | null {
  const answer = proposeTitle({ path, draft: text, listings: {}, sharesWarning: null });
  return answer.kind === "rename" ? answer.name : null;
}

/**
 * NOBODY IS ASKED TO NAME A NOTE BEFORE THEY HAVE WRITTEN IT.
 *
 * Every route into a new note used to raise a text field — the explorer's `+`,
 * the row menu, ⌘N, the quick-note link, the phone's bottom row — and the field
 * asked for the one piece of information the person did not have yet. The owner
 * asked for it to go: *"for new note, new drawing etc should not ask you to
 * title it, it should be called untitled-date, but the user should be able to
 * title the note while writing in it"*.
 *
 * Which is two functions, and both of them have a way of being *nearly* right:
 *
 *  - the name has to be one `createNote`'s own collision check will accept, or a
 *    second press in the same folder is a refusal rather than a second note;
 *  - the rename has to fire for the placeholder and **never** for a name
 *    somebody chose, and it has to refuse a heading a bucket cannot store
 *    rather than mangling it into one that nearly is.
 *
 * ## Sabotage record
 *
 * Applied as local edits, suite run, named tests observed failing, reverted.
 *
 *   `untitledName` ignoring the listing (no `-2` suffix)               1
 *   `isUntitled` matching the bare word `untitled`                     1
 *   `titleFor` scanning for the first `#` anywhere in the document      2
 *   `proposeTitle` sanitizing a slash instead of refusing               1
 *   `proposeTitle` appending `.md` rather than keeping the extension    1
 */

/** A listing holding exactly these names, which is all `namesIn` reads. */
function folder(path: string, names: readonly string[]): Record<string, FolderListing> {
  return {
    [path]: {
      path,
      folderDefault: "private",
      truncated: false,
      manifestUsable: true,
      entries: names.map((name) => ({
        name,
        path: path === "" ? name : `${path}/${name}`,
        kind: name.includes(".") ? ("file" as const) : ("folder" as const),
        visibility: "private" as const,
        inherited: "private" as const,
        exception: false,
        readOnly: false,
      })),
    },
  };
}

/* 19 September 2026, 21:40 local — deliberately in the evening, see below. */
const EVENING = new Date(2026, 8, 19, 21, 40);

describe("the name a new thing gets", () => {
  test("is the word and the date", () => {
    expect(untitledStem(EVENING)).toBe("untitled-2026-09-19");
  });

  /**
   * The **device's** date, not UTC.
   *
   * A note made at 21:40 in any timezone west of Greenwich is already tomorrow
   * in UTC, and a file dated tomorrow on somebody's own screen, in their own
   * bucket, is simply wrong. `new Date(2026, 8, 19, 21, 40)` is local by
   * construction, so this passes wherever CI runs and would fail the moment the
   * stem was built out of `toISOString`.
   */
  test("and the date is the one on the device, not the one in UTC", () => {
    expect(untitledStem(new Date(2026, 11, 31, 23, 59))).toBe("untitled-2026-12-31");
    expect(untitledStem(new Date(2026, 0, 1, 0, 1))).toBe("untitled-2026-01-01");
  });

  test("carries the extension of the thing being made", () => {
    const empty = folder("1-projects", []);
    expect(untitledName(empty, "1-projects", "note", EVENING)).toBe("untitled-2026-09-19.md");
    expect(untitledName(empty, "1-projects", "drawing", EVENING)).toBe(
      "untitled-2026-09-19.excalidraw.md",
    );
    expect(untitledName(empty, "1-projects", "folder", EVENING)).toBe("untitled-2026-09-19");
  });

  /**
   * THE SECOND PRESS HAS TO MAKE A SECOND NOTE.
   *
   * `createNote` refuses a name already in the loaded listing, so a generator
   * that answered the same name twice would turn the second press of a `+` into
   * "1-projects already has something called untitled-2026-09-19.md" — which is
   * both useless and exactly the defect the bottom row's old `createNote(folder,
   * "Untitled")` had.
   */
  test("steps past a name the folder already has", () => {
    const one = folder("1-projects", ["untitled-2026-09-19.md"]);
    expect(untitledName(one, "1-projects", "note", EVENING)).toBe("untitled-2026-09-19-2.md");

    const two = folder("1-projects", ["untitled-2026-09-19.md", "untitled-2026-09-19-2.md"]);
    expect(untitledName(two, "1-projects", "note", EVENING)).toBe("untitled-2026-09-19-3.md");
  });

  test("and counts per kind, because the extensions differ", () => {
    // A note occupying the stem does not push the drawing along: they are two
    // different filenames, and a drawing called `-2` for no reason is noise.
    const one = folder("1-projects", ["untitled-2026-09-19.md"]);
    expect(untitledName(one, "1-projects", "drawing", EVENING)).toBe(
      "untitled-2026-09-19.excalidraw.md",
    );
  });

  test("a folder nobody has loaded is empty rather than an error", () => {
    // Listings are fetched per folder, so this is ordinary. The server's
    // conditional create is what refuses a genuine clash.
    expect(untitledName({}, "4-archive/deep/unloaded", "note", EVENING)).toBe(
      "untitled-2026-09-19.md",
    );
  });
});

describe("recognising one of ours", () => {
  test("the generated names, in all four shapes", () => {
    for (const name of [
      "untitled-2026-09-19",
      "untitled-2026-09-19.md",
      "untitled-2026-09-19-2.md",
      "untitled-2026-09-19.excalidraw.md",
      "1-projects/untitled-2026-09-19.md",
    ]) {
      expect(isUntitled(name)).toBe(true);
    }
  });

  /**
   * AND NOTHING SOMEBODY CHOSE.
   *
   * This is the guard that keeps a file from moving in a customer's bucket
   * because they opened it. A note genuinely *called* "untitled thoughts" is
   * their name for it, and the date is what tells the two apart — which is the
   * whole reason the pattern matches a date rather than the word.
   */
  test("and never a name a person picked", () => {
    for (const name of [
      "untitled.md",
      "untitled thoughts.md",
      "untitled-notes.md",
      "untitled-2026.md",
      "untitled-2026-09.md",
      "my-untitled-2026-09-19.md",
      "plan.md",
    ]) {
      expect(isUntitled(name)).toBe(false);
    }
  });
});

describe("the title a document gives itself", () => {
  test("is its first heading", () => {
    expect(titleFor("# Weekly sync\n\nThe first paragraph.\n")).toBe("Weekly sync");
  });

  test("skipping frontmatter, which the console wrote and the person did not", () => {
    expect(titleFor("---\nupdated: 2026-09-19\n---\n\n# Weekly sync\n\nBody.\n")).toBe(
      "Weekly sync",
    );
  });

  test("and leading blank lines", () => {
    expect(titleFor("\n\n#   Weekly sync   \n")).toBe("Weekly sync");
  });

  /**
   * NOT A HEADING FURTHER DOWN, AND NOT A SUBHEADING.
   *
   * A note whose first line is a paragraph has not been titled, and promoting an
   * `##` from halfway down names the file after a subsection. Both would look
   * plausible in a diff and would rename somebody's file to the wrong thing.
   */
  test("nothing, when the document does not open with one", () => {
    expect(titleFor("Some thoughts first.\n\n# Weekly sync\n")).toBeNull();
    expect(titleFor("## Weekly sync\n")).toBeNull();
    expect(titleFor("#Weekly sync\n")).toBeNull();
    expect(titleFor("#\n")).toBeNull();
    expect(titleFor("#   \n")).toBeNull();
    expect(titleFor("")).toBeNull();
  });

  test("and nothing for a heading inside a fence, because the fence comes first", () => {
    expect(titleFor("```md\n# Not a title\n```\n")).toBeNull();
  });
});

describe("the rename an untitled note earns", () => {
  const PATH = "1-projects/untitled-2026-09-19.md";

  test("takes the heading and keeps the extension", () => {
    expect(nameFromTitle(PATH, "# Weekly sync\n\nBody.\n")).toBe("Weekly sync.md");
  });

  /**
   * A DRAWING STAYS A DRAWING.
   *
   * `<name>.excalidraw.md` is the format the Obsidian Excalidraw plugin reads,
   * and a rename that appended `.md` to the title would produce
   * `Ingest.md` — a note, at a path the gateway then refuses a drawing payload
   * for. The extension is carried over rather than re-derived.
   */
  test("and a drawing keeps both of its extensions", () => {
    expect(
      nameFromTitle("1-projects/untitled-2026-09-19.excalidraw.md", "# Ingest\n"),
    ).toBe("Ingest.excalidraw.md");
  });

  test("nothing while the heading is still the placeholder", () => {
    // Which is what a note reads as for the whole first second of its life:
    // `createNote` seeds `# <name>`.
    expect(nameFromTitle(PATH, "# untitled-2026-09-19\n\n")).toBeNull();
  });

  test("nothing when there is no heading to take", () => {
    expect(nameFromTitle(PATH, "Just typing.\n")).toBeNull();
  });

  /**
   * IT REFUSES RATHER THAN SANITIZES.
   *
   * A slash quietly turned into a folder, or a leading dot into a file the
   * console hides, is worse than leaving the note untitled: the person can see
   * `untitled-2026-09-19` and rename it themselves, and they cannot see that the
   * character they typed moved their note somewhere else. These are the same
   * refusals `describeNameProblem` makes, asked where there is nobody to show a
   * sentence to.
   */
  test("and refuses a heading a bucket cannot store as a name", () => {
    expect(nameFromTitle(PATH, "# 1-projects/plan\n")).toBeNull();
    expect(nameFromTitle(PATH, "# .history\n")).toBeNull();
    expect(nameFromTitle(PATH, "# back\\slash\n")).toBeNull();
    expect(nameFromTitle(PATH, `# tab\there\n`)).toBeNull();
    expect(nameFromTitle(PATH, `# ${"x".repeat(200)}\n`)).toBeNull();
  });
});
