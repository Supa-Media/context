import { describe, expect, test } from "vitest";
import { clearanceOf } from "../../functions/lib/clearance";
import {
  DELETE_CONFIRMATION,
  type FileStore,
  archivePath,
  copyPath,
  createFolder,
  deletePath,
  listFolder,
  movePath,
  readFile,
  setFolderVisibility,
  setVisibility,
  writeFile,
} from "../../functions/lib/fileOps";
import {
  PRIVACY_KEY,
  canSee,
  parsePrivacyManifest,
} from "../../functions/lib/privacy";
import { type MemoryStore } from "../storeStub.helpers";
import {
  NOW,
  bucket,
  historyKeys,
  shareProjects,
  capture,
  errorShape,
  names,
} from "./fixtures";

/* -------------------------------------------------------------------------- */
/*                      a destination you cannot see                          */
/* -------------------------------------------------------------------------- */

/**
 * `writeFile` states the rule at its own top: creating a note somewhere a team
 * caller cannot see means creating a note they immediately could not read, so
 * it refuses with the same not-found as a note that is not theirs.
 *
 * `movePath` and `copyPath` are the two operations that never call it — they
 * `store.put` each destination directly — and neither restated the rule. The
 * source was guarded and the destination was not, which cost two separate
 * things: a wider version of the oracle `createFolder` had, and a write into
 * space the caller cannot read that the caller then cannot undo.
 *
 * The gateway refuses both already (`apps/mcp/src/index.js`, `move_note` and
 * `move_folder` check the destination before reading it, and the tool
 * description promises exactly that). These are the control plane's copy.
 */
