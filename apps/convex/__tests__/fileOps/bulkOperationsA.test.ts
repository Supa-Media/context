import { describe, expect, test } from "vitest";
import { clearanceOf } from "../../functions/lib/clearance";
import {
  DELETE_CONFIRMATION,
  type FileStore,
  copyPath,
  deletePath,
  listFolder,
  movePath,
  readFile,
  setFolderVisibility,
  setVisibility,
} from "../../functions/lib/fileOps";
import { PRIVACY_KEY } from "../../functions/lib/privacy";
import { type MemoryStore } from "../storeStub.helpers";
import {
  NOW,
  bucket,
  historyKeys,
  shareProjects,
  capture,
  errorShape,
  names,
} from "./fixtures.helpers";

/**
 * `keysUnder` walks a folder for move, copy and delete, and filtered only
 * plumbing. So a bulk operation acted on keys its caller could not see and then
 * named them back: an editor deleting a shared folder permanently destroyed the
 * owner's private note inside it, purged its `.history/` too, and was handed the
 * note's path in the result.
 *
 * Filtered rather than refused. Refusing because the tree holds something
 * invisible reports that the invisible thing is there — a caller could sort
 * "folder I can move" from "folder with a private note in it" from "folder that
 * does not exist" and localise every private note without reading one. The
 * gateway settled this for `move_folder` and wrote out the reasoning; these are
 * the control plane's copy of the same decision.
 */
