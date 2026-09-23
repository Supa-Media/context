/**
 * EVERY SITE THAT DRAWS SOMEBODY ELSE'S NAME IN CONTEXT'S OWN VOICE.
 *
 * A note's key comes out of a bucket we do not own: Obsidian's sync plugin,
 * rclone and the provider's console all write keys directly, and an editor in
 * a shared workspace chooses filenames. One U+202E RIGHT-TO-LEFT OVERRIDE in
 * a filename reverses the rendering of everything after it, so the status bar,
 * the breadcrumb, the tab strip, a row, a dialog title and a toast can all be
 * made to read as something other than what they say — beside the app's own
 * labels, in the surface where the app speaks for itself.
 *
 * `isolateForDisplay` (`packages/shared/src/displayText.cjs`) contains rather
 * than cleans, and the argument is in its header: stripping is a blocklist and
 * reaches exactly as far as its list, while a container does not depend on
 * recognising the character.
 *
 * **This file is the enumeration.** One test per display boundary, each with
 * the byte-identical control beside it, because a container that wraps
 * everything would pass a containment check and break every label.
 *
 * The three things that must NOT be contained have their own test at the foot:
 * a path is compared, keyed and copied, and containing one would be a rename
 * in somebody's bucket wearing a display fix's clothes.
 */

import { describe, expect, test } from "@jest/globals";

import { crumbsFor } from "../features/console/files/crumbs";
import { noteHeading } from "../features/console/files/frontmatter";
import { displayName, displayPath, folderLabel } from "../features/console/files/paths";
import { statusSegments } from "../features/console/files/status";
import { tabLabel } from "../features/console/files/tabs";

const RLO = String.fromCharCode(0x202e);
const FSI = String.fromCharCode(0x2068);
const PDI = String.fromCharCode(0x2069);

/** A filename somebody chose, and the same name with nothing hostile in it. */
const HOSTILE = `sei${RLO}fdp.md`;
const ORDINARY = "seifdp.md";

