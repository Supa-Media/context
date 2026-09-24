/**
 * SHARING A FOLDER WITH A GROUP GOES TO THE FOLDER ACTION.
 *
 * The bug, as an owner met it: open a folder in the console, press Share, pick
 * a group, and get
 *
 *   "Only markdown notes can have their own visibility. Set the folder's
 *    default instead."
 *
 * The sheet knew it was looking at a folder — it has taken `entryKind` since
 * folders were considered — and `shareWithGroup` threw the kind away and called
 * `setNoteGroup` for everything. `setNoteGroup` runs `fileOps.setVisibility`,
 * which refuses a path that is not `.md`, so the refusal came from the very
 * bottom of the stack with advice that could not be followed: the control that
 * sets a folder's default takes the two tiers and has no way to say a name.
 *
 * ## Why this is a routing test and not a rendering one
 *
 * The defect was one argument, in one callback, on a path three different
 * surfaces drive — the Browse pane's sheet, the Explorer's sheet, and the
 * group-maker's "create it and point this at it" sequence. A test that drove
 * the dialog would prove one of those and leave the other two, which is the
 * shape of the original bug: `entryKind` reached the component and stopped
 * there. So this pins the **contract** — the kind travels to the caller — and
 * asserts every call site passes it, by reading them.
 */

import { describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CONSOLE = join(__dirname, "..", "features", "console");

function read(...parts: string[]): string {
  return readFileSync(join(CONSOLE, ...parts), "utf8");
}

/** Comments are stripped so a call site quoted in prose cannot pass for one. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("the share dialog's group callback carries what it is sharing", () => {
  test("the browser contract takes a kind", () => {
    const source = stripComments(read("files", "browser.ts"));
    expect(source).toMatch(
      /shareWithGroup:\s*\(\s*path:\s*string,\s*kind:\s*"file"\s*\|\s*"folder",\s*group:\s*string\s*\)/,
    );
  });

  /**
   * The self-test for the matcher above: the shape it refuses is the shape the
   * bug had, so a regex that matched anything would be caught here rather than
   * silently passing the real file.
   */
  test("and the matcher would not accept the shape the bug had", () => {
    const buggy = 'shareWithGroup: (path: string, group: string) => void;';
    expect(buggy).not.toMatch(
      /shareWithGroup:\s*\(\s*path:\s*string,\s*kind:\s*"file"\s*\|\s*"folder",\s*group:\s*string\s*\)/,
    );
  });

  test("the hook routes a folder to the folder action and a note to the note one", () => {
    const source = stripComments(read("files", "useFileBrowser.ts"));
    const start = source.indexOf("const shareWithGroup = useCallback(");
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf("}, [", start));

    expect(body).toContain('kind === "folder"');
    expect(body).toContain("setFolderGroupAction");
    expect(body).toContain("setNoteGroupAction");
  });

  /**
   * Every surface that drives it. The original defect was that one of these
   * knew the kind and the callback did not; listing them by name is what stops
   * a fourth surface being added with the argument dropped.
   */
  test("every call site passes a kind", () => {
    /*
      `_layout.tsx` is on this list because the compiler put it there. The fix
      started at the two call sites in the Browse pane, and making `kind`
      REQUIRED rather than defaulted is what surfaced two more in the console
      frame that would otherwise have gone on calling the note action. A
      default would have compiled and shipped the same bug on two surfaces.
    */
    const sites: readonly (readonly [string, readonly string[]])[] = [
      ["BrowsePane.tsx", ["panes", "BrowsePane.tsx"]],
      ["console/layout/barDialogs.tsx", ["layout", "barDialogs.tsx"]],
    ];
    for (const [file, parts] of sites) {
      const source = stripComments(read(...parts));
      const calls = source.match(/files\.shareWithGroup\([^)]*\)/g) ?? [];
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(`${file}: ${call}`).toMatch(/\.kind|\bkind\b|"file"|"folder"/);
      }
    }
  });
});