describe("a destination the caller cannot see", () => {
  /** `1-projects` shared, `2-areas` private, and one real note inside it. */
  async function withHiddenNote(): Promise<MemoryStore & FileStore> {
    const store = bucket();
    await shareProjects(store);
    store.seed("2-areas/finance/notes.md", "# Notes\n\nsalaries\n");
    return store;
  }

  test("copying cannot confirm a note exists where the caller cannot look", async () => {
    const store = await withHiddenNote();
    const taken = await capture(() =>
      copyPath(store, {
        from: "1-projects/context-lc.md",
        to: "2-areas/finance/notes.md",
        clearance: clearanceOf("team"),
      }),
    );
    const free = await capture(() =>
      copyPath(store, {
        from: "1-projects/context-lc.md",
        to: "2-areas/finance/never-existed.md",
        clearance: clearanceOf("team"),
      }),
    );
    expect(errorShape(taken)).toBe(errorShape(free));
    expect(taken.code).toBe("FILE_NOT_FOUND");
    // The old message quoted the path back, which is why this asserts the text
    // and not only the code.
    expect(taken.message).not.toContain("2-areas/finance/notes.md");
  });

  test("moving cannot confirm one either", async () => {
    const store = await withHiddenNote();
    const taken = await capture(() =>
      movePath(store, {
        from: "1-projects/context-lc.md",
        to: "2-areas/finance/notes.md",
        clearance: clearanceOf("team"),
        now: NOW,
      }),
    );
    const free = await capture(() =>
      movePath(store, {
        from: "1-projects/context-lc.md",
        to: "2-areas/finance/never-existed.md",
        clearance: clearanceOf("team"),
        now: NOW,
      }),
    );
    expect(errorShape(taken)).toBe(errorShape(free));
    expect(taken.code).toBe("FILE_NOT_FOUND");
  });

  /**
   * The worse half. A team caller moving a shared note into a folder they
   * cannot see takes it away from every other member — no exception is
   * recorded, so it is simply private now — and they cannot put it back,
   * because `canSee(from)` refuses them the source from that moment on.
   */
  test("a shared note cannot be moved somewhere only the owner can look", async () => {
    const store = await withHiddenNote();
    const error = await capture(() =>
      movePath(store, {
        from: "1-projects/context-lc.md",
        to: "2-areas/finance/taken.md",
        clearance: clearanceOf("team"),
        now: NOW,
      }),
    );
    expect(error.code).toBe("FILE_NOT_FOUND");
    expect(store.snapshot()["2-areas/finance/taken.md"]).toBeUndefined();
    // ...and the note is still where the rest of the team can see it.
    const listing = await listFolder(store, { path: "1-projects", clearance: clearanceOf("team") });
    expect(names(listing.entries)).toContain("context-lc.md");
  });

  /**
   * The positive controls. A guard that refused every team-scope destination
   * would satisfy all three assertions above and break the file editor for
   * every editor who is allowed to use it.
   */
  test("a move and a copy inside shared space are untouched", async () => {
    const store = await withHiddenNote();
    const moved = await movePath(store, {
      from: "1-projects/context-lc.md",
      to: "1-projects/renamed.md",
      clearance: clearanceOf("team"),
      now: NOW,
    });
    expect(moved.paths).toEqual(["1-projects/renamed.md"]);
    const copied = await copyPath(store, {
      from: "1-projects/renamed.md",
      to: "1-projects/duplicate.md",
      clearance: clearanceOf("team"),
    });
    expect(copied.paths).toEqual(["1-projects/duplicate.md"]);
  });

  test("the owner is not affected — private scope sees everything", async () => {
    const store = await withHiddenNote();
    const moved = await movePath(store, {
      from: "1-projects/context-lc.md",
      to: "2-areas/finance/filed.md",
      clearance: clearanceOf("private"),
      now: NOW,
    });
    expect(moved.paths).toEqual(["2-areas/finance/filed.md"]);
  });

  /**
   * Archiving is a move, so it inherits the rule — and on the scaffold's own
   * defaults `4-archive` is private, which means an editor can no longer
   * archive. That is deliberate rather than incidental: archiving a shared
   * note into a private archive is the same one-way removal as the test three
   * above, reached through a friendlier button, and the gateway has always
   * refused it (`archive_note` checks `visibilityOf(dest)` before writing).
   * An owner who wants editors to archive shares `4-archive`.
   */
  test("archiving follows the same rule, in both directions", async () => {
    const store = await withHiddenNote();
    const refused = await capture(() =>
      archivePath(store, { path: "1-projects/context-lc.md", clearance: clearanceOf("team"), now: NOW }),
    );
    // Its own code and its own sentence. Inheriting the move's "that file does
    // not exist" would say it about a note the caller is looking at.
    expect(refused.code).toBe("ARCHIVE_UNAVAILABLE");
    expect(refused.message).toContain("4-archive");

    // The owner leg belongs here, while `4-archive` is still private — that is
    // the case this change alters, and asserting it after the folder is shared
    // would prove nothing about it.
    const owner = await archivePath(store, {
      path: "1-projects/pay.md",
      clearance: clearanceOf("private"),
      now: NOW,
    });
    expect(owner.paths[0]).toContain("4-archive/");

    await setFolderVisibility(store, {
      path: "4-archive",
      visibility: "team",
      clearance: clearanceOf("private"),
    });
    const allowed = await archivePath(store, {
      path: "1-projects/context-lc.md",
      clearance: clearanceOf("team"),
      now: NOW,
    });
    expect(allowed.paths[0]).toContain("4-archive/");
  });

  /**
   * `folderVisibleAtScope` keeps a private folder visible when it holds a
   * `team` exception, or the note would be unreachable in the tree. That scan
   * compares against `` `${folderPath}/` `` and the trailing slash is the whole
   * of it: without it, an exception under `2-areas/finance/` would also unhide
   * `2-areas/fin`, and every assertion in this file still passed. No other
   * fixture here creates a `team` override, which is why this one does.
   */
  /**
   * Every assertion above moves or copies a single file, and a folder move is
   * the multi-pair path. Guarding only `pairs[0]` passed the entire suite
   * before this test existed.
   */
  test("a folder move is refused on any destination, not just the first", async () => {
    const store = bucket();
    await shareProjects(store);
    store.seed("1-projects/team-folder/a.md", "# A\n");
    store.seed("1-projects/team-folder/b.md", "# B\n");

    const error = await capture(() =>
      movePath(store, {
        from: "1-projects/team-folder",
        to: "2-areas/hidden-folder",
        clearance: clearanceOf("team"),
        now: NOW,
      }),
    );
    expect(error.code).toBe("FILE_NOT_FOUND");
    expect(store.snapshot()["2-areas/hidden-folder/a.md"]).toBeUndefined();
    expect(store.snapshot()["2-areas/hidden-folder/b.md"]).toBeUndefined();

    // The control: the same folder move inside shared space carries both files.
    const moved = await movePath(store, {
      from: "1-projects/team-folder",
      to: "1-projects/renamed-folder",
      clearance: clearanceOf("team"),
      now: NOW,
    });
    expect(moved.paths.sort()).toEqual([
      "1-projects/renamed-folder/a.md",
      "1-projects/renamed-folder/b.md",
    ]);
  });

  /**
   * A move rewrites the manifest after it runs, and the rules follow the folder
   * — which is what this asserts, at owner scope.
   *
   * It used to say that the destination therefore had to be JUDGED against the
   * rules the move leaves behind, and that checking the current ones "refuses
   * renames that preserve visibility, which is a regression with no security to
   * show for it". That argument is the oracle: the rule a move installs cannot
   * be the reason the move is allowed, and the rename it defends is the same
   * operation as a probe at a guessed path. The rewrite still travels; the
   * write permission is decided from the manifest as it stands.
   */
  test("a rename that carries its own visibility with it is allowed", async () => {
    const store = bucket();
    store.seed("2-areas/shared/plan.md", "# Plan\n");
    await setFolderVisibility(store, {
      path: "2-areas/shared",
      visibility: "team",
      clearance: clearanceOf("private"),
    });

    const moved = await movePath(store, {
      from: "2-areas/shared",
      to: "2-areas/shared-renamed",
      clearance: clearanceOf("private"),
      now: NOW,
    });
    expect(moved.paths).toEqual(["2-areas/shared-renamed/plan.md"]);
    // ...and it really is still readable afterwards, which is the premise.
    const listing = await listFolder(store, { path: "2-areas/shared-renamed", clearance: clearanceOf("team") });
    expect(names(listing.entries)).toEqual(["plan.md"]);
  });

  /**
   * A shared note inside a private folder is a note the caller may READ and a
   * place they may not WRITE, and those are different questions. The console
   * used to answer the second with the first, which is what made a shared note
   * into a key that opened every folder. It now answers the way the gateway's
   * `move_note` always has.
   *
   * This is a deliberate behaviour change: a team caller can no longer rename
   * such a note in place. The two halves of the product now agree, and the
   * owner is unaffected.
   */
  test("a shared note inside a private folder cannot be moved by a team caller", async () => {
    const store = bucket();
    store.seed("2-areas/open.md", "# Open\n");
    await setVisibility(store, {
      path: "2-areas/open.md",
      visibility: "team",
      clearance: clearanceOf("private"),
    });
    // They can read it — that is the whole point of the exception.
    const readable = await readFile(store, { path: "2-areas/open.md", clearance: clearanceOf("team") });
    expect(readable.visibility).toBe("team");

    const refused = await capture(() =>
      movePath(store, {
        from: "2-areas/open.md",
        to: "2-areas/open-renamed.md",
        clearance: clearanceOf("team"),
        now: NOW,
      }),
    );
    expect(refused.code).toBe("FILE_NOT_FOUND");

    // The owner can, and the note keeps its exception.
    const moved = await movePath(store, {
      from: "2-areas/open.md",
      to: "2-areas/open-renamed.md",
      clearance: clearanceOf("private"),
      now: NOW,
    });
    expect(moved.paths).toEqual(["2-areas/open-renamed.md"]);
    const after = await readFile(store, { path: "2-areas/open-renamed.md", clearance: clearanceOf("team") });
    expect(after.visibility).toBe("team");
  });

  /**
   * A copy is not a move: `copyPrivacy` carries a note's exception but not a
   * folder's rule, so a copied folder lands under whatever rules already reach
   * it. Judging a copy against the post-move rules would let a caller copy a
   * shared folder into space they cannot see and believe it stayed shared.
   */
  test("copying a folder into space the caller cannot see is still refused", async () => {
    const store = bucket();
    store.seed("2-areas/shared/plan.md", "# Plan\n");
    await setFolderVisibility(store, {
      path: "2-areas/shared",
      visibility: "team",
      clearance: clearanceOf("private"),
    });
    const error = await capture(() =>
      copyPath(store, {
        from: "2-areas/shared",
        to: "2-areas/elsewhere",
        clearance: clearanceOf("team"),
      }),
    );
    expect(error.code).toBe("FILE_NOT_FOUND");
  });

  /**
   * A destination that already carries an exception is refused outright, so a
   * caller can never land on a note whose visibility is unusual — nor learn
   * from the attempt that it is. The gateway refuses this too.
   */
  test("a destination carrying its own exception is refused", async () => {
    const store = bucket();
    await shareProjects(store);
    store.seed("1-projects/mine.md", "# Mine\n");
    store.seed("1-projects/held-back.md", "# Held back\n");
    await setVisibility(store, {
      path: "1-projects/held-back.md",
      visibility: "private",
      clearance: clearanceOf("private"),
    });

    const taken = await capture(() =>
      movePath(store, {
        from: "1-projects/mine.md",
        to: "1-projects/held-back.md",
        clearance: clearanceOf("team"),
        now: NOW,
      }),
    );
    const free = await capture(() =>
      movePath(store, {
        from: "1-projects/mine.md",
        to: "2-areas/never.md",
        clearance: clearanceOf("team"),
        now: NOW,
      }),
    );
    expect(errorShape(taken)).toBe(errorShape(free));
    expect(taken.message).not.toContain("held-back");

    // ...and an ordinary move inside the shared folder still works.
    const moved = await movePath(store, {
      from: "1-projects/mine.md",
      to: "1-projects/renamed.md",
      clearance: clearanceOf("team"),
      now: NOW,
    });
    expect(moved.paths).toEqual(["1-projects/renamed.md"]);
  });

  /**
   * A nested `team` rule has to unhide its ancestors for the same reason a
   * nested `team` exception does. Only the exceptions were scanned, so an
   * owner who shared one subfolder out of a private parent got something
   * readable by direct path and absent from the tree — the root listing came
   * back empty. The trailing slash is load-bearing here too.
   */
  test("a shared subfolder of a private folder is reachable from the root", async () => {
    const store = bucket();
    store.seed("2-areas/shared/plan.md", "# Plan\n");
    store.seed("2-areas/sha/secret.md", "# Secret\n");
    await setFolderVisibility(store, {
      path: "2-areas/shared",
      visibility: "team",
      clearance: clearanceOf("private"),
    });

    const root = await listFolder(store, { path: "", clearance: clearanceOf("team") });
    expect(names(root.entries)).toContain("2-areas");

    const areas = await listFolder(store, { path: "2-areas", clearance: clearanceOf("team") });
    expect(names(areas.entries)).toContain("shared");
    // The prefix boundary: `2-areas/sha` is not unhidden by `2-areas/shared`.
    expect(names(areas.entries)).not.toContain("sha");
    // ...and nothing private inside the parent came with it.
    expect(names(areas.entries)).not.toContain("health.md");
  });

  test("a team exception unhides its own folder and not a name it prefixes", async () => {
    const store = bucket();
    await shareProjects(store);
    store.seed("2-areas/finance/public.md", "# Public\n");
    store.seed("2-areas/fin/secret.md", "# Secret\n");
    await setVisibility(store, {
      path: "2-areas/finance/public.md",
      visibility: "team",
      clearance: clearanceOf("private"),
    });

    const listing = await listFolder(store, { path: "2-areas", clearance: clearanceOf("team") });
    expect(names(listing.entries)).toContain("finance");
    expect(names(listing.entries)).not.toContain("fin");
  });
});

