/**
 * The Privacy section's map of the manifest, and the words it is allowed to
 * use about it.
 *
 * This is a **window onto the privacy engine, not a second copy of it**. The
 * engine lives in `apps/mcp` and is ported into `functions/lib/privacy.ts`;
 * everything here reads answers that engine already computed and that arrived
 * on a `FolderListing` — `folderDefault`, `visibility`, `inherited`,
 * `exception`. So what these checks are for is the two ways a *viewer* can
 * still be wrong:
 *
 *  1. **Saying more than the listing says.** A listing is already filtered to
 *     the caller's scope, so a member's is short by construction. A panel that
 *     printed a total, inferred an absence, or drew a row for something it had
 *     not been given would be inventing the one fact this product refuses to
 *     hand over — see "The visibility tier is displayed, never stored" in
 *     `docs/decisions/privacy-and-sharing.md`.
 *  2. **Offering a control the server will refuse**, or offering the most
 *     consequential one in the product as an unremarkable press.
 *     `canSetVisibility` is the capability the console's one real
 *     authorization defect was about (`features/console/capabilities.ts`), and
 *     every decision that reads it lives in a pure module for the reason that
 *     file states: across a full sabotage sweep, every guard expressed as a
 *     pure module was held and every guard expressed inside a component was
 *     not.
 */

import { describe, expect, test } from "@jest/globals";
import {
  folderControl,
  privacyViewOf,
  type PrivacyFolderView,
} from "../features/console/privacy/map";
import { scopeOf } from "../features/console/files/scope";
import { isGroupVisibility } from "../features/console/files/types";
import {
  BROKEN_MANIFEST_HEADLINE,
  brokenManifestNext,
  exceptionLine,
  folderDefaultLine,
  noExceptionsLine,
  linkExceptionLine,
  manifestFootLine,
  privateMeans,
  rootDefaultLine,
  teamMeans,
  truncatedLine,
  visibilityWord,
  widenWarning,
} from "../features/console/privacy/words";
import type { FileEntry, FolderListing, Visibility } from "../features/console/files/types";

const BOTH: Visibility[] = ["private", "team"];

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

