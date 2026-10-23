import { describe, expect, test } from "vitest";
import { clearanceOf } from "../../functions/lib/clearance";
import {
  copyPath,
  listFolder,
  movePath,
  readFile,
  setFolderVisibility,
  setVisibility,
  trashPath,
} from "../../functions/lib/fileOps";
import { PRIVACY_KEY } from "../../functions/lib/privacy";
import { treeView } from "../../functions/lib/fileOps/walk";
import { NOW, bucket, capture, errorShape, names, shareProjects } from "./fixtures.helpers";
import {
  type KeyedBucket,
  bodyAt,
  keyedBucket,
  liveRowAt,
  withTreeListing,
} from "../keyedFixture.fileops2.helpers";

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
 *
 * Every case runs in a keyed workspace (`keyedFixture.fileops2.helpers.ts`): a
 * move or trash changes rows, and a permanent delete is refused.
 */
describe("a bulk operation acts only on what the caller can see", () => {
  /** `1-projects` shared, with one note inside it held back. */
  async function mixedFolder(): Promise<KeyedBucket> {
    return await keyedBucket(async (store) => {
      await shareProjects(store);
      store.seed("1-projects/mixed/public.md", "# Public\n");
      store.seed("1-projects/mixed/salaries.md", "# Salaries\n\nsecret\n");
      await setVisibility(store, {
        path: "1-projects/mixed/salaries.md",
        visibility: "private",
        clearance: clearanceOf("private"),
      });
    });
  }

  test("trashing a folder leaves what the caller cannot see, where it was", async () => {
    const k = await mixedFolder();
    // Keyed moves refuse a folder holding something the caller cannot see; whether to move it along or leave it behind is an open owner decision (2026-10-22).
    const refused = await capture(() =>
      trashPath(k.store, { path: "1-projects/mixed", clearance: clearanceOf("team"), now: NOW }),
    );
    expect(refused.code).toBe("CONFLICT");
    expect(refused.message).toContain("cannot be moved to the trash in one step");
    // Nothing moved: the caller's note and the one they cannot see are both where they were.
    expect(await bodyAt(k, "1-projects/mixed/public.md")).toBe("# Public\n");
    expect(await bodyAt(k, "1-projects/mixed/salaries.md")).toContain("secret");
  });

  test("the owner still trashes the whole folder, every note restorable", async () => {
    const k = await mixedFolder();
    const result = await trashPath(k.store, {
      path: "1-projects/mixed",
      clearance: clearanceOf("private"),
      now: NOW,
    });
    expect(result.paths.every((path) => path.startsWith(".context/trash/"))).toBe(true);
    expect(await liveRowAt(k, "1-projects/mixed/public.md")).toBeNull();
    expect(await liveRowAt(k, "1-projects/mixed/salaries.md")).toBeNull();
    // Trashed, not deleted: the note's bytes are still in the bucket under their key.
    expect(await bodyAt(k, `${result.paths[0]}/salaries.md`)).toContain("secret");
  });

  test("moving a folder carries the visible notes and leaves the rest", async () => {
    const k = await mixedFolder();
    // Keyed moves refuse a folder holding something the caller cannot see; whether to move it along or leave it behind is an open owner decision (2026-10-22).
    const refused = await capture(() =>
      movePath(k.store, { from: "1-projects/mixed", to: "1-projects/moved", clearance: clearanceOf("team"), now: NOW }),
    );
    expect(refused.code).toBe("CONFLICT");
    expect(refused.message).toContain("cannot move in one step");
    // Nothing moved: both notes are still at the folder, and the destination was not created.
    expect(await bodyAt(k, "1-projects/mixed/public.md")).toBe("# Public\n");
    expect(await bodyAt(k, "1-projects/mixed/salaries.md")).toContain("secret");
    expect(await liveRowAt(k, "1-projects/moved/public.md")).toBeNull();
  });

  /**
   * The refusal this replaces. A folder holding an invisible note used to be
   * refused outright while the same folder without one succeeded, which is the
   * oracle above in one comparison.
   */
  test("a folder with a hidden note answers exactly like one without", async () => {
    const withHidden = await mixedFolder();
    // Keyed moves refuse a folder holding something the caller cannot see; whether to move it along or leave it behind is an open owner decision (2026-10-22).
    const hidden = await capture(() =>
      movePath(withHidden.store, {
        from: "1-projects/mixed",
        to: "1-projects/renamed",
        clearance: clearanceOf("team"),
        now: NOW,
      }),
    );
    expect(hidden.code).toBe("CONFLICT");
    expect(await bodyAt(withHidden, "1-projects/mixed/salaries.md")).toContain("secret");

    // The same folder without the hidden note moves as one.
    const clean = await keyedBucket(async (store) => {
      await shareProjects(store);
      store.seed("1-projects/mixed/public.md", "# Public\n");
    });
    const plain = await movePath(clean.store, {
      from: "1-projects/mixed",
      to: "1-projects/renamed",
      clearance: clearanceOf("team"),
      now: NOW,
    });
    expect(plain.moved?.map((move) => move.to)).toEqual(["1-projects/renamed/public.md"]);
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
  async function ruleHiddenFolder(): Promise<KeyedBucket> {
    return await keyedBucket(async (store) => {
      await shareProjects(store);
      store.seed("1-projects/mixed/public.md", "# Public\n");
      store.seed("1-projects/mixed/deep/secret.md", "# Salaries\n\n200k\n");
      await setFolderVisibility(store, {
        path: "1-projects/mixed/deep",
        visibility: "private",
        clearance: clearanceOf("private"),
      });
    });
  }

  test("a partial trash leaves the rule that still governs the survivor", async () => {
    const k = await ruleHiddenFolder();
    // Keyed moves refuse a folder holding something the caller cannot see; whether to move it along or leave it behind is an open owner decision (2026-10-22).
    const refused = await capture(() =>
      trashPath(k.store, { path: "1-projects/mixed", clearance: clearanceOf("team"), now: NOW }),
    );
    expect(refused.code).toBe("CONFLICT");

    // Nothing trashed: the survivor is still there, and still *private*. The rule surviving is only the mechanism.
    const leak = await capture(() =>
      readFile(k.store, { path: "1-projects/mixed/deep/secret.md", clearance: clearanceOf("team") }),
    );
    expect(leak.code).toBe("FILE_NOT_FOUND");
    const owner = await readFile(k.store, {
      path: "1-projects/mixed/deep/secret.md",
      clearance: clearanceOf("private"),
    });
    expect(owner.text).toContain("200k");
  });

  test("a partial move leaves the rule where the survivor still is", async () => {
    const k = await ruleHiddenFolder();
    // Keyed moves refuse a folder holding something the caller cannot see; whether to move it along or leave it behind is an open owner decision (2026-10-22).
    const refused = await capture(() =>
      movePath(k.store, {
        from: "1-projects/mixed",
        to: "1-projects/moved",
        clearance: clearanceOf("team"),
        now: NOW,
      }),
    );
    expect(refused.code).toBe("CONFLICT");

    // Nothing moved, so the survivor's rule is exactly where it was.
    const leak = await capture(() =>
      readFile(k.store, { path: "1-projects/mixed/deep/secret.md", clearance: clearanceOf("team") }),
    );
    expect(leak.code).toBe("FILE_NOT_FOUND");
    expect(await bodyAt(k, "1-projects/mixed/public.md")).toBe("# Public\n");
  });

  test("a whole-folder move still carries its rules across", async () => {
    // The control for the two above: when nothing is held back the rules follow
    // the folder. Inside a *private* parent the rule is the only thing that can
    // make the destination visible.
    const k = await keyedBucket(async (store) => {
      store.seed("2-areas/whole/note.md", "# Note\n");
      await setFolderVisibility(store, {
        path: "2-areas/whole",
        visibility: "team",
        clearance: clearanceOf("private"),
      });
    });
    const moved = await movePath(k.store, {
      from: "2-areas/whole",
      to: "2-areas/whole-2",
      clearance: clearanceOf("private"),
      now: NOW,
    });
    expect(moved.moved?.map((move) => move.to)).toEqual(["2-areas/whole-2/note.md"]);
    const listing = await listFolder(treeView(k.store), { path: "2-areas/whole-2", clearance: clearanceOf("team") });
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
      const k = await keyedBucket(async (store) => {
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
      });
      // The caller sees the same folder either way before they act.
      const before = await listFolder(treeView(k.store), { path: "2-areas/shared", clearance: clearanceOf("team") });
      expect(names(before.entries)).toEqual(["a.md"]);
      return {
        k,
        result: await capture(() =>
          movePath(k.store, {
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
    // Not identical today: a clean folder is refused at its destination, while a folder holding a note
    // the caller cannot see is refused as a whole.
    // Keyed moves refuse a folder holding something the caller cannot see; whether to move it along or leave it behind is an open owner decision (2026-10-22).
    expect(clean.result.code).toBe("FILE_NOT_FOUND");
    expect(hiding.result.code).toBe("CONFLICT");
    expect(hiding.result.message).toContain("cannot move in one step");

    // ...and the note it hid is still hidden, and still where it was.
    const leak = await capture(() =>
      readFile(hiding.k.store, { path: "2-areas/shared/secret.md", clearance: clearanceOf("team") }),
    );
    expect(leak.code).toBe("FILE_NOT_FOUND");
    expect(await bodyAt(hiding.k, "2-areas/shared/secret.md")).toContain("Secret");
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
    const k = await keyedBucket(async (store) => {
      await shareProjects(store);
      store.seed("1-projects/huge/aaa.md", "# A\n");
      store.seed("1-projects/huge/zdeep/secret.md", "# Salaries\n\n200k\n");
      await setFolderVisibility(store, {
        path: "1-projects/huge/zdeep",
        visibility: "private",
        clearance: clearanceOf("private"),
      });
    });

    // A tree whose pages never end. This is the shape that matters rather
    // than any particular object count: the page size a provider returns is a
    // hint, so the number of objects behind the cap is not something this code
    // can know. What it can know is that it did not finish.
    const endless = withTreeListing(k, (list) => async (options) => {
      const page = (await list(options)) as object;
      return { ...page, truncated: true, cursor: `c${Math.random()}` };
    });

    const error = await capture(() =>
      copyPath(endless, {
        from: "1-projects/huge",
        to: "1-projects/huge-copy",
        clearance: clearanceOf("team"),
      }),
    );
    expect(error.code).toBe("FOLDER_TOO_LARGE");
    // Nothing was copied and, above all, nothing was published.
    expect(await bodyAt(k, "1-projects/huge/aaa.md")).toBe("# A\n");
    const leak = await capture(() =>
      readFile(k.store, { path: "1-projects/huge/zdeep/secret.md", clearance: clearanceOf("team") }),
    );
    expect(leak.code).toBe("FILE_NOT_FOUND");
  });

  test("a store alternating two cursors does not spend the whole page budget", async () => {
    // A single-step comparison against the previous cursor passes this store
    // forever; the guard has to keep the set, which is what the gateway does.
    const k = await keyedBucket(async (store) => {
      await shareProjects(store);
      store.seed("1-projects/pingpong/a.md", "# A\n");
    });
    let calls = 0;
    const alternating = withTreeListing(k, (list) => async (options) => {
      const page = (await list(options)) as object;
      calls += 1;
      return { ...page, truncated: true, cursor: calls % 2 === 0 ? "ping" : "pong" };
    });
    const error = await capture(() =>
      copyPath(alternating, {
        from: "1-projects/pingpong",
        to: "1-projects/pingpong-copy",
        clearance: clearanceOf("team"),
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
    const k = await keyedBucket(async (store) => {
      await shareProjects(store);
      store.seed("1-projects/stuck/a.md", "# A\n");
    });
    let calls = 0;
    const stuck = withTreeListing(k, (list) => async (options) => {
      calls += 1;
      const page = (await list(options)) as object;
      return { ...page, truncated: true, cursor: (options as { cursor?: string } | undefined)?.cursor ?? "same" };
    });
    const error = await capture(() =>
      copyPath(stuck, {
        from: "1-projects/stuck",
        to: "1-projects/stuck-copy",
        clearance: clearanceOf("team"),
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
    const k = await keyedBucket(async (store) => {
      store.seed("2-areas/shared/a.md", "# A\n");
      await setFolderVisibility(store, {
        path: "2-areas/shared",
        visibility: "team",
        clearance: clearanceOf("private"),
      });
    });

    const refused = await capture(() =>
      movePath(k.store, {
        from: "2-areas/shared",
        to: "2-areas/elsewhere",
        clearance: clearanceOf("team"),
        now: NOW,
      }),
    );
    expect(refused.code).toBe("FILE_NOT_FOUND");
    // Nothing moved, and no rule was written for the destination.
    expect(await liveRowAt(k, "2-areas/elsewhere/a.md")).toBeNull();
    expect(k.raw.snapshot()[PRIVACY_KEY] as string).not.toContain("2-areas/elsewhere");

    // The control: the same folder inside shared space moves.
    const allowed = await keyedBucket(async (store) => {
      await shareProjects(store);
      store.seed("1-projects/shared/a.md", "# A\n");
    });
    const moved = await movePath(allowed.store, {
      from: "1-projects/shared",
      to: "1-projects/elsewhere",
      clearance: clearanceOf("team"),
      now: NOW,
    });
    expect(moved.moved?.map((move) => move.to)).toEqual(["1-projects/elsewhere/a.md"]);
  });
});
