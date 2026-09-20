/**
 * A SHARE PAGE WRITES ONE THING, AND CANNOT REACH A SECOND.
 *
 * The page `/s/<…>` draws is somebody else's note, and since an unlisted link
 * can be opened by whoever holds the URL, its reader may be a complete stranger
 * with no account at all. **That is exactly the sort of property that stays
 * true until somebody adds a Save button to a page they were looking at
 * anyway**, which is why it is checked by reading the files rather than left to
 * a behavioural test that would have to find a control that does not exist yet.
 *
 * ## This said "nothing on that page may write", and now it says less
 *
 * Collect mode gave a share link a second mode: a link its owner minted to
 * **take answers to a form** on the note it points at, from people with no
 * account. That is the feature — an intake form only members can fill in is
 * not one — and it is an argued exception in
 * `docs/decisions/privacy-and-sharing.md`, not a loosening that happened.
 *
 * So the rule this file defends is restated rather than dropped, and the new
 * one is narrower than "no writes" sounds:
 *
 *  - **One write action, named.** `submitThroughLink` and nothing else. It
 *    takes no path, no text and no destination: the link names the note, the
 *    note's own form block names the answers file, and what lands there is
 *    rendered by the server from values checked against that block's declared
 *    fields. There is no argument on it that reaches a bucket as text.
 *  - **The general-purpose writes stay unreachable.** `writeNote`,
 *    `runFileOperation`, `createShare` and the rest are still forbidden
 *    outright, and `useMutation` — the hook for every ordinary write in this
 *    app — is still not allowed anywhere in the feature.
 *
 * The check carries its own self-test, per `A guard nobody has checked is not a
 * guard`: a file that *did* reach for a mutation, and one that reached for a
 * second action, are both put through the same scanner and have to be caught.
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

/**
 * The actions the feature may call, and nothing else.
 *
 * **Two now, because the page has two addresses.** `/s/<token>` carries the
 * capability and `/@seyi/intake` carries a name the server resolves to the
 * same share row — so `readShortLink` is `readSharedNote` reached by a
 * different address, and it is that action underneath: it resolves the name
 * and delegates, rather than reimplementing anything about what a share
 * reaches.
 *
 * The list stays a list of *reads*. What this file defends is that a page
 * somebody arrived at on a link cannot write, and a second read at a second
 * address does not weaken it — but a third entry that is not a read would,
 * which is why the names are enumerated rather than matched by a prefix.
 */
const ALLOWED_ACTIONS = ["readSharedNote", "readShortLink", "submitThroughLink"];

/**
 * The one write, and what makes it the only one that could be here.
 *
 * Split out from the list above rather than blended into it, so that "this
 * feature writes exactly once" is a fact a test can assert rather than a
 * property of how long an array is. An edit that added a second write would
 * have to come here and say what it is.
 */
const ALLOWED_WRITE_ACTION = "submitThroughLink";

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
    "%s calls only the actions a reader is allowed",
    (_name, text) => {
      for (const called of actionsIn(text)) {
        expect(ALLOWED_ACTIONS).toContain(called);
      }
    },
  );

  test("the feature writes exactly once, and it is the form submission", () => {
    const called = new Set(files.flatMap((file) => actionsIn(file.text)));
    const writes = [...called].filter((name) => !name.startsWith("read"));
    expect(writes).toEqual([ALLOWED_WRITE_ACTION]);
  });

  test("...and it lives in one file, so there is one place to read the rules", () => {
    const writers = files
      .filter((file) => actionsIn(file.text).includes(ALLOWED_WRITE_ACTION))
      .map((file) => file.name);
    expect(writers).toEqual(["ShareForm.tsx"]);
  });

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

  test("…and catches an action that is not one of the allowed ones", () => {
    const offender = "const go = useAction(api.functions.shares.createLinkShare);";
    expect(actionsIn(offender)).toEqual(["createLinkShare"]);
    expect(ALLOWED_ACTIONS).not.toContain("createLinkShare");
  });

  /**
   * The one the new rule needs: a SECOND write, past the one that is allowed.
   *
   * A share page that could also retract or vote would be a page where a
   * stranger acts on an answer, and the whole stamp rule in
   * `formOps.ts` exists because they must not. `submitThroughLink` being on
   * the list must not read as "form actions are fine here".
   */
  test("…and a second write is not excused by the first one being allowed", () => {
    const offender = [
      "const send = useAction(api.functions.collect.submitThroughLink);",
      "const take = useAction(api.functions.forms.retractSubmission);",
    ].join("\n");
    const writes = actionsIn(offender).filter((name) => !name.startsWith("read"));
    expect(writes).toContain("retractSubmission");
    expect(writes).not.toEqual([ALLOWED_WRITE_ACTION]);
  });
});