function folder(path: string, visibility: Visibility): FileEntry {
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

function listing(
  path: string,
  folderDefault: Visibility,
  entries: FileEntry[],
  over: Partial<FolderListing> = {},
): FolderListing {
  return { path, folderDefault, entries, truncated: false, manifestUsable: true, ...over };
}

/** An owner's root: three folders, one of them open to the team. */
const ROOT = listing("", "private", [
  folder("0-inbox", "private"),
  folder("1-projects", "team"),
  folder("2-areas", "private"),
  file("index.md"),
  file("privacy.md", { readOnly: true }),
]);

function ready(view: PrivacyFolderView): Extract<PrivacyFolderView, { state: "ready" }> {
  if (view.state !== "ready") throw new Error(`expected a ready view, got ${view.state}`);
  return view;
}

describe("what the map draws", () => {
  test("a folder nobody has listed is loading, never empty", () => {
    // The difference between "this folder holds nothing" and "we have not
    // asked yet" is the difference between a fact about somebody's notes and
    // a spinner. Absent must never render as the first.
    expect(privacyViewOf({}, "").state).toBe("loading");
    expect(privacyViewOf({ "": ROOT }, "1-projects").state).toBe("loading");
  });

  test("every folder in the listing gets a row, carrying its own default", () => {
    const view = ready(privacyViewOf({ "": ROOT }, ""));
    expect(view.folders.map((row) => [row.name, row.visibility])).toEqual([
      ["0-inbox", "private"],
      ["1-projects", "team"],
      ["2-areas", "private"],
    ]);
  });

  test("and nothing else does — a row is never invented", () => {
    // The listing is the whole input. A folder the server did not send is a
    // folder this caller may not see, and drawing a placeholder for it would
    // be an existence oracle with a nicer label.
    const view = ready(privacyViewOf({ "": ROOT }, ""));
    expect(view.folders.some((row) => row.path === "3-resources")).toBe(false);
  });

  test("the folder's own default rides on the view, for the sentence above the rows", () => {
    expect(ready(privacyViewOf({ "": ROOT }, "")).folderDefault).toBe("private");
  });

  test("only notes the manifest names by hand are listed", () => {
    // `privacy.md` is folder defaults **plus exact-note exceptions**, and the
    // exceptions are the half a folder row cannot state. Listing every note
    // beside them would draw the defaults twice and bury them — the same rule
    // the tree's markers follow (`FileEntry.exception`).
    const held = file("1-projects/pay.md", { inherited: "team", exception: true });
    const shared = file("1-projects/brief.md", {
      visibility: "team",
      inherited: "team",
    });
    const view = ready(
      privacyViewOf(
        { "1-projects": listing("1-projects", "team", [held, shared]) },
        "1-projects",
      ),
    );
    expect(view.exceptions.map((row) => row.path)).toEqual(["1-projects/pay.md"]);
  });

  test("privacy.md is never listed as an exception, whatever the rules say about it", () => {
    // Its answer is hardcoded owner-only inside `canSee`, so a row calling it
    // `team` would be the one place in this panel that says something the
    // engine does not do.
    const manifest = file("privacy.md", {
      readOnly: true,
      visibility: "team",
      inherited: "private",
      exception: true,
    });
    const view = ready(privacyViewOf({ "": listing("", "private", [manifest]) }, ""));
    expect(view.exceptions).toHaveLength(0);
  });

  test("a short listing says it is short", () => {
    const view = ready(
      privacyViewOf(
        { "": listing("", "private", [folder("a", "private")], { truncated: true }) },
        "",
      ),
    );
    expect(view.truncated).toBe(true);
    expect(truncatedLine()).toMatch(/not the whole/i);
  });

  test("a manifest that will not parse is its own state, and it is not 'everything private'", () => {
    // The bucket really does read all-private in this state, but saying so as
    // a *setting* would tell somebody their rules are being honoured when the
    // file holding them cannot be read at all.
    const view = privacyViewOf(
      { "": listing("", "private", [folder("a", "private")], { manifestUsable: false }) },
      "",
    );
    expect(view.state).toBe("broken");
  });
});

describe("the control on a row", () => {
  test("nobody who cannot set visibility is offered one", () => {
    // Owner-only, and absent rather than disabled: the server refuses anyone
    // else with `minimum: "owner"`, and `run` in `useFileBrowser` silently
    // does nothing on a console that cannot edit — so a drawn control here
    // would be a press that lies twice over.
    for (const visibility of BOTH) {
      expect(
        folderControl(false, { path: "1-projects", name: "1-projects", visibility }),
      ).toBeNull();
    }
  });

  test("an owner gets one, and it moves to the other of the two words", () => {
    for (const visibility of BOTH) {
      const control = folderControl(true, { path: "x", name: "x", visibility });
      expect(control).not.toBeNull();
      expect(control!.to).not.toBe(visibility);
      expect(BOTH).toContain(control!.to);
    }
  });

  test("widening is the armed direction and narrowing is not", () => {
    // Publishing a folder makes every note in it that is not held back
    // individually readable by everyone in People, and there is no count of
    // those anywhere the console can reach. Closing one back is the cheap
    // direction and stays a single press.
    expect(folderControl(true, { path: "x", name: "x", visibility: "private" })!.arm).toBe(
      true,
    );
    expect(folderControl(true, { path: "x", name: "x", visibility: "team" })!.arm).toBe(
      false,
    );
  });

  test("the root is a fact, never a control", () => {
    // `default_visibility` is fixed `private` in the rendered manifest — the
    // scaffold opens named folders and never the default — so a control on
    // the root row would be a press with nothing behind it.
    for (const visibility of BOTH) {
      expect(folderControl(true, { path: "", name: "", visibility })).toBeNull();
    }
  });

  test("the armed press says what it is about to publish, by name", () => {
    expect(widenWarning("2-areas")).toContain("2-areas");
    expect(widenWarning("2-areas")).toMatch(/everyone/i);
    /*
      **And it says what the press does not reach.** `setFolderVisibility`
      replaces one `folder_defaults` prefix rule and hands `overrides` back
      untouched, so longest-prefix leaves a subfolder with its own `private`
      rule private and every note held back by name held back. The first
      version said "every note in it", which is the right *direction* to err
      in and still a claim a person can catch being wrong — and a warning
      somebody has caught out once is one they stop reading.
    */
    expect(widenWarning("2-areas")).toMatch(/held back by name/i);
    expect(widenWarning("2-areas")).toMatch(/subfolder with a rule of its own/i);
    // Still the strong half: the default governs what lands there next.
    expect(widenWarning("2-areas")).toMatch(/later/i);
  });
});

describe("a folder the two-position control cannot describe", () => {
  /**
   * `folderControl` answers "the other of the two words". A folder whose rule
   * names a group has no other word, and the guess it would otherwise make is
   * `team` — a single press that publishes what the owner held back. Absent
   * rather than disabled, the rule this console already follows for every
   * owner-only control.
   */
  test("a group-scoped folder offers no toggle at all", () => {
    expect(
      folderControl(true, { path: "2-areas/feedback", name: "feedback", visibility: "@supa-owners" }),
    ).toBeNull();
  });

  test("...while the two tiers still both offer one, in their own directions", () => {
    expect(folderControl(true, { path: "2-areas", name: "2-areas", visibility: "team" })).toEqual({
      to: "private",
      arm: false,
    });
    expect(folderControl(true, { path: "2-areas", name: "2-areas", visibility: "private" })).toEqual({
      to: "team",
      arm: true,
    });
  });
});

describe("the words", () => {
  test("there are two of them, and no surface can produce a third", () => {
    expect(BOTH.map(visibilityWord)).toEqual(["Private", "Team"]);
    expect(new Set(BOTH.map(visibilityWord)).size).toBe(2);
  });

  /**
   * Two TIERS, and then the group's own name.
   *
   * `visibilityWord` used to end in a `!== "team"` fall through to "Private",
   * which is why this is asserted rather than assumed: a note two colleagues
   * can read, labelled as reaching nobody but its owner, is the overstatement
   * this module's header opens by forbidding.
   */
  test("a group rule is named, never flattened into `Private`", () => {
    expect(visibilityWord("@supa-leads")).toBe("@supa-leads");
    expect(visibilityWord("@supa-leads")).not.toBe("Private");
    expect(visibilityWord("@kola")).toBe("@kola");
  });

  test("nothing here says a setting can publish to the internet", () => {
    // CLAUDE.md #5: no setting publishes a context, a folder, or a visibility
    // class, and nothing here is indexed. The one exception is a single note
    // on a link an owner mints and can revoke — a share row, and it says so.
    const spoken = [
      ...BOTH.map(visibilityWord),
      ...BOTH.flatMap((v) => [folderDefaultLine(v)]),
      ...[true, false].flatMap((owner) => [
        privateMeans("personal", owner),
        teamMeans("personal", owner),
        privateMeans("shared", owner),
        teamMeans("shared", owner),
        privateMeans(null, owner),
        teamMeans(null, owner),
      ]),
    ].join(" ");
    expect(spoken).not.toMatch(/\bpublic\b/i);
    expect(spoken).not.toMatch(/search engine|indexed by/i);
    expect(linkExceptionLine()).toMatch(/one note/i);
    expect(linkExceptionLine()).toMatch(/revoke/i);
  });

  test("private means something different in a workspace, and it is said out loud", () => {
    // The one thing a member cannot work out from the rules, and the thing
    // somebody otherwise learns by marking a folder private and locking out
    // their co-lead.
    expect(privateMeans("shared", true)).toMatch(/owner/i);
    expect(privateMeans("shared", true)).not.toBe(privateMeans("personal", true));
    /*
      **The roles it excludes, by name, and this is the half the first version
      of this check missed.** Deleting the whole `shared` branch fell through
      to the kind-unknown sentence — "Owners only. No role and no invitation
      reaches it" — which is still true, still matches /owner/i, and still
      differs from a brain's, so the mutation passed all 68 checks. What it
      lost is the sentence a *member* needs: that being an editor here does
      not carry it. That is the thing this line exists to say, so it is the
      thing to assert.
    */
    expect(privateMeans("shared", true)).toMatch(/member/i);
    expect(privateMeans("shared", true)).toMatch(/editor/i);
    // And a workspace reads the same to everybody in it: "owners only" names a
    // role rather than a person, so there is nothing for the reader's own
    // membership to change.
    expect(privateMeans("shared", false)).toBe(privateMeans("shared", true));
  });

  test("a brain read by somebody else is never called theirs", () => {
    /*
      Found by rendering `@lk` — the demo's *other* person's brain, read at
      `member`. "Yours alone. …no AI client of anybody else's reaches it — the
      only way to hand a private note over is to mark it team" is the owner's
      sentence, and every clause of it is false for the reader: the notes are
      not theirs, the AI client that cannot reach them is theirs, and the
      marking is not theirs to do. A brain has exactly one owner, so the
      reader's own membership is the whole difference.
    */
    expect(privateMeans("personal", true)).toMatch(/^Yours alone/);
    expect(privateMeans("personal", false)).not.toMatch(/Yours alone/);
    expect(privateMeans("personal", false)).toMatch(/its owner's alone/i);
    expect(teamMeans("personal", true)).toMatch(/you have given access/i);
    expect(teamMeans("personal", false)).toMatch(/its owner has given access/i);
  });

  test("an exception is described by the direction it goes", () => {
    expect(
      exceptionLine({ path: "a/b.md", name: "b.md", visibility: "private", inherited: "team" }),
    ).toMatch(/held back/i);
    expect(
      exceptionLine({ path: "a/b.md", name: "b.md", visibility: "team", inherited: "private" }),
    ).toMatch(/shared/i);
  });

  test("the file is named without claiming whose bucket it is in", () => {
    /*
      Two readers make "your own bucket" false: somebody on managed storage,
      whose bucket we create and pay for — the exit is identical on both plans
      and *that* is the promise, not ownership of the bucket — and a member
      reading somebody else's context, for whom none of it is theirs.
    */
    expect(manifestFootLine()).toContain("privacy.md");
    expect(manifestFootLine()).not.toMatch(/your (own )?bucket/i);
  });

  test("the root is described as the root, not as a folder", () => {
    // What it governs is a note at the top of the bucket **and** every folder
    // nobody has ruled on — including one added next month, which is the half
    // a folder's own sentence cannot say.
    expect(rootDefaultLine("private")).toMatch(/tomorrow|added/i);
    expect(rootDefaultLine("private")).not.toBe(folderDefaultLine("private"));
  });

  test("a broken manifest offers the repair only to somebody who has it", () => {
    expect(BROKEN_MANIFEST_HEADLINE).toMatch(/privacy\.md/);
    expect(brokenManifestNext(true)).toMatch(/browse/i);
    expect(brokenManifestNext(false)).toMatch(/owner/i);
    expect(brokenManifestNext(false)).not.toMatch(/browse/i);
  });
});

/**
 * The console may not retier a group note, from any surface.
 *
 * This is the regression an adversarial review found, and it is worth stating
 * exactly because the shape is instructive. Before groups, a hand-edited group
 * rule made the control plane's read validator *throw* — loud, and nobody saw
 * a wrong label. Widening the validator replaced that with a quiet mislabel:
 * `scopeOf` maps a group to the `private` POSITION, so the three-way control
 * drew a closed padlock, offered "Share this with your team", and pressing it
 * wrote `team` — which deletes the group rule and publishes the note.
 *
 * The guard now lives in `useFileBrowser`'s `setVisibility` and `setScope`,
 * which every surface goes through, rather than on the one control that was
 * fixed first. What is asserted here is the pure half: the position is still
 * `private` (that part was right), and every control-level predicate that
 * decides whether to OFFER a step refuses.
 */
describe("a group rule is never a position the console can press through", () => {
  test("scopeOf still answers `private`, because a group is not team", () => {
    expect(scopeOf("@supa-leads", false)).toBe("private");
    expect(scopeOf("@supa-leads", true)).toBe("private");
  });

  test("...and the two tiers are unchanged", () => {
    expect(scopeOf("private", false)).toBe("private");
    expect(scopeOf("team", false)).toBe("team");
    expect(scopeOf("team", true)).toBe("anyone");
  });

  test("isGroupVisibility is the one predicate every surface asks", () => {
    expect(isGroupVisibility("@supa-leads")).toBe(true);
    expect(isGroupVisibility("@kola")).toBe(true);
    expect(isGroupVisibility("private")).toBe(false);
    expect(isGroupVisibility("team")).toBe(false);
  });

  test("no copy about a group folder calls it private or claims it is yours alone", () => {
    const said = [
      folderDefaultLine("@supa-leads"),
      rootDefaultLine("@supa-leads"),
      noExceptionsLine("@supa-leads"),
      visibilityWord("@supa-leads"),
    ].join(" ");
    expect(said).not.toMatch(/yours alone/i);
    expect(said).not.toMatch(/\bprivate\b/i);
    expect(folderDefaultLine("@supa-leads")).toContain("@supa-leads");
    expect(rootDefaultLine("@supa-leads")).toContain("@supa-leads");
  });
});