describe("deleting is the permanent one", () => {
  test("without the confirmation, nothing happens", async () => {
    const store = bucket();
    const error = await capture(() =>
      deletePath(store, {
        path: "1-projects/context-lc.md",
        confirmation: "yes",
        clearance: clearanceOf("private"),
      }),
    );
    expect(error.code).toBe("CONFIRMATION_REQUIRED");
    expect(error.message).toMatch(/cannot be undone/);
    expect(store.snapshot()["1-projects/context-lc.md"]).toContain("# Context.LC");
  });

  test("an empty confirmation is not a confirmation", async () => {
    const store = bucket();
    const error = await capture(() =>
      deletePath(store, { path: "1-projects/context-lc.md", confirmation: "", clearance: clearanceOf("private") }),
    );
    expect(error.code).toBe("CONFIRMATION_REQUIRED");
  });

  test("with the confirmation, the file is gone", async () => {
    const store = bucket();
    await deletePath(store, {
      path: "1-projects/context-lc.md",
      confirmation: DELETE_CONFIRMATION,
      clearance: clearanceOf("private"),
    });
    expect(store.snapshot()["1-projects/context-lc.md"]).toBeUndefined();
  });

  /**
   * "Permanent" has to mean it. A `.history/` copy left behind would make the
   * console's plainest sentence a lie, in the one product whose whole claim is
   * that you know where your data is.
   */
  test("nothing is quietly kept behind", async () => {
    const store = bucket();
    await deletePath(store, {
      path: "1-projects/pay.md",
      confirmation: DELETE_CONFIRMATION,
      clearance: clearanceOf("private"),
    });
    const survivors = Object.entries(store.snapshot()).filter(([, body]) =>
      body.includes("salaries"),
    );
    expect(survivors).toEqual([]);
  });

  test("deleting a folder takes everything under it", async () => {
    const store = bucket();
    await deletePath(store, {
      path: "1-projects",
      confirmation: DELETE_CONFIRMATION,
      clearance: clearanceOf("private"),
    });
    const remaining = Object.keys(store.snapshot()).filter((key) =>
      key.startsWith("1-projects/"),
    );
    expect(remaining).toEqual([]);
  });

  /**
   * The half that was missing, said as a fact about keys rather than about
   * content.
   *
   * `nothing is quietly kept behind` above searches for a string, which is the
   * right assertion for "is my salary data gone" and the wrong one for "is
   * there a copy". These name the bucket directly: after a permanent delete,
   * **no key under `.history/` for that path may remain**. Everything else in
   * this product is reversible — archive, an overwritten note — and this one
   * says on screen that it is not. A hidden copy is still a copy: it is in the
   * customer's bucket, on their storage bill, and in whatever their provider
   * hands over.
   */
  describe("permanent means the history goes too", () => {
    test("a deleted note leaves no key under .history/ for its path", async () => {
      const store = bucket();
      await deletePath(store, {
        path: "1-projects/pay.md",
        confirmation: DELETE_CONFIRMATION,
        clearance: clearanceOf("private"),
      });
      expect(
        historyKeys(store).filter((key) => key.startsWith(".history/1-projects/pay.md.")),
      ).toEqual([]);
    });

    test("and no key anywhere in the bucket still holds its content", async () => {
      const store = bucket();
      await deletePath(store, {
        path: "1-projects/pay.md",
        confirmation: DELETE_CONFIRMATION,
        clearance: clearanceOf("private"),
      });
      expect(
        Object.entries(store.snapshot()).filter(([, body]) => body.includes("salaries")),
      ).toEqual([]);
    });

    /**
     * The path a real person takes: write a note, change it, delete it.
     *
     * The edit no longer stashes the first draft — nothing does — so the first
     * half of this now guards that, and the second half still guards the purge.
     * A bucket connected before snapshots stopped is the case the seeded
     * fixtures below cover; this one is the bucket of somebody who joined after.
     */
    test("a note written, edited, then deleted leaves nothing of either version", async () => {
      const store = bucket();
      const first = await writeFile(store, {
        path: "1-projects/secret.md",
        text: "# Secret\n\nthe first draft\n",
        clearance: clearanceOf("private"),
        now: NOW,
      });
      await writeFile(store, {
        path: "1-projects/secret.md",
        text: "# Secret\n\nthe second draft\n",
        expectedEtag: first.etag,
        clearance: clearanceOf("private"),
        now: NOW + 60_000,
      });
      // The edit kept nothing, so there is nothing for the delete to miss.
      expect(
        Object.entries(store.snapshot()).filter(([, body]) => body.includes("the first draft")),
      ).toEqual([]);

      await deletePath(store, {
        path: "1-projects/secret.md",
        confirmation: DELETE_CONFIRMATION,
        clearance: clearanceOf("private"),
      });

      expect(
        historyKeys(store).filter((key) => key.startsWith(".history/1-projects/secret.md.")),
      ).toEqual([]);
      expect(
        Object.entries(store.snapshot()).filter(([, body]) => body.includes("draft")),
      ).toEqual([]);
    });

    test("deleting a folder purges the whole history subtree beneath it", async () => {
      const store = bucket();
      await deletePath(store, {
        path: "1-projects",
        confirmation: DELETE_CONFIRMATION,
        clearance: clearanceOf("private"),
      });
      expect(historyKeys(store).filter((key) => key.startsWith(".history/1-projects/"))).toEqual(
        [],
      );
    });

    /**
     * The purge is narrow. Deleting one note must not take the history of the
     * notes beside it — that would be the opposite failure, and just as silent.
     */
    test("it takes only this path's history, never a neighbour's", async () => {
      const store = bucket();
      const before = historyKeys(store).filter((key) => key.startsWith(".history/2-areas/"));
      expect(before.length).toBeGreaterThan(0);

      await deletePath(store, {
        path: "1-projects/pay.md",
        confirmation: DELETE_CONFIRMATION,
        clearance: clearanceOf("private"),
      });

      expect(historyKeys(store).filter((key) => key.startsWith(".history/2-areas/"))).toEqual(
        before,
      );
      expect(store.snapshot()["1-projects/context-lc.md"]).toBeDefined();
      expect(store.snapshot()[".history/1-projects/context-lc.md.old.md"]).toBeDefined();
    });

    /**
     * Archive is the recoverable one, and it must stay that way: it is what the
     * delete dialog points people at instead. Archiving is a move, and a move
     * keeps its snapshot.
     */
    test("archiving still keeps a history entry — only deleting purges", async () => {
      const store = bucket();
      await archivePath(store, { path: "2-areas/health.md", clearance: clearanceOf("private"), now: NOW });
      expect(historyKeys(store).some((key) => key.startsWith(".history/2-areas/health.md."))).toBe(
        true,
      );
    });

    test("a refused delete purges nothing", async () => {
      const store = bucket();
      const before = historyKeys(store);
      await capture(() =>
        deletePath(store, {
          path: "1-projects/pay.md",
          confirmation: "yes",
          clearance: clearanceOf("private"),
        }),
      );
      expect(historyKeys(store)).toEqual(before);
    });

    /**
     * A `team` caller cannot see the note, so they cannot delete it — and they
     * must not be able to reach through the refusal to shred its history
     * either. The refusal has to be total, not just about the live key.
     */
    test("a caller who cannot see the note cannot purge its history", async () => {
      const store = bucket();
      await shareProjects(store);
      const before = historyKeys(store);
      await capture(() =>
        deletePath(store, {
          path: "1-projects/pay.md",
          confirmation: DELETE_CONFIRMATION,
          clearance: clearanceOf("team"),
        }),
      );
      expect(historyKeys(store)).toEqual(before);
    });
  });

  test("a deleted note's exception is forgotten, so a later note at that path is not secretly private", async () => {
    const store = bucket();
    await shareProjects(store);
    await deletePath(store, {
      path: "1-projects/pay.md",
      confirmation: DELETE_CONFIRMATION,
      clearance: clearanceOf("private"),
    });
    const manifest = parsePrivacyManifest(store.snapshot()[PRIVACY_KEY]);
    expect(manifest.overrides.has("1-projects/pay.md")).toBe(false);
  });

  test("a team caller cannot delete what they cannot see", async () => {
    const store = bucket();
    await shareProjects(store);
    const error = await capture(() =>
      deletePath(store, {
        path: "1-projects/pay.md",
        confirmation: DELETE_CONFIRMATION,
        clearance: clearanceOf("team"),
      }),
    );
    expect(error.code).toBe("FILE_NOT_FOUND");
    expect(store.snapshot()["1-projects/pay.md"]).toContain("salaries");
  });
});

/* -------------------------------------------------------------------------- */
/*                                 visibility                                 */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/*                 a bulk operation acts on what you can see                  */
/* -------------------------------------------------------------------------- */

