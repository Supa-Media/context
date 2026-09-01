/**
 * A SHARE PAGE IS READ-ONLY, AND THAT IS STRUCTURAL RATHER THAN A HABIT.
 *
 * The page `/s/<…>` draws is somebody else's note, and since an unlisted link
 * can be opened by whoever holds the URL, its reader may be a complete stranger
 * with no account at all. Nothing on that page may write.
 *
 * Today it does not, and it does not by construction: the feature holds one
 * Convex action, `readSharedNote`, and renders parsed markdown. **That is
 * exactly the sort of property that stays true until somebody adds a Save
 * button to a page they were looking at anyway**, which is why it is checked by
 * reading the files rather than left to a behavioural test that would have to
 * find a control that does not exist yet.
 *
 * The check carries its own self-test, per `A guard nobody has checked is not a
 * guard`: a file that *did* reach for a mutation is put through the same
 * scanner and has to be caught.
 */

import { describe, expect, test } from "@jest/globals";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SHARE_DIR = join(__dirname, "..", "features", "share");

/**
 * Ways a React screen reaches a write, as this codebase spells them.
 *
 * `useMutation` is Convex's write hook. `useAction` is not on the list because
 * `readSharedNote` is an action; what bounds that is the allow-list below,
 * which names the one action this feature may call.
 */
const WRITE_MARKERS = [
  "useMutation",
  "writeNote",
  "createNote",
  "setNoteVisibility",
  "setDirectoryVisibility",
  "createShare",
  "createLinkShare",
  "revokeShare",
  "runFileOperation",
];

/** The one action the feature may call, and nothing else. */
const ALLOWED_ACTIONS = ["readSharedNote"];

function sourcesIn(dir: string): { name: string; text: string }[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(ts|tsx)$/.test(entry.name))
    .map((entry) => ({
      name: entry.name,
      text: readFileSync(join(dir, entry.name), "utf8"),
    }));
}

/** Comments stripped, so prose describing a write is not read as one. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function writesIn(text: string): string[] {
  const body = code(text);
  return WRITE_MARKERS.filter((marker) => body.includes(marker));
}

function actionsIn(text: string): string[] {
  const body = code(text);
  return [...body.matchAll(/api\.functions\.[A-Za-z0-9_]+\.([A-Za-z0-9_]+)/g)].map(
    (match) => match[1]!,
  );
}

describe("nothing on a share page can write", () => {
  const files = sourcesIn(SHARE_DIR);

  test("the feature has sources to check, so this is not vacuous", () => {
    expect(files.length).toBeGreaterThan(2);
    expect(files.map((f) => f.name)).toContain("ShareScreen.tsx");
  });

  test.each(files.map((f) => [f.name, f.text] as const))(
    "%s reaches for no write",
    (_name, text) => {
      expect(writesIn(text)).toEqual([]);
    },
  );

  test.each(files.map((f) => [f.name, f.text] as const))(
    "%s calls only the one action a reader is allowed",
    (_name, text) => {
      for (const called of actionsIn(text)) {
        expect(ALLOWED_ACTIONS).toContain(called);
      }
    },
  );

  /**
   * The self-test. A scanner that matched nothing would pass every check above
   * on an empty string, so it is shown a file that does what the rule forbids.
   */
  test("the scanner catches a page that did reach for a write", () => {
    const offender = [
      'import { useMutation } from "convex/react";',
      "const save = useMutation(api.functions.files.writeNote);",
    ].join("\n");
    expect(writesIn(offender)).toContain("useMutation");
    expect(writesIn(offender)).toContain("writeNote");
  });

  test("…and is not fooled by a comment that merely mentions one", () => {
    const innocent = [
      "// This page never calls useMutation or writeNote.",
      "/* not even createShare */",
      "const x = 1;",
    ].join("\n");
    expect(writesIn(innocent)).toEqual([]);
  });

  test("…and catches an action that is not the one allowed", () => {
    const offender = "const go = useAction(api.functions.shares.createLinkShare);";
    expect(actionsIn(offender)).toEqual(["createLinkShare"]);
    expect(ALLOWED_ACTIONS).not.toContain("createLinkShare");
  });
});