describe("a bulk operation acts only on what the caller can see", () => {
  /** `1-projects` shared, with one note inside it held back. */
  async function mixedFolder(): Promise<MemoryStore & FileStore> {
    const store = bucket();
    await shareProjects(store);
    store.seed("1-projects/mixed/public.md", "# Public\n");
    store.seed("1-projects/mixed/salaries.md", "# Salaries\n\nsecret\n");
    store.seed(".history/1-projects/mixed/salaries.md.2026-07-01T09-00-00-000Z.md", "# older\n");
    await setVisibility(store, {
      path: "1-projects/mixed/salaries.md",
      visibility: "private",
      clearance: clearanceOf("private"),
    });
    return store;
  }

  test("deleting a folder leaves what the caller cannot see, and its history", async () => {
    const store = await mixedFolder();
    const result = await deletePath(store, {
      path: "1-projects/mixed",
      clearance: clearanceOf("team"),
      confirmation: DELETE_CONFIRMATION,
    });
    expect(result.paths).toEqual(["1-projects/mixed/public.md"]);
    // The name never reaches them...
    expect(result.paths).not.toContain("1-projects/mixed/salaries.md");
    // ...the note is still there...
    expect(store.snapshot()["1-projects/mixed/salaries.md"]).toBeDefined();
    // ...and so is every version of it. A live note whose history was purged
    // is the same loss wearing a smaller number.
    expect(
      historyKeys(store).some((key) => key.includes("mixed/salaries.md")),
    ).toBe(true);
  });

  test("the owner still deletes the whole folder, history and all", async () => {
    const store = await mixedFolder();
    const result = await deletePath(store, {
      path: "1-projects/mixed",
      clearance: clearanceOf("private"),
      confirmation: DELETE_CONFIRMATION,
    });
    expect(result.paths.sort()).toEqual([
      "1-projects/mixed/public.md",
      "1-projects/mixed/salaries.md",
    ]);
    expect(historyKeys(store).some((key) => key.includes("mixed/"))).toBe(false);
  });

  test("moving a folder carries the visible notes and leaves the rest", async () => {
    const store = await mixedFolder();
    const moved = await movePath(store, {
      from: "1-projects/mixed",
      to: "1-projects/moved",
      clearance: clearanceOf("team"),
      now: NOW,
    });
    expect(moved.paths).toEqual(["1-projects/moved/public.md"]);
    expect(store.snapshot()["1-projects/mixed/salaries.md"]).toBeDefined();
  });

  /**
   * The refusal this replaces. A folder holding an invisible note used to be
   * refused outright while the same folder without one succeeded, which is the
   * oracle above in one comparison.
   */
  test("a folder with a hidden note answers exactly like one without", async () => {
    const withHidden = await mixedFolder();
    const hidden = await movePath(withHidden, {
      from: "1-projects/mixed",
      to: "1-projects/renamed",
      clearance: clearanceOf("team"),
      now: NOW,
    });

    const clean = bucket();
    await shareProjects(clean);
    clean.seed("1-projects/mixed/public.md", "# Public\n");
    const plain = await movePath(clean, {
      from: "1-projects/mixed",
      to: "1-projects/renamed",
      clearance: clearanceOf("team"),
      now: NOW,
    });

    expect(hidden.paths).toEqual(plain.paths);
  });

  /**
   * The `null` in `historyKeysFor`'s call claims the owner's sweep is
   * unchanged, orphans included — a snapshot left by an earlier *move* is not
   * matched by any surviving note, so a filtered sweep would strand it and
   * "permanently delete" would keep a copy again. Filtering the owner's sweep
   * passed the whole suite before this test.
   */
  test("the owner's delete still takes history no surviving note accounts for", async () => {
    const store = bucket();
    store.seed("1-projects/folder/note.md", "# Note\n");
    // The shape a move leaves behind: history for a path that is no longer live.
    store.seed(
      ".history/1-projects/folder/moved-away.md.2026-07-01T09-00-00-000Z.move.md",
      "# gone\n",
    );

    await deletePath(store, {
      path: "1-projects/folder",
      clearance: clearanceOf("private"),
      confirmation: DELETE_CONFIRMATION,
    });
    expect(historyKeys(store).some((key) => key.includes("1-projects/folder/"))).toBe(false);
  });

  /**
   * The destination loop has to check every pair, and after the filter above
   * a *move*'s destinations all share one visibility, so only a copy can tell
   * the difference: its destinations are judged against the manifest as it
   * stands, and an existing note at one of them may carry an exception of its
   * own. Checking `pairs[0]` alone passed the entire suite twice.
   */
  test("copying checks every destination, not the first", async () => {
    const store = bucket();
    await shareProjects(store);
    store.seed("1-projects/src/aaa.md", "# A\n");
    store.seed("1-projects/src/hidden.md", "# H\n");
    // The destination folder already holds a note the caller cannot see, under
    // a name the copy would land on. It sorts after a visible one.
    store.seed("1-projects/dest/hidden.md", "# Existing\n");
    await setVisibility(store, {
      path: "1-projects/dest/hidden.md",
      visibility: "private",
      clearance: clearanceOf("private"),
    });

    const error = await capture(() =>
      copyPath(store, { from: "1-projects/src", to: "1-projects/dest", clearance: clearanceOf("team") }),
    );
    expect(error.code).toBe("FILE_NOT_FOUND");
    // The old reply quoted the invisible path back.
    expect(error.message).not.toContain("hidden.md");
    expect(store.snapshot()["1-projects/dest/aaa.md"]).toBeUndefined();
  });

  /**
   * Every fixture above hides its note with an exact-note **exception**, and
   * `forgetPrivacy` and `remapPrivacy` only touch **rules** — so the whole
   * group agreed with the code about the one mechanism that happened to be
   * safe, and proved nothing about the other. These hide by rule.
   *
   * The trap is that a rule is not a note's only protection, it is the reason
   * the *parent's* rule does not reach it. `visibilityOf` takes the longest
   * matching prefix, so dropping `1-projects/mixed/deep: private` does not
   * leave those notes unruled and private — it hands them to `1-projects:
   * team`. Deleting part of a folder used to drop that rule, and the survivor
   * became readable by the person who had just been refused it.
   */
  async function ruleHiddenFolder(): Promise<MemoryStore & FileStore> {
    const store = bucket();
    await shareProjects(store);
    store.seed("1-projects/mixed/public.md", "# Public\n");
    store.seed("1-projects/mixed/deep/secret.md", "# Salaries\n\n200k\n");
    await setFolderVisibility(store, {
      path: "1-projects/mixed/deep",
      visibility: "private",
      clearance: clearanceOf("private"),
    });
    return store;
  }

  test("a partial delete leaves the rule that still governs the survivor", async () => {
    const store = await ruleHiddenFolder();
    const result = await deletePath(store, {
      path: "1-projects/mixed",
      clearance: clearanceOf("team"),
      confirmation: DELETE_CONFIRMATION,
    });
    expect(result.paths).toEqual(["1-projects/mixed/public.md"]);

    // The survivor is still there, and still *private*. Reading it is the
    // assertion that matters: the rule surviving is only the mechanism.
    const leak = await capture(() =>
      readFile(store, { path: "1-projects/mixed/deep/secret.md", clearance: clearanceOf("team") }),
    );
    expect(leak.code).toBe("FILE_NOT_FOUND");
    const owner = await readFile(store, {
      path: "1-projects/mixed/deep/secret.md",
      clearance: clearanceOf("private"),
    });
    expect(owner.text).toContain("200k");
  });

  test("a partial move leaves the rule where the survivor still is", async () => {
    const store = await ruleHiddenFolder();
    const moved = await movePath(store, {
      from: "1-projects/mixed",
      to: "1-projects/moved",
      clearance: clearanceOf("team"),
      now: NOW,
    });
    expect(moved.paths).toEqual(["1-projects/moved/public.md"]);

    // The note did not move, so its rule must not have moved either.
    const leak = await capture(() =>
      readFile(store, { path: "1-projects/mixed/deep/secret.md", clearance: clearanceOf("team") }),
    );
    expect(leak.code).toBe("FILE_NOT_FOUND");
  });

  test("a whole-folder move still carries its rules across", async () => {
    // The control for the two above: when nothing is held back the rules follow
    // the folder. The first version of this put the folder inside an already
    // shared `1-projects`, so the destination was listable whether or not the
    // rule travelled and it asserted nothing — it stayed green with the remap
    // disabled outright. Inside a *private* parent the rule is the only thing
    // that can make the destination visible.
    const store = bucket();
    store.seed("2-areas/whole/note.md", "# Note\n");
    await setFolderVisibility(store, {
      path: "2-areas/whole",
      visibility: "team",
      clearance: clearanceOf("private"),
    });
    const moved = await movePath(store, {
      from: "2-areas/whole",
      to: "2-areas/whole-2",
      clearance: clearanceOf("private"),
      now: NOW,
    });
    expect(moved.paths).toEqual(["2-areas/whole-2/note.md"]);
    const listing = await listFolder(store, { path: "2-areas/whole-2", clearance: clearanceOf("team") });
    expect(names(listing.entries)).toEqual(["note.md"]);
  });

  /**
   * The rules under a partly-moved folder describe two places at once, and both
   * blunt answers are wrong. Rewriting them all publishes the survivor;
   * *keeping* them all makes the kept rule the disclosure — a folder that
   * renames cleanly and one that refuses because it hides something are exactly
   * what the filtering above exists not to distinguish. So a rule stays only
   * where removing it would change what a survivor is.
   */
  test("a folder that hides something is refused exactly like one that does not", async () => {
    async function rename(hides: boolean) {
      const store = bucket();
      store.seed("2-areas/shared/a.md", "# A\n");
      if (hides) store.seed("2-areas/shared/secret.md", "# Secret\n");
      await setFolderVisibility(store, {
        path: "2-areas/shared",
        visibility: "team",
        clearance: clearanceOf("private"),
      });
      if (hides) {
        await setVisibility(store, {
          path: "2-areas/shared/secret.md",
          visibility: "private",
          clearance: clearanceOf("private"),
        });
      }
      // The caller sees the same folder either way before they act.
      const before = await listFolder(store, { path: "2-areas/shared", clearance: clearanceOf("team") });
      expect(names(before.entries)).toEqual(["a.md"]);
      return {
        store,
        result: await capture(() =>
          movePath(store, {
            from: "2-areas/shared",
            to: "2-areas/renamed",
            clearance: clearanceOf("team"),
            now: NOW,
          }),
        ),
      };
    }

    const clean = await rename(false);
    const hiding = await rename(true);
    // Both refused, and refused identically — the folder is inside a private
    // parent, so the destination is a place this caller may not write.
    expect(errorShape(hiding.result)).toBe(errorShape(clean.result));
    expect(clean.result.code).toBe("FILE_NOT_FOUND");

    // ...and the note it hid is still hidden, and still where it was.
    const leak = await capture(() =>
      readFile(hiding.store, { path: "2-areas/shared/secret.md", clearance: clearanceOf("team") }),
    );
    expect(leak.code).toBe("FILE_NOT_FOUND");
    expect(hiding.store.snapshot()["2-areas/shared/secret.md"]).toBeDefined();
  });

  /**
   * The walk is bounded, and running out of pages used to look exactly like
   * reaching the end: a short list with nothing recorded as held back, which
   * the manifest bookkeeping then rewrote as though the whole folder had gone.
   * `listFolder` reports the same condition as `truncated` and this one said
   * nothing. Refused rather than truncated, which is what the gateway's own
   * listing helper does.
   */
  test("a walk that cannot reach the end is refused, not half-done", async () => {
    const store = bucket();
    await shareProjects(store);
    store.seed("1-projects/huge/aaa.md", "# A\n");
    store.seed("1-projects/huge/zdeep/secret.md", "# Salaries\n\n200k\n");
    await setFolderVisibility(store, {
      path: "1-projects/huge/zdeep",
      visibility: "private",
      clearance: clearanceOf("private"),
    });

    // A store whose pages never end. This is the shape that matters rather
    // than any particular object count: the page size a provider returns is a
    // hint — S3 may hand back fewer keys than asked and Dropbox documents its
    // limit as approximate — so the number of objects behind the cap is not
    // something this code can know. What it can know is that it did not finish.
    const endless: FileStore = {
      ...store,
      list: async (options) => {
        const page = await store.list(options);
        return { ...page, truncated: true, cursor: `c${Math.random()}` };
      },
    };

    const error = await capture(() =>
      deletePath(endless, {
        path: "1-projects/huge",
        clearance: clearanceOf("team"),
        confirmation: DELETE_CONFIRMATION,
      }),
    );
    expect(error.code).toBe("FOLDER_TOO_LARGE");
    // Nothing was deleted and, above all, nothing was published.
    expect(store.snapshot()["1-projects/huge/aaa.md"]).toBeDefined();
    const leak = await capture(() =>
      readFile(store, { path: "1-projects/huge/zdeep/secret.md", clearance: clearanceOf("team") }),
    );
    expect(leak.code).toBe("FILE_NOT_FOUND");
  });

  test("a store alternating two cursors does not spend the whole page budget", async () => {
    // A single-step comparison against the previous cursor passes this store
    // forever; the guard has to keep the set, which is what the gateway does.
    const store = bucket();
    await shareProjects(store);
    store.seed("1-projects/pingpong/a.md", "# A\n");
    let calls = 0;
    const alternating: FileStore = {
      ...store,
      list: async (options) => {
        const page = await store.list(options);
        calls += 1;
        return { ...page, truncated: true, cursor: calls % 2 === 0 ? "ping" : "pong" };
      },
    };
    const error = await capture(() =>
      deletePath(alternating, {
        path: "1-projects/pingpong",
        clearance: clearanceOf("team"),
        confirmation: DELETE_CONFIRMATION,
      }),
    );
    // A store fault, not a folder that is too big — and it says so. Telling
    // somebody with four notes to "do it in smaller pieces" sends them round a
    // remedy that cannot terminate, because splitting a folder will never make
    // a store hand over a continuation token it does not have.
    expect(error.code).toBe("LISTING_INCOMPLETE");
    // Three calls, not a hundred: pong, ping, then pong again is a repeat.
    expect(calls).toBeLessThanOrEqual(4);
  });

  test("a store that repeats its cursor does not spend the whole page budget", async () => {
    const store = bucket();
    await shareProjects(store);
    store.seed("1-projects/stuck/a.md", "# A\n");
    let calls = 0;
    const stuck: FileStore = {
      ...store,
      list: async (options) => {
        calls += 1;
        const page = await store.list(options);
        return { ...page, truncated: true, cursor: options?.cursor ?? "same" };
      },
    };
    const error = await capture(() =>
      deletePath(stuck, {
        path: "1-projects/stuck",
        clearance: clearanceOf("team"),
        confirmation: DELETE_CONFIRMATION,
      }),
    );
    expect(error.code).toBe("LISTING_INCOMPLETE");
    // Two calls: the first hands out "same", the second returns it unchanged.
    expect(calls).toBeLessThanOrEqual(3);
  });

  /**
   * `movePath` hands the same `folderMove` to the destination guard and to the
   * manifest rewrite, and they have to agree. Given an unconditional one while
   * the rewrite got a conditional one, the guard judged destinations against
   * rules that were never going to exist — and a team caller's move succeeded
   * into space they could no longer see, with 117 tests green.
   */
  test("the destination guard reads the manifest, not the move's own rewrite", async () => {
    // At owner scope `assertDestinationsVisible` returns on its first line, so
    // an owner-scope version of this asserts nothing about the guard. It has to
    // be a team caller, and the shape that matters is a folder whose `team`
    // rule the move would carry to the destination: judged against the rewrite
    // the destination looks shared, judged against the manifest it is not.
    const store = bucket();
    store.seed("2-areas/shared/a.md", "# A\n");
    await setFolderVisibility(store, {
      path: "2-areas/shared",
      visibility: "team",
      clearance: clearanceOf("private"),
    });

    const refused = await capture(() =>
      movePath(store, {
        from: "2-areas/shared",
        to: "2-areas/elsewhere",
        clearance: clearanceOf("team"),
        now: NOW,
      }),
    );
    expect(refused.code).toBe("FILE_NOT_FOUND");
    // Nothing moved, and no rule was written for the destination.
    expect(store.snapshot()["2-areas/elsewhere/a.md"]).toBeUndefined();
    expect(store.snapshot()[PRIVACY_KEY] as string).not.toContain("2-areas/elsewhere");

    // The control: the same folder inside shared space moves.
    const allowed = bucket();
    await shareProjects(allowed);
    allowed.seed("1-projects/shared/a.md", "# A\n");
    const moved = await movePath(allowed, {
      from: "1-projects/shared",
      to: "1-projects/elsewhere",
      clearance: clearanceOf("team"),
      now: NOW,
    });
    expect(moved.paths).toEqual(["1-projects/elsewhere/a.md"]);
  });

});
