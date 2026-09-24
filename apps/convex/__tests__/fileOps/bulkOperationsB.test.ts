import { describe, expect, test } from "vitest";
import { clearanceOf } from "../../functions/lib/clearance";
import {
  DELETE_CONFIRMATION,
  type FileStore,
  createFolder,
  deletePath,
  movePath,
  readFile,
  setFolderVisibility,
  setVisibility,
} from "../../functions/lib/fileOps";
import {
  PRIVACY_KEY,
  canSee,
} from "../../functions/lib/privacy";
import { type MemoryStore } from "../storeStub.helpers";
import {
  NOW,
  bucket,
  shareProjects,
  capture,
  errorShape,
} from "./fixtures.helpers";

describe('a bulk operation acts only on what the caller can see', () => {
  /**
   * The survivor comparison ends in a `.` for the same reason the match it
   * undoes does. Without it a survivor's name that merely *prefixes* the
   * deleted note's protects history the delete promised to purge — the
   * `permanently delete` lie this function's own comment calls out, arrived at
   * from the other side.
   */
  /**
   * Two rules covering one survivor redundantly — what an owner has after
   * tightening a folder and then a subfolder inside it. Asked one rule at a
   * time, removing either changes nothing, so neither looks needed and both go;
   * the note then lands on the nearest surviving ancestor, which is the `team`
   * folder the caller is standing in. The question has to be asked of the
   * rewrite, not of the rule.
   */
  test("redundant rules over one survivor are not both dropped", async () => {
    async function twoRules(): Promise<MemoryStore & FileStore> {
      const store = bucket();
      await shareProjects(store);
      store.seed("1-projects/mixed/public.md", "# Public\n");
      store.seed("1-projects/mixed/hr/comp/secret.md", "# Salaries\n\n200k\n");
      await setFolderVisibility(store, {
        path: "1-projects/mixed/hr",
        visibility: "private",
        clearance: clearanceOf("private"),
      });
      await setFolderVisibility(store, {
        path: "1-projects/mixed/hr/comp",
        visibility: "private",
        clearance: clearanceOf("private"),
      });
      return store;
    }
    const secret = "1-projects/mixed/hr/comp/secret.md";

    const deleted = await twoRules();
    await deletePath(deleted, {
      path: "1-projects/mixed",
      clearance: clearanceOf("team"),
      confirmation: DELETE_CONFIRMATION,
    });
    expect((await capture(() => readFile(deleted, { path: secret, clearance: clearanceOf("team") }))).code).toBe(
      "FILE_NOT_FOUND",
    );
    expect((await readFile(deleted, { path: secret, clearance: clearanceOf("private") })).text).toContain("200k");

    const moved = await twoRules();
    await movePath(moved, {
      from: "1-projects/mixed",
      to: "1-projects/moved",
      clearance: clearanceOf("team"),
      now: NOW,
    });
    expect((await capture(() => readFile(moved, { path: secret, clearance: clearanceOf("team") }))).code).toBe(
      "FILE_NOT_FOUND",
    );
  });

  /**
   * The other half of the same question, at owner scope.
   *
   * It does **not** fail a "keep every rule under the folder" implementation,
   * which an earlier version of this comment claimed. At owner scope the walk
   * withholds nothing, so `survivors` is empty and `rulesSurvivorsRestOn`
   * returns `[]` from its first line, before the candidate list exists;
   * `return [...candidates]` passes this test. What actually pins the drop is
   * `a rule no survivor rests on is dropped, at team scope` below, on the
   * delete path, and `the moved folder's own rule does not stay behind on a
   * private prefix` at the end of this file, on the move path — both verified
   * by making that substitution and watching them fail.
   *
   * What this one is worth is the owner-scope rename itself: the rule follows
   * the folder and nothing is left on the old prefix.
   */
  test("a rule no survivor needs is not retained", async () => {
    const store = bucket();
    store.seed("2-areas/shared/a.md", "# A\n");
    store.seed("2-areas/shared/x.md", "# X\n");
    await setFolderVisibility(store, {
      path: "2-areas/shared",
      visibility: "team",
      clearance: clearanceOf("private"),
    });
    await setVisibility(store, {
      path: "2-areas/shared/x.md",
      visibility: "private",
      clearance: clearanceOf("private"),
    });

    await movePath(store, {
      from: "2-areas/shared",
      to: "2-areas/renamed",
      clearance: clearanceOf("private"),
      now: NOW,
    });
    const manifest = store.snapshot()[PRIVACY_KEY] as string;
    expect(manifest).toContain("2-areas/renamed: team");
    // The old prefix keeps no rule. Not because a survivor did not need it —
    // there is no survivor here, the walk is at owner scope and both notes
    // moved. The rule follows the folder, and nothing is left pointing at an
    // empty prefix. (Two earlier comments here described a survivor held back
    // by its exception, and a third said "the keys afterwards are" three
    // particular ones — the bucket holds fourteen. Both are the same habit of
    // counting in prose what the suite can assert, so it is an assertion now
    // rather than a sentence.)
    expect(manifest).not.toContain("2-areas/shared: team");
    expect(
      Object.keys(store.snapshot()).filter((key) => key.startsWith("2-areas/shared/")),
    ).toEqual([]);
    // The exception travelled with it, so the note is private at its new path.
    // Asserting the OLD path was unreadable proved nothing — it had moved away,
    // so it was unreadable for the trivial reason and stayed unreadable with
    // the exception dropped entirely.
    expect(
      (await capture(() => readFile(store, { path: "2-areas/renamed/x.md", clearance: clearanceOf("team") }))).code,
    ).toBe("FILE_NOT_FOUND");
    expect((await readFile(store, { path: "2-areas/renamed/x.md", clearance: clearanceOf("private") })).text).toBe(
      "# X\n",
    );
  });

  /**
   * The repair is one pass, and what makes one pass sound is that a renamed
   * rule lands under the destination where it cannot outrank a rule kept under
   * the source. That holds only while the two trees are disjoint. Moving a
   * folder onto its own ancestor overlaps them, and a renamed rule came out
   * longer than the repair and published the survivor — so that move is
   * refused, and this is the test that says why.
   */
  test("a folder cannot be moved onto a folder it is already inside", async () => {
    const store = bucket();
    store.seed("1-projects/a/b/visible.md", "# V\n");
    store.seed("1-projects/a/b/hr/deep/secret.md", "# Salaries\n\n200k\n");
    store.seed("1-projects/a/b/b/hr/deep/other.md", "# Other\n");
    await setFolderVisibility(store, {
      path: "1-projects/a/b",
      visibility: "team",
      clearance: clearanceOf("private"),
    });
    await setFolderVisibility(store, {
      path: "1-projects/a/b/hr",
      visibility: "private",
      clearance: clearanceOf("private"),
    });
    await setFolderVisibility(store, {
      path: "1-projects/a/b/b/hr/deep",
      visibility: "team",
      clearance: clearanceOf("private"),
    });
    const secret = "1-projects/a/b/hr/deep/secret.md";

    const error = await capture(() =>
      movePath(store, { from: "1-projects/a/b", to: "1-projects/a", clearance: clearanceOf("team"), now: NOW }),
    );
    expect(error.code).toBe("PATH_INVALID");
    expect((await capture(() => readFile(store, { path: secret, clearance: clearanceOf("team") }))).code).toBe(
      "FILE_NOT_FOUND",
    );
    // The owner is refused too — this is a nonsensical rename, not a clearance
    // question, and letting it through at `private` scope would leave the same
    // contradictory manifest behind.
    expect(
      (
        await capture(() =>
          movePath(store, {
            from: "1-projects/a/b",
            to: "1-projects/a",
            clearance: clearanceOf("private"),
            now: NOW,
          }),
        )
      ).code,
    ).toBe("PATH_INVALID");
  });

  /**
   * A rename can land a rule on a prefix that already carries one, and the
   * manifest then says two things about the same folder. `visibilityOf` takes
   * the first of equal length and the render sort is stable, so the winner
   * survives the round trip — measured as `1-projects/dst/hr` emitted both
   * `team` and `private`. Resolved towards private, the only direction that
   * cannot leak.
   */
  test("a rule arriving on an occupied prefix does not publish what was there", async () => {
    const store = bucket();
    store.seed("1-projects/src/v.md", "# V\n");
    store.seed("1-projects/src/hr/secret.md", "# Salaries\n\n200k\n");
    await setFolderVisibility(store, {
      path: "1-projects/src",
      visibility: "team",
      clearance: clearanceOf("private"),
    });
    await setFolderVisibility(store, {
      path: "1-projects/src/hr",
      visibility: "private",
      clearance: clearanceOf("private"),
    });
    // A rule for a folder that does not exist — left behind by a delete, or
    // hand-written. This is the only way a rename can still collide now that
    // moving a folder onto an existing one is refused outright.
    await setFolderVisibility(store, {
      path: "1-projects/dst/hr",
      visibility: "team",
      clearance: clearanceOf("private"),
    });

    await movePath(store, {
      from: "1-projects/src",
      to: "1-projects/dst",
      clearance: clearanceOf("private"),
      now: NOW,
    });

    const manifest = store.snapshot()[PRIVACY_KEY] as string;
    const lines = manifest.split("\n").filter((line) => line.includes("1-projects/dst/hr:"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("private");
    // ...and the note that arrived under it is still private, which is what
    // the one line has to mean.
    expect(
      (
        await capture(() =>
          readFile(store, { path: "1-projects/dst/hr/secret.md", clearance: clearanceOf("team") }),
        )
      ).code,
    ).toBe("FILE_NOT_FOUND");
  });

  /**
   * The commit that introduced the repair was about a SET of survivors, and
   * every test for it had exactly one — so reducing the loop to its first
   * element, or breaking out of it early, changed nothing that was measured.
   * This has two survivors resting on two different rules, with the one that
   * needs no repair sorting first.
   */
  test("every survivor is repaired, not just the first", async () => {
    const store = bucket();
    await shareProjects(store);
    store.seed("1-projects/mixed/public.md", "# Public\n");
    // Sorts first, held back by its own exception, needs no rule put back.
    store.seed("1-projects/mixed/aaa.md", "# A\n");
    store.seed("1-projects/mixed/hr/pay.md", "# Pay\n\n200k\n");
    store.seed("1-projects/mixed/legal/case.md", "# Case\n\nsettlement\n");
    await setVisibility(store, {
      path: "1-projects/mixed/aaa.md",
      visibility: "private",
      clearance: clearanceOf("private"),
    });
    await setFolderVisibility(store, {
      path: "1-projects/mixed/hr",
      visibility: "private",
      clearance: clearanceOf("private"),
    });
    await setFolderVisibility(store, {
      path: "1-projects/mixed/legal",
      visibility: "private",
      clearance: clearanceOf("private"),
    });

    await deletePath(store, {
      path: "1-projects/mixed",
      clearance: clearanceOf("team"),
      confirmation: DELETE_CONFIRMATION,
    });

    for (const path of [
      "1-projects/mixed/aaa.md",
      "1-projects/mixed/hr/pay.md",
      "1-projects/mixed/legal/case.md",
    ]) {
      expect((await capture(() => readFile(store, { path, clearance: clearanceOf("team") }))).code).toBe(
        "FILE_NOT_FOUND",
      );
      expect(store.snapshot()[path]).toBeDefined();
    }
  });

  /**
   * `movePath`'s own header says "the destination must not exist: this never
   * merges and never overwrites". That was true of files — the collision loop
   * checks them key by key — and never true of folders. Moving `src` onto an
   * existing `dst` merged them, and the rename carried `src`'s folder rule onto
   * `dst`, where it reached notes that were already there. Measured: an owner's
   * `dst/secret.md` went from hidden to readable for the team caller who moved
   * their own folder next to it.
   */
  test("a folder move does not publish what was already at the destination", async () => {
    const store = bucket();
    await shareProjects(store);
    store.seed("1-projects/src/plan.md", "# Plan\n");
    store.seed("2-areas/dst/secret.md", "# Salaries\n\n200k\n");
    await setFolderVisibility(store, {
      path: "1-projects/src",
      visibility: "team",
      clearance: clearanceOf("private"),
    });

    const hiddenBefore = await capture(() =>
      readFile(store, { path: "2-areas/dst/secret.md", clearance: clearanceOf("team") }),
    );
    expect(hiddenBefore.code).toBe("FILE_NOT_FOUND");

    const error = await capture(() =>
      movePath(store, {
        from: "1-projects/src",
        to: "2-areas/dst",
        clearance: clearanceOf("team"),
        now: NOW,
      }),
    );
    // The caller cannot see `2-areas/dst`, so the refusal must not admit it is
    // there — same shape `createFolder`'s collision check uses.
    expect(error.code).toBe("FILE_NOT_FOUND");
    const stillHidden = await capture(() =>
      readFile(store, { path: "2-areas/dst/secret.md", clearance: clearanceOf("team") }),
    );
    expect(stillHidden.code).toBe("FILE_NOT_FOUND");
  });

  test("merging two visible folders is refused, and says so plainly", async () => {
    const store = bucket();
    await shareProjects(store);
    store.seed("1-projects/one/a.md", "# A\n");
    store.seed("1-projects/two/b.md", "# B\n");

    const error = await capture(() =>
      movePath(store, { from: "1-projects/one", to: "1-projects/two", clearance: clearanceOf("team"), now: NOW }),
    );
    expect(error.code).toBe("DESTINATION_EXISTS");
    expect(error.message).toContain("merge");
    // Both folders are untouched.
    expect(store.snapshot()["1-projects/one/a.md"]).toBeDefined();
    expect(store.snapshot()["1-projects/two/b.md"]).toBeDefined();
    // ...and a rename to a free name still works, which is the operation this
    // refusal must not take away.
    const moved = await movePath(store, {
      from: "1-projects/one",
      to: "1-projects/renamed",
      clearance: clearanceOf("team"),
      now: NOW,
    });
    expect(moved.paths).toEqual(["1-projects/renamed/a.md"]);
  });

  /**
   * A carried exception must not make a folder writable.
   *
   * The destination guard asks `canSee(destination)`, and a move seeds the
   * source's exception onto the destination so the note keeps its visibility —
   * which meant a note the owner had shared out of a private folder made ANY
   * destination pass. The caller could write into a folder they cannot list,
   * and, because the collision check runs after the guard, could read the
   * answer: move succeeded means nothing is there, refusal means something is.
   * A one-bit read of any path they cared to name.
   *
   * The first version of this test moved a note with NO exception, so the guard
   * answered first and the collision line was never reached — it asserted about
   * a message that was never built. Instrumenting the file showed both
   * collision lines were reached exactly once each across the whole suite, both
   * at owner scope. That absence was then read as "unreachable", which is the
   * inference `CLAUDE.md` forbids, and a false argument was written into the
   * code on the strength of it.
   */
  test("a shared note cannot be used to probe a folder the caller cannot see", async () => {
    async function fixture(): Promise<MemoryStore & FileStore> {
      const store = bucket();
      store.seed("2-areas/open.md", "# Mine\n");
      store.seed("2-areas/hr/comp-2027.md", "# Salaries\n\n200k\n");
      // The supported shape: the owner shares one note out of a private folder.
      await setVisibility(store, {
        path: "2-areas/open.md",
        visibility: "team",
        clearance: clearanceOf("private"),
      });
      return store;
    }
    async function attempt(
      destination: string,
      extra?: (store: MemoryStore & FileStore) => void,
    ) {
      // A fresh bucket per probe. Reusing one moves the note on the first
      // success, and every later probe then fails on the SOURCE — which reads
      // exactly like the guard working.
      const store = await fixture();
      extra?.(store);
      return {
        store,
        result: await capture(() =>
          movePath(store, { from: "2-areas/open.md", to: destination, clearance: clearanceOf("team"), now: NOW }),
        ),
      };
    }

    const hit = await attempt("2-areas/hr/comp-2027.md");
    const miss = await attempt("2-areas/hr/no-such-note.md");
    expect(errorShape(hit.result)).toBe(errorShape(miss.result));
    expect(hit.result.code).toBe("FILE_NOT_FOUND");
    expect(hit.result.message).not.toContain("comp-2027");
    // Nothing was written into the folder either.
    expect(miss.store.snapshot()["2-areas/hr/no-such-note.md"]).toBeUndefined();

    // The bucket root is a folder like any other, and it was the one the guard
    // used to skip — `parentOf` returns "" there. `index.md`, `privacy.md` and
    // `todo.md` live at the root, and on a bucket with no front page a team
    // caller could create one.
    const root = await attempt("index.md");
    expect(errorShape(root.result)).toBe(errorShape(hit.result));
    // The front page is untouched, not overwritten by the moved note.
    expect(root.store.snapshot()["index.md"]).toBe("# Context\n");
    // ...and a free root name is refused too, so nothing new lands there
    // either — on a bucket with no front page this is how one got created.
    const freeRoot = await attempt("2027-plan.md");
    expect(errorShape(freeRoot.result)).toBe(errorShape(hit.result));
    expect(freeRoot.store.snapshot()["2027-plan.md"]).toBeUndefined();

    // One shared note anywhere beneath a folder used to be enough to reopen the
    // whole subtree, because the predicate asked whether the folder renders in
    // the tree rather than whether this is a place the caller may write. Both
    // shapes must answer alike.
    const shared = await attempt("2-areas/hr/comp-2027.md", (store) =>
      store.seed("2-areas/hr/also-shared.md", "# Also shared\n"),
    );
    expect(errorShape(shared.result)).toBe(errorShape(hit.result));

    // The positive control: a move inside a folder whose default really is
    // team. Refusing everything would satisfy every assertion above.
    const allowed = bucket();
    await shareProjects(allowed);
    const moved = await movePath(allowed, {
      from: "1-projects/context-lc.md",
      to: "1-projects/renamed.md",
      clearance: clearanceOf("team"),
      now: NOW,
    });
    expect(moved.paths).toEqual(["1-projects/renamed.md"]);
  });

  test("one shared folder is not a probe for every hidden folder", async () => {
    // This test used to assert the opposite, and its comment argued for it: "a
    // folder rename is judged under the rules the move installs, which is what
    // makes its destination folder visible." That is a guard reading its own
    // seeding. The rule the move installs cannot be the reason the move is
    // allowed — and the benign rename it blessed and the hostile probe below
    // are the same operation with a different name typed into it, so nothing
    // could have permitted one and refused the other.
    //
    // A team caller holding one shared folder could aim it at any path and read
    // the answer, and on success `remapPrivacy` wrote `<their guess>: team`
    // into the manifest — an editor setting folder visibility inside the
    // owner's private tree, which `setFolderVisibility` reserves to the owner.
    async function probe(destination: string) {
      const store = bucket();
      store.seed("2-areas/shared-project/plan.md", "# Plan\n");
      store.seed("2-areas/finance/salary.md", "# Salaries\n\n200k\n");
      await setFolderVisibility(store, {
        path: "2-areas/shared-project",
        visibility: "team",
        clearance: clearanceOf("private"),
      });
      return {
        store,
        result: await capture(() =>
          movePath(store, {
            from: "2-areas/shared-project",
            to: destination,
            clearance: clearanceOf("team"),
            now: NOW,
          }),
        ),
      };
    }

    const hit = await probe("2-areas/finance");
    const miss = await probe("2-areas/divorce");
    const fresh = await probe("brand-new-top-level");
    expect(errorShape(hit.result)).toBe(errorShape(miss.result));
    expect(errorShape(fresh.result)).toBe(errorShape(miss.result));
    expect(hit.result.code).toBe("FILE_NOT_FOUND");

    // Nothing landed, and no rule was written into the owner's private tree.
    expect(miss.store.snapshot()["2-areas/divorce/plan.md"]).toBeUndefined();
    const manifest = miss.store.snapshot()[PRIVACY_KEY] as string;
    expect(manifest).not.toContain("2-areas/divorce");

    // The control: the same folder renamed inside shared space still moves.
    const allowed = bucket();
    await shareProjects(allowed);
    allowed.seed("1-projects/proj/plan.md", "# Plan\n");
    const moved = await movePath(allowed, {
      from: "1-projects/proj",
      to: "1-projects/proj-renamed",
      clearance: clearanceOf("team"),
      now: NOW,
    });
    expect(moved.paths).toEqual(["1-projects/proj-renamed/plan.md"]);
  });

});
