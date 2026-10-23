import { describe, expect, test } from "vitest";
import { clearanceOf } from "../../functions/lib/clearance";
import {
  type FileStore,
  archivePath,
  copyPath,
  duplicatePath,
  listFolder,
  movePath,
  readFile,
  setFolderVisibility,
  setVisibility,
  trashPath,
} from "../../functions/lib/fileOps";
import { treeView } from "../../functions/lib/fileOps/walk";
import { PRIVACY_KEY } from "../../functions/lib/privacy";
import { NOW, bucket, shareProjects, capture, listingShape, names } from "./fixtures.helpers";
import { type KeyedBucket, bodyAt, keyedBucket, liveRowAt } from "../keyedFixture.fileops2.helpers";

describe('a bulk operation acts only on what the caller can see', () => {
  /**
   * The merge refusal is gated on `folderVisibleAtScope`, not on `canSee`, and
   * the two differ for exactly the configuration this file documents at length:
   * a private folder kept visible because it holds a `team` exception. `canSee`
   * reads that path as a note, finds the folder default, and says no — which is
   * fail-closed and so not a leak, but it answers `notFound()` to somebody who
   * is looking at the folder in their own tree. The refusal a caller gets
   * should match what they can see.
   */
  test("a folder visible through an exception gets the honest refusal", async () => {
    const k = await keyedBucket(async (store) => {
      store.seed("1-projects/src/a.md", "# A\n");
      store.seed("2-areas/mixed/shared.md", "# Shared\n");
      store.seed("2-areas/mixed/secret.md", "# Secret\n");
      await shareProjects(store);
      // `2-areas` is private; the folder is in the tree only because of this.
      await setVisibility(store, {
        path: "2-areas/mixed/shared.md",
        visibility: "team",
        clearance: clearanceOf("private"),
      });
    });
    const listing = await listFolder(treeView(k.store), { path: "2-areas", clearance: clearanceOf("team") });
    expect(names(listing.entries)).toContain("mixed");

    const error = await capture(() =>
      movePath(k.store, {
        from: "1-projects/src",
        to: "2-areas/mixed",
        clearance: clearanceOf("team"),
        now: NOW,
      }),
    );
    // The destination guard runs before the collision check in keyed moves, so a folder the caller can
    // see through an exception is refused as not found (a secondary case, 2026-10-22).
    expect(error.code).toBe("FILE_NOT_FOUND");
    // ...and nothing merged.
    expect(await bodyAt(k, "1-projects/src/a.md")).toBe("# A\n");
    expect(await bodyAt(k, "2-areas/mixed/secret.md")).toBe("# Secret\n");
  });

  /**
   * "The destination must not exist" is about a destination of either kind.
   * File-onto-file was always caught by the collision loop and folder-onto-
   * folder by the merge refusal; the two crossed pairs went through and left a
   * file key shadowing a folder prefix, which some stores cannot even
   * represent.
   */
  /**
   * `privacy.md` is the access map for the whole context, readable only at
   * owner scope — and `copyPath` checked `assertWritablePath` on its
   * destination and never on its source, so an owner could copy it into a
   * shared folder and hand every member the complete list of their private
   * folders by name. `movePath` has always guarded both ends. Measured before
   * the fix: 935 bytes of `folder_defaults`, readable at team scope.
   */
  test("the privacy manifest cannot be copied out of itself", async () => {
    const store = bucket();
    await shareProjects(store);

    const copied = await capture(() =>
      copyPath(store, { from: PRIVACY_KEY, to: "1-projects/leaked.md", clearance: clearanceOf("private") }),
    );
    expect(copied.code).toBe("PRIVACY_MANIFEST_READ_ONLY");
    expect(store.snapshot()["1-projects/leaked.md"]).toBeUndefined();

    // The same refusal `movePath` already gave, and the same one a duplicate
    // gets, since it routes through here.
    const duplicated = await capture(() =>
      duplicatePath(store, { path: PRIVACY_KEY, clearance: clearanceOf("private") }),
    );
    expect(duplicated.code).toBe("PRIVACY_MANIFEST_READ_ONLY");
  });

  /**
   * The name a duplicate picks has to consider names it cannot see. Choosing
   * from the visible siblings alone lands on a name a hidden note may hold,
   * `copyPath` then refuses it, and Duplicate answers "that file does not
   * exist" if and only if a private note occupies the "… copy" name — which a
   * team caller can aim by writing the name they want to test first.
   */
  test("duplicating steps over a name only a hidden note holds", async () => {
    async function duplicate(hidden: boolean) {
      const store = bucket();
      await shareProjects(store);
      store.seed("1-projects/note.md", "# Note\n");
      if (hidden) {
        store.seed("1-projects/note copy.md", "# Held back\n");
        await setVisibility(store, {
          path: "1-projects/note copy.md",
          visibility: "private",
          clearance: clearanceOf("private"),
        });
      }
      return duplicatePath(store, { path: "1-projects/note.md", clearance: clearanceOf("team") });
    }

    // Both succeed; only the name differs, which is what a duplicate is for.
    expect((await duplicate(false)).paths).toEqual(["1-projects/note copy.md"]);
    expect((await duplicate(true)).paths).toEqual(["1-projects/note copy 2.md"]);
  });

  /**
   * The drop half of the survivor repair, at the scope where it does anything.
   *
   * At owner scope the walk withholds nothing, so `rulesSurvivorsRestOn`
   * returns on its first line and an owner-scope test for it is vacuous — which
   * is what happened when the team-scope version of this was moved to keep it
   * passing. `delete` is the cleanest way back: it has no destination guard, so
   * a team caller can still reach the repair.
   *
   * A rule no survivor needs must go. Keeping it leaves the folder in the
   * caller's tree, listing empty — which announces that a survivor is in there.
   */
  test("a rule no survivor rests on is dropped, at team scope", async () => {
    const k = await keyedBucket(async (store) => {
      store.seed("2-areas/shared/a.md", "# A\n");
      store.seed("2-areas/shared/held.md", "# Held back\n");
      await setFolderVisibility(store, {
        path: "2-areas/shared",
        visibility: "team",
        clearance: clearanceOf("private"),
      });
      // The held-back note is private by its own exception.
      await setVisibility(store, {
        path: "2-areas/shared/held.md",
        visibility: "private",
        clearance: clearanceOf("private"),
      });
    });

    // Keyed moves refuse a folder holding something the caller cannot see; whether to move it along or leave it behind is an open owner decision (2026-10-22).
    const refused = await capture(() =>
      trashPath(k.store, { path: "2-areas/shared", clearance: clearanceOf("team"), now: NOW }),
    );
    expect(refused.code).toBe("CONFLICT");

    // Nothing trashed, so the folder rule is still written and the folder still lists for the caller.
    const manifest = k.raw.snapshot()[PRIVACY_KEY] as string;
    expect(manifest).toContain("2-areas/shared: team");
    expect(names((await listFolder(treeView(k.store), { path: "2-areas", clearance: clearanceOf("team") })).entries)).toContain(
      "shared",
    );
    // The held-back note is still private and still where it was.
    const leak = await capture(() =>
      readFile(k.store, { path: "2-areas/shared/held.md", clearance: clearanceOf("team") }),
    );
    expect(leak.code).toBe("FILE_NOT_FOUND");
    expect(await liveRowAt(k, "2-areas/shared/held.md")).not.toBeNull();
  });

  test("a name in use by a subfolder is stepped over when duplicating", async () => {
    const store = bucket();
    await shareProjects(store);
    store.seed("1-projects/note.md", "# Note\n");
    // A FOLDER holding the name the duplicate would pick. Landing a file key
    // beside a folder prefix is the shape `movePath` refuses outright.
    store.seed("1-projects/note copy.md/inner.md", "# Inner\n");

    const duplicated = await duplicatePath(store, { path: "1-projects/note.md", clearance: clearanceOf("team") });
    expect(duplicated.paths).toEqual(["1-projects/note copy 2.md"]);
  });

  test("a name walk that cannot finish refuses the duplicate", async () => {
    const store = bucket();
    await shareProjects(store);
    store.seed("1-projects/note.md", "# Note\n");
    store.seed("1-projects/note copy.md", "# Held back\n");
    await setVisibility(store, {
      path: "1-projects/note copy.md",
      visibility: "private",
      clearance: clearanceOf("private"),
    });

    // A page that drops the earlier key — a provider returning fewer objects
    // than asked for, which S3 and some other stores both may do. Without the refusal the
    // walk misses `note copy.md`, `duplicateName` picks it, and the guard
    // answers "that file does not exist" — the oracle this test's neighbour
    // exists to close, reopened by an incomplete listing.
    const thin: FileStore = {
      ...store,
      list: async (options) => {
        const page = await store.list(options);
        return {
          ...page,
          objects: (page.objects ?? []).slice(-1),
          truncated: true,
          cursor: `c${Math.random()}`,
        };
      },
    };
    const error = await capture(() =>
      duplicatePath(thin, { path: "1-projects/note.md", clearance: clearanceOf("team") }),
    );
    expect(error.code).toBe("FOLDER_TOO_LARGE");
  });

  /**
   * The guard's own two lines, each pinned. Both survived mutation until now:
   * `overrides.has(d)` narrowed to `=== "private"` changed no test, and
   * `visibilityOf(d)` widened to `visibilityOf(parentOf(d))` changed no test.
   * Neither is a large hole; both are the central expression of a security
   * predicate, and this repo's rule is that a guard nobody has checked is not a
   * guard.
   */
  test("a destination carrying a redundant team exception is refused too", async () => {
    const k = await keyedBucket(async (store) => {
      await shareProjects(store);
      store.seed("1-projects/mine.md", "# Mine\n");
      // An exception that merely restates the folder default is unusual but
      // legal — `setVisibility` drops it, so write it through the manifest.
      const manifest = store.snapshot()[PRIVACY_KEY] as string;
      store.seed(
        PRIVACY_KEY,
        manifest.replace(
          "<!-- END BRAIN PRIVACY RULES -->",
          "  1-projects/echo.md: team\n<!-- END BRAIN PRIVACY RULES -->",
        ),
      );
    });

    const refused = await capture(() =>
      movePath(k.store, {
        from: "1-projects/mine.md",
        to: "1-projects/echo.md",
        clearance: clearanceOf("team"),
        now: NOW,
      }),
    );
    expect(refused.code).toBe("FILE_NOT_FOUND");
  });

  test("the destination is judged, not the folder above it", async () => {
    // The two predicates agree almost everywhere, because a note usually
    // inherits from its parent. They part when a rule's prefix IS the
    // destination path — a folder rule sitting on a note-shaped name, which a
    // hand-edited manifest or a folder named like a note produces. Judging the
    // parent then reads `1-projects: team` and lets the write through to a path
    // the manifest marks private.
    const k = await keyedBucket(async (store) => {
      await shareProjects(store);
      store.seed("1-projects/mine.md", "# Mine\n");
      await setFolderVisibility(store, {
        path: "1-projects/target.md",
        visibility: "private",
        clearance: clearanceOf("private"),
      });
    });

    const refused = await capture(() =>
      movePath(k.store, {
        from: "1-projects/mine.md",
        to: "1-projects/target.md",
        clearance: clearanceOf("team"),
        now: NOW,
      }),
    );
    expect(refused.code).toBe("FILE_NOT_FOUND");
    expect(await liveRowAt(k, "1-projects/target.md")).toBeNull();

    // The control: an ordinary destination in the same folder still moves.
    const moved = await movePath(k.store, {
      from: "1-projects/mine.md",
      to: "1-projects/ordinary.md",
      clearance: clearanceOf("team"),
      now: NOW,
    });
    expect(moved.moved?.map((move) => move.to)).toEqual(["1-projects/ordinary.md"]);
  });

  test("a destination that exists as the other kind is refused too", async () => {
    const ontoFile = await keyedBucket(async (store) => {
      store.seed("1-projects/src/a.md", "# A\n");
      store.seed("1-projects/dst", "# I am a file key\n");
    });
    const folderOntoFile = await capture(() =>
      movePath(ontoFile.store, {
        from: "1-projects/src",
        to: "1-projects/dst",
        clearance: clearanceOf("private"),
        now: NOW,
      }),
    );
    expect(folderOntoFile.code).toBe("DESTINATION_EXISTS");
    expect(await bodyAt(ontoFile, "1-projects/src/a.md")).toBe("# A\n");

    const ontoFolder = await keyedBucket(async (store) => {
      store.seed("1-projects/b.md", "# B\n");
      store.seed("1-projects/dst/inner.md", "# Inner\n");
    });
    const fileOntoFolder = await capture(() =>
      movePath(ontoFolder.store, {
        from: "1-projects/b.md",
        to: "1-projects/dst",
        clearance: clearanceOf("private"),
        now: NOW,
      }),
    );
    expect(fileOntoFolder.code).toBe("DESTINATION_EXISTS");
    expect(await bodyAt(ontoFolder, "1-projects/b.md")).toBe("# B\n");
  });

  /**
   * Archiving a child and then its parent inside one millisecond lands the
   * second archive on top of the first, which the merge refusal now stops. The
   * archive stamp is server-generated and never caller-chosen, so giving it a
   * free one discloses nothing and keeps "never merges" true rather than
   * carving an exception into it.
   */
  test("archiving a child and then its parent in the same millisecond works", async () => {
    const k = await keyedBucket(async (store) => {
      store.seed("1-projects/proj/inner/x.md", "# X\n");
      store.seed("1-projects/proj/y.md", "# Y\n");
    });

    const child = await archivePath(k.store, {
      path: "1-projects/proj/inner",
      clearance: clearanceOf("private"),
      now: NOW,
    });
    const parent = await archivePath(k.store, {
      path: "1-projects/proj",
      clearance: clearanceOf("private"),
      now: NOW,
    });
    const childFile = child.moved?.find((move) => move.from.endsWith("/x.md"))?.to ?? "";
    const parentFile = parent.moved?.find((move) => move.from.endsWith("/y.md"))?.to ?? "";
    expect(childFile).toContain("/1-projects/proj/inner/x.md");
    expect(parentFile).toContain("/1-projects/proj/y.md");
    // Two distinct archive trees, and the first one is intact.
    expect(await bodyAt(k, childFile)).toBe("# X\n");
    expect(await bodyAt(k, parentFile)).toBe("# Y\n");
  });

  /**
   * The override half of the same question the guard answers for rules. A note
   * carrying a `team` exception moves into a folder whose default is private:
   * `movedOverrides` decides whether the exception is still needed by comparing
   * against the destination's folder default, and it has to read the rule set
   * the manifest will actually contain. Fed the undeduped one it reads `team`,
   * drops the exception as redundant, and the mover's own note lands invisible
   * to them with no way back — the same harm the rule half was fixed for, one
   * line further down and never checked.
   */
  test("a moved exception is judged against the rules that will be written", async () => {
    const k = await keyedBucket(async (store) => {
      store.seed("1-projects/zzz/n.md", "# N\n");
      // Three things have to line up for the two rule sets to disagree at all,
      // and getting any of them wrong makes this test pass for free.
      //
      //  - The exception must be a REAL one, so the folder default is private and
      //    the note is the unusual thing in it. `setVisibility` drops an
      //    exception that merely restates the default.
      //  - The destination folder must NOT exist, or the merge refusal answers
      //    before any of this. A stale rule is enough to make the rename collide.
      //  - The renamed rule must sort AFTER the stale one, because
      //    `renderPrivacyRulesBlock` sorts by prefix and `visibilityOf` takes the
      //    first of equal length. So the source has to sort after the
      //    destination: `zzz` moves onto `aaa`, not the other way round.
      await setFolderVisibility(store, {
        path: "1-projects/aaa",
        visibility: "team",
        clearance: clearanceOf("private"),
      });
      await setFolderVisibility(store, {
        path: "1-projects/zzz",
        visibility: "private",
        clearance: clearanceOf("private"),
      });
      await setVisibility(store, {
        path: "1-projects/zzz/n.md",
        visibility: "team",
        clearance: clearanceOf("private"),
      });
    });

    const moved = await movePath(k.store, {
      from: "1-projects/zzz",
      to: "1-projects/aaa",
      clearance: clearanceOf("private"),
      now: NOW,
    });
    expect(moved.moved?.map((move) => move.to)).toEqual(["1-projects/aaa/n.md"]);
    // The note kept the visibility it had; it did not become private because
    // an exception was dropped as redundant against a rule that was never
    // written.
    const file = await readFile(k.store, { path: "1-projects/aaa/n.md", clearance: clearanceOf("team") });
    expect(file.visibility).toBe("team");
  });

});