describe("the console contains a name it did not choose", () => {
  test("a row, a toast and the activity feed — displayName", () => {
    expect(displayName(HOSTILE)).toBe(`${FSI}sei${RLO}fdp${PDI}`);
    expect(displayName(ORDINARY)).toBe("seifdp");
    // The sort number is still filing rather than a name.
    expect(displayName(`1-${ORDINARY}`)).toBe("seifdp");
  });

  test("a place named in a sentence — displayPath", () => {
    expect(displayPath(`1-projects/pl${RLO}an`)).toBe(`${FSI}projects/pl${RLO}an${PDI}`);
    expect(displayPath("1-projects/planning")).toBe("projects/planning");
  });

  test("a folder's label, which keeps its extension — folderLabel", () => {
    expect(folderLabel(`1-proj${RLO}ects`)).toBe(`${FSI}proj${RLO}ects${PDI}`);
    expect(folderLabel("1-projects")).toBe("projects");
    // Unlike displayName, this does not strip `.md`: a folder called
    // `notes.md` is a folder called `notes.md`.
    expect(folderLabel("notes.md")).toBe("notes.md");
  });

  test("the breadcrumb — every label, and never the path", () => {
    const crumbs = crumbsFor(`1-pro${RLO}jects/plan.md`);
    expect(crumbs.map((crumb) => crumb.label)).toEqual([
      `${FSI}pro${RLO}jects${PDI}`,
      "plan",
    ]);
    // The path is what pressing a crumb asks the bucket for. It is the real
    // key, untouched.
    expect(crumbs.map((crumb) => crumb.path)).toEqual([
      `1-pro${RLO}jects`,
      `1-pro${RLO}jects/plan.md`,
    ]);
    // A title from the note's own frontmatter is somebody else's string too.
    expect(crumbsFor("1-projects/plan.md", { title: `Q3${RLO} plan` })[1]!.label).toBe(
      `${FSI}Q3${RLO} plan${PDI}`,
    );
    expect(crumbsFor("1-projects/plan.md")[1]!.label).toBe("plan");
  });

  test("the tab strip — the label, with the collision test unaffected", () => {
    const state = { tabs: [{ path: `1-projects/${HOSTILE}`, dirty: false }] } as never;
    expect(tabLabel(state, `1-projects/${HOSTILE}`)).toBe(`${FSI}sei${RLO}fdp${PDI}`);
    /*
      Two notes whose names differ ONLY by the override still collide, because
      the collision test compares the untouched names — if it compared
      contained ones it would still agree, but the qualifier it produces is the
      thing being tested here: both get their folder.
    */
    const both = {
      tabs: [
        { path: `1-projects/${ORDINARY}`, dirty: false },
        { path: `2-areas/${ORDINARY}`, dirty: false },
      ],
    } as never;
    expect(tabLabel(both, `1-projects/${ORDINARY}`)).toBe("projects/seifdp");
  });

  test("the note's own heading — noteHeading", () => {
    expect(noteHeading("", `1-projects/${HOSTILE}`)).toBe(`${FSI}sei${RLO}fdp${PDI}`);
    expect(noteHeading("", `1-projects/${ORDINARY}`)).toBe("seifdp");
    // A title the note gives itself is the same class of string.
    expect(noteHeading(`# Q3${RLO} plan\n`, "1-projects/plan.md")).toBe(
      `${FSI}Q3${RLO} plan${PDI}`,
    );
  });

  test("the status bar, which draws the key itself", () => {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { emptyEditor, editorReducer } =
      require("../features/console/files/editor") as typeof import("../features/console/files/editor");
    /* eslint-enable @typescript-eslint/no-require-imports */
    const pathOf = (path: string) => {
      const opened = editorReducer(emptyEditor, {
        type: "opened",
        note: {
          path,
          text: "",
          etag: "e1",
          visibility: "private",
          inherited: "private",
          exception: false,
          readOnly: false,
        },
      } as never);
      const segments = statusSegments({ editor: opened, storageLabel: null, now: 0 });
      return segments.find((segment) => segment.id === "path")?.text;
    };
    expect(pathOf(`1-projects/${HOSTILE}`)).toBe(`${FSI}1-projects/sei${RLO}fdp.md${PDI}`);
    // The ordinary key is byte-identical, which is what keeps the bar's whole
    // purpose — a key somebody copies into another client — intact.
    expect(pathOf(`1-projects/${ORDINARY}`)).toBe(`1-projects/${ORDINARY}`);
  });
  /*
    AND THE ENUMERATION STAYS AN ENUMERATION.

    Seven contained boundaries is a rule; seven contained boundaries and an
    eighth component trimming a name by hand is a convention, and a convention
    is what the next feature quietly opts out of. `withoutSortPrefix` is the
    mid-pipeline trim — its stated property is that the result is always a
    suffix of what went in, `displayName` slices three characters off the end
    of it, and `tabLabel` compares two of them — so it is the one thing in this
    area that must NOT contain, and therefore the one thing a renderer must not
    call.

    The allowance below is the four functions that trim on the way to their own
    contained exit. Anything else calling it is a new display site that skipped
    the rule, and this test is how it is found on the day it is written rather
    than in the next sweep.
  */
  test("no component trims a name for display itself", () => {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    /* eslint-enable @typescript-eslint/no-require-imports */
    const allowed = new Set([
      // The trim itself, and the two labels built on it.
      "features/console/files/paths.ts",
      // Each of these contains at its own exit; the trim is mid-pipeline.
      "features/console/files/crumbs.ts",
      "features/console/files/frontmatter.ts",
      "features/console/files/tabs.ts",
    ]);
    const found = execFileSync(
      "grep",
      ["-rl", "--include=*.ts", "--include=*.tsx", "withoutSortPrefix(", "features"],
      { cwd: `${__dirname}/..`, encoding: "utf8" },
    )
      .split("\n")
      .filter((line) => line !== "")
      .filter((file) => !allowed.has(file));
    expect(found).toEqual([]);
  });
});
