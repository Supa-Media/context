import { describe, expect, test } from "vitest";
import { clearanceOf } from "../../functions/lib/clearance";
import {
  DELETE_CONFIRMATION,
  type FileStore,
  deletePath,
  listFolder,
  movePath,
  readFile,
  setFolderVisibility,
  setVisibility,
} from "../../functions/lib/fileOps";
import {
  PRIVACY_KEY,
  canSee,
} from "../../functions/lib/privacy";
import {
  NOW,
  bucket,
  historyKeys,
  shareProjects,
  capture,
  errorShape,
  names,
} from "./fixtures.helpers";

describe('a bulk operation acts only on what the caller can see', () => {
  /**
   * The guard and the manifest writer have to answer from the same rule set.
   * Given the raw rename, the guard saw the first of two colliding rules
   * (`team`) while the writer kept the more private one — so the move was
   * allowed and then made invisible to the person who made it, who could not
   * undo it either, because `canSee` refuses them the source from that moment.
   * The fix for a duplicate manifest line reintroduced the harm the guard was
   * added for, four commits later.
   */
  test("a move the writer would hide is refused, not stranded", async () => {
    const store = bucket();
    await shareProjects(store);
    store.seed("1-projects/aaa-team/plan.md", "# The team's plan\n");
    // The destination folder must NOT exist, or the merge refusal answers first
    // and this proves nothing about the guard. A stale rule is enough to make
    // the rename collide.
    await setFolderVisibility(store, {
      path: "1-projects/zzz-hidden",
      visibility: "private",
      clearance: clearanceOf("private"),
    });
    await setFolderVisibility(store, {
      path: "1-projects/aaa-team",
      visibility: "team",
      clearance: clearanceOf("private"),
    });

    const error = await capture(() =>
      movePath(store, {
        from: "1-projects/aaa-team",
        to: "1-projects/zzz-hidden",
        clearance: clearanceOf("team"),
        now: NOW,
      }),
    );
    expect(error.code).toBe("FILE_NOT_FOUND");
    // The note stayed where its owner can still reach it.
    expect(store.snapshot()["1-projects/aaa-team/plan.md"]).toBeDefined();
    const listing = await listFolder(store, { path: "1-projects/aaa-team", clearance: clearanceOf("team") });
    expect(names(listing.entries)).toEqual(["plan.md"]);
  });

  /**
   * The collision is resolved towards private, and the first test for it chose
   * names where alphabetical order made "keep the more private" and "keep
   * whichever came last" agree — so the security property was not pinned at
   * all. This one mirrors the names so they disagree: the arriving `private`
   * rule sorts first, the pre-existing `team` rule last.
   */
  test("the arriving rule wins on privacy, not on order", async () => {
    const store = bucket();
    store.seed("1-projects/aaa/v.md", "# V\n");
    store.seed("1-projects/aaa/hr/secret.md", "# Salaries\n\n200k\n");
    await setFolderVisibility(store, {
      path: "1-projects/aaa",
      visibility: "team",
      clearance: clearanceOf("private"),
    });
    await setFolderVisibility(store, {
      path: "1-projects/aaa/hr",
      visibility: "private",
      clearance: clearanceOf("private"),
    });
    await setFolderVisibility(store, {
      path: "1-projects/zzz/hr",
      visibility: "team",
      clearance: clearanceOf("private"),
    });

    await movePath(store, {
      from: "1-projects/aaa",
      to: "1-projects/zzz",
      clearance: clearanceOf("private"),
      now: NOW,
    });

    const manifest = store.snapshot()[PRIVACY_KEY] as string;
    const lines = manifest.split("\n").filter((line) => line.includes("1-projects/zzz/hr:"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("private");
    expect(
      (
        await capture(() =>
          readFile(store, { path: "1-projects/zzz/hr/secret.md", clearance: clearanceOf("team") }),
        )
      ).code,
    ).toBe("FILE_NOT_FOUND");
  });

  /**
   * `forgetPrivacy` does not run the de-duplication, so the repair loop's own
   * two guards are all that stop it emitting a rule twice — and each of them
   * was recorded as "inert" on the strength of the other. Two survivors resting
   * on one rule is the case that needs both.
   */
  test("two survivors resting on one rule put it back once", async () => {
    const store = bucket();
    await shareProjects(store);
    store.seed("1-projects/mixed/public.md", "# Public\n");
    store.seed("1-projects/mixed/hr/pay.md", "# Pay\n");
    store.seed("1-projects/mixed/hr/bonus.md", "# Bonus\n");
    await setFolderVisibility(store, {
      path: "1-projects/mixed/hr",
      visibility: "private",
      clearance: clearanceOf("private"),
    });

    await deletePath(store, {
      path: "1-projects/mixed",
      clearance: clearanceOf("team"),
      confirmation: DELETE_CONFIRMATION,
    });

    const manifest = store.snapshot()[PRIVACY_KEY] as string;
    const lines = manifest
      .split("\n")
      .filter((line) => line.trim().startsWith("1-projects/mixed/hr:"));
    expect(lines).toHaveLength(1);
    for (const path of ["1-projects/mixed/hr/pay.md", "1-projects/mixed/hr/bonus.md"]) {
      expect((await capture(() => readFile(store, { path, clearance: clearanceOf("team") }))).code).toBe(
        "FILE_NOT_FOUND",
      );
    }
  });

  /**
   * The repaired rule has to be the one that *decided* the survivor, which is
   * the longest prefix matching it — not merely one that covers it. Two nested
   * rules of the same visibility cannot tell those apart, so this one nests a
   * `private` inside a `team`: keeping the outer rule restores a rule and still
   * publishes the note.
   */
  test("the rule put back is the one that decided the survivor", async () => {
    const store = bucket();
    await shareProjects(store);
    store.seed("1-projects/mixed/public.md", "# Public\n");
    store.seed("1-projects/mixed/hr/comp/secret.md", "# Salaries\n\n200k\n");
    await setFolderVisibility(store, {
      path: "1-projects/mixed/hr",
      visibility: "team",
      clearance: clearanceOf("private"),
    });
    await setFolderVisibility(store, {
      path: "1-projects/mixed/hr/comp",
      visibility: "private",
      clearance: clearanceOf("private"),
    });
    const secret = "1-projects/mixed/hr/comp/secret.md";
    expect((await capture(() => readFile(store, { path: secret, clearance: clearanceOf("team") }))).code).toBe(
      "FILE_NOT_FOUND",
    );

    await deletePath(store, {
      path: "1-projects/mixed",
      clearance: clearanceOf("team"),
      confirmation: DELETE_CONFIRMATION,
    });
    expect((await capture(() => readFile(store, { path: secret, clearance: clearanceOf("team") }))).code).toBe(
      "FILE_NOT_FOUND",
    );
  });

  test("a sibling listing that cannot finish refuses the delete", async () => {
    const store = bucket();
    store.seed("1-projects/a.md", "# A\n");
    store.seed("1-projects/a.md.one.md", "# One\n");
    store.seed(".history/1-projects/a.md.one.md.2026-07-01T09-00-00-000Z.md", "# older\n");

    // Only the sibling walk is made endless; the folder walk is untouched, so
    // this pins `namesExtending` rather than `keysUnder`.
    const endless: FileStore = {
      ...store,
      list: async (options) => {
        const page = await store.list(options);
        return options?.prefix === "1-projects/a.md."
          ? { ...page, truncated: true, cursor: `c${Math.random()}` }
          : page;
      },
    };
    const error = await capture(() =>
      deletePath(endless, {
        path: "1-projects/a.md",
        clearance: clearanceOf("private"),
        confirmation: DELETE_CONFIRMATION,
      }),
    );
    expect(error.code).toBe("FOLDER_TOO_LARGE");
    // Nothing was deleted, so nothing lost a history it should have kept.
    expect(store.snapshot()["1-projects/a.md"]).toBeDefined();
    expect(historyKeys(store).some((key) => key.includes("a.md.one.md."))).toBe(true);
  });


  test("deleting a note with two extending siblings keeps both their histories", async () => {
    const store = bucket();
    store.seed("1-projects/a.md", "# A\n");
    store.seed("1-projects/a.md.one.md", "# One\n");
    store.seed("1-projects/a.md.two.md", "# Two\n");
    store.seed(".history/1-projects/a.md.2026-07-01T09-00-00-000Z.md", "# older a\n");
    store.seed(".history/1-projects/a.md.one.md.2026-07-01T09-00-00-000Z.md", "# older one\n");
    store.seed(".history/1-projects/a.md.two.md.2026-07-01T09-00-00-000Z.md", "# older two\n");

    await deletePath(store, {
      path: "1-projects/a.md",
      clearance: clearanceOf("private"),
      confirmation: DELETE_CONFIRMATION,
    });
    expect(historyKeys(store).some((key) => key.includes("a.md.one.md."))).toBe(true);
    expect(historyKeys(store).some((key) => key.includes("a.md.two.md."))).toBe(true);
    expect(
      historyKeys(store).some((key) => key.endsWith("1-projects/a.md.2026-07-01T09-00-00-000Z.md")),
    ).toBe(false);
  });


  test("a survivor whose name prefixes the deleted one does not shield it", async () => {
    const store = bucket();
    await shareProjects(store);
    store.seed("1-projects/a.md.notes.md", "# Notes\n");
    store.seed("1-projects/a.md", "# A\n");
    store.seed(
      ".history/1-projects/a.md.notes.md.2026-07-01T09-00-00-000Z.md",
      "# older notes\n",
    );
    // The survivor is the SHORTER name, held back from the caller.
    await setVisibility(store, {
      path: "1-projects/a.md",
      visibility: "private",
      clearance: clearanceOf("private"),
    });

    const result = await deletePath(store, {
      path: "1-projects",
      clearance: clearanceOf("team"),
      confirmation: DELETE_CONFIRMATION,
    });
    expect(result.paths).toContain("1-projects/a.md.notes.md");
    expect(result.paths).not.toContain("1-projects/a.md");
    // The deleted note keeps no copy, even though a survivor's name prefixes it.
    expect(historyKeys(store).some((key) => key.includes("a.md.notes.md."))).toBe(false);
  });

  test("deleting a note does not take the history of one whose name extends it", async () => {
    const store = bucket();
    await shareProjects(store);
    store.seed("1-projects/a.md", "# A\n");
    store.seed("1-projects/a.md.notes.md", "# Notes\n");
    store.seed(".history/1-projects/a.md.2026-07-01T09-00-00-000Z.md", "# older a\n");
    store.seed(".history/1-projects/a.md.notes.md.2026-07-01T09-00-00-000Z.md", "# older notes\n");

    await deletePath(store, {
      path: "1-projects/a.md",
      clearance: clearanceOf("private"),
      confirmation: DELETE_CONFIRMATION,
    });
    expect(store.snapshot()["1-projects/a.md.notes.md"]).toBeDefined();
    expect(historyKeys(store).some((key) => key.includes("a.md.notes.md."))).toBe(true);
    expect(
      historyKeys(store).some((key) => key.endsWith("1-projects/a.md.2026-07-01T09-00-00-000Z.md")),
    ).toBe(false);
  });

  /**
   * The prefix match on `.history/` is not a parse, and its documented cost was
   * over-matching "another note's — equally unreachable — plumbing". That was
   * true while the whole folder went. It is false for a partial delete: the
   * over-matched note is a survivor.
   */
  test("a partial delete keeps the history of the note it kept", async () => {
    const store = bucket();
    await shareProjects(store);
    store.seed("1-projects/hist/a.md", "# A\n");
    // A survivor whose own name begins with the deleted note's name.
    store.seed("1-projects/hist/a.md.notes.md", "# Notes\n");
    store.seed(
      ".history/1-projects/hist/a.md.notes.md.2026-07-01T09-00-00-000Z.md",
      "# older notes\n",
    );
    store.seed(".history/1-projects/hist/a.md.2026-07-01T09-00-00-000Z.md", "# older a\n");
    await setVisibility(store, {
      path: "1-projects/hist/a.md.notes.md",
      visibility: "private",
      clearance: clearanceOf("private"),
    });

    const result = await deletePath(store, {
      path: "1-projects/hist",
      clearance: clearanceOf("team"),
      confirmation: DELETE_CONFIRMATION,
    });
    expect(result.paths).toEqual(["1-projects/hist/a.md"]);
    // The deleted note's history is gone...
    expect(historyKeys(store).some((key) => key.endsWith("hist/a.md.2026-07-01T09-00-00-000Z.md"))).toBe(false);
    // ...and the survivor's is not.
    expect(historyKeys(store).some((key) => key.includes("a.md.notes.md."))).toBe(true);
  });

  /**
   * `assertMoveDestinationsVisible` builds the override map a move will leave
   * behind. Built empty rather than seeded from the manifest, it cannot see an
   * exception already sitting on a destination — which put back exactly the
   * oracle the destination guard exists to close, on the move path only, while
   * the copy path stayed correct and the suite stayed green.
   */
  test("moving onto a destination hidden by its own exception discloses nothing", async () => {
    const store = bucket();
    await shareProjects(store);
    store.seed("1-projects/src.md", "# Src\n");
    store.seed("1-projects/hidden-name.md", "# Hidden\n");
    await setVisibility(store, {
      path: "1-projects/hidden-name.md",
      visibility: "private",
      clearance: clearanceOf("private"),
    });

    const taken = await capture(() =>
      movePath(store, {
        from: "1-projects/src.md",
        to: "1-projects/hidden-name.md",
        clearance: clearanceOf("team"),
        now: NOW,
      }),
    );
    // Compared against another destination this caller cannot see — the two
    // reasons it cannot see one must not be distinguishable. A *visible* free
    // name succeeds, and that residual is the folder default, not the object.
    const elsewhere = await capture(() =>
      movePath(store, {
        from: "1-projects/src.md",
        to: "2-areas/never-existed.md",
        clearance: clearanceOf("team"),
        now: NOW,
      }),
    );
    expect(errorShape(taken)).toBe(errorShape(elsewhere));
    expect(taken.code).toBe("FILE_NOT_FOUND");
    // The old reply quoted the path it had found.
    expect(taken.message).not.toContain("hidden-name.md");

    // ...and the operation still works where it is allowed to.
    const moved = await movePath(store, {
      from: "1-projects/src.md",
      to: "1-projects/free.md",
      clearance: clearanceOf("team"),
      now: NOW,
    });
    expect(moved.paths).toEqual(["1-projects/free.md"]);
  });

  /**
   * `folderVisibleAtScope` unhides a folder for a nested `team` rule. It must
   * check the visibility, not merely the prefix: a private folder whose only
   * nested rule is *also* private would otherwise appear in a team caller's
   * root listing, which is the name of a folder they were never shown.
   */
  test("a nested private rule does not unhide the folder above it", async () => {
    const store = bucket();
    await shareProjects(store);
    store.seed("3-resources/deep/a.md", "# A\n");
    await setFolderVisibility(store, {
      path: "3-resources/deep",
      visibility: "private",
      clearance: clearanceOf("private"),
    });

    const root = await listFolder(store, { path: "", clearance: clearanceOf("team") });
    expect(names(root.entries)).not.toContain("3-resources");
    // The control: the same shape with a `team` rule does unhide it.
    await setFolderVisibility(store, {
      path: "3-resources/deep",
      visibility: "team",
      clearance: clearanceOf("private"),
    });
    const shared = await listFolder(store, { path: "", clearance: clearanceOf("team") });
    expect(names(shared.entries)).toContain("3-resources");
  });

  /**
   * `rulesAfterFolderMove` now drives a security guard as well as the manifest
   * rewrite, so its segment boundary matters in a second place: without the
   * slash, moving `1-projects/sub` renames the rule belonging to
   * `1-projects/subway` and publishes its contents.
   *
   * Two checks have to be wrong for that to happen — `remapPrivacy` decides
   * whether to rewrite at all with a boundary comparison of its own, and it
   * refuses first. Breaking either alone leaves this green, which is what
   * defence in depth looks like from a test; breaking both fails it. That is
   * the property worth pinning, because the day one of them is "simplified"
   * away the other is all that is left.
   */
  test("a folder move does not rename a rule belonging to a name it prefixes", async () => {
    const store = bucket();
    await shareProjects(store);
    store.seed("1-projects/sub/note.md", "# Note\n");
    store.seed("1-projects/subway/secret.md", "# Secret\n");
    await setFolderVisibility(store, {
      path: "1-projects/subway",
      visibility: "private",
      clearance: clearanceOf("private"),
    });

    await movePath(store, {
      from: "1-projects/sub",
      to: "1-projects/sub-moved",
      clearance: clearanceOf("team"),
      now: NOW,
    });
    const leak = await capture(() =>
      readFile(store, { path: "1-projects/subway/secret.md", clearance: clearanceOf("team") }),
    );
    expect(leak.code).toBe("FILE_NOT_FOUND");
  });

  test("a folder holding nothing visible is not found, not empty", async () => {
    const store = bucket();
    await shareProjects(store);
    store.seed("1-projects/allhidden/one.md", "# One\n");
    await setVisibility(store, {
      path: "1-projects/allhidden/one.md",
      visibility: "private",
      clearance: clearanceOf("private"),
    });

    const hidden = await capture(() =>
      deletePath(store, {
        path: "1-projects/allhidden",
        clearance: clearanceOf("team"),
        confirmation: DELETE_CONFIRMATION,
      }),
    );
    const absent = await capture(() =>
      deletePath(store, {
        path: "1-projects/never-existed",
        clearance: clearanceOf("team"),
        confirmation: DELETE_CONFIRMATION,
      }),
    );
    expect(errorShape(hidden)).toBe(errorShape(absent));
    expect(store.snapshot()["1-projects/allhidden/one.md"]).toBeDefined();
  });
});

