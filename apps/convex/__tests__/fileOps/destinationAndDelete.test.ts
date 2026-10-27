import { describe, expect, test } from "vitest";
import { clearanceOf } from "../../functions/lib/clearance";
import { treeView } from "../../functions/lib/fileOps/walk";
import { DELETE_CONFIRMATION, type FileStore, archivePath, copyPath, createFolder, deletePath, listFolder, movePath, readFile, trashPath, writeFile } from "../../functions/lib/fileOps";
import { canSee } from "../../functions/lib/privacy";
import { NOW, shareProjects, capture, errorShape, names } from "./fixtures.helpers";
import {
  keyedBucket,
  liveRowsUnder,
  PARA_SEEDS,
  rowOf2,
  rowRulesOf,
  textAt,
  type KeyedBucket,
} from "./keyedFixture.fileops1.helpers";
import { setFolderVisibility, setVisibility } from "../seededRules.helpers";
import { nodeAt as treeNodeAt } from "../../functions/lib/nodes/paths";

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
  async function withHiddenNote(): Promise<KeyedBucket> {
    const f = await keyedBucket(PARA_SEEDS);
    await shareProjects(f.store);
    await f.store.put("2-areas/finance/notes.md", "# Notes\n\nsalaries\n");
    return f;
  }

  test("copying cannot confirm a note exists where the caller cannot look", async () => {
    const { store } = await withHiddenNote();
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
    const { store } = await withHiddenNote();
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
    const f = await withHiddenNote();
    const error = await capture(() =>
      movePath(f.store, {
        from: "1-projects/context-lc.md",
        to: "2-areas/finance/taken.md",
        clearance: clearanceOf("team"),
        now: NOW,
      }),
    );
    expect(error.code).toBe("FILE_NOT_FOUND");
    expect(await textAt(f, "2-areas/finance/taken.md")).toBeNull();
    // ...and the note is still where the rest of the team can see it.
    const listing = await listFolder(treeView(f.store), { path: "1-projects", clearance: clearanceOf("team") });
    expect(names(listing.entries)).toContain("context-lc.md");
  });

  /**
   * The positive controls. A guard that refused every team-scope destination
   * would satisfy all three assertions above and break the file editor for
   * every editor who is allowed to use it.
   */
  test("a move and a copy inside shared space are untouched", async () => {
    const { store } = await withHiddenNote();
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
    const { store } = await withHiddenNote();
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
   * defaults `9-archive` is private, which means an editor can no longer
   * archive. That is deliberate rather than incidental: archiving a shared
   * note into a private archive is the same one-way removal as the test three
   * above, reached through a friendlier button, and the gateway has always
   * refused it (`archive_note` checks `visibilityOf(dest)` before writing).
   * An owner who wants editors to archive shares `9-archive`.
   */
  test("archiving follows the same rule, in both directions", async () => {
    const { store } = await withHiddenNote();
    const refused = await capture(() =>
      archivePath(store, { path: "1-projects/context-lc.md", clearance: clearanceOf("team"), now: NOW }),
    );
    // Its own code and its own sentence. Inheriting the move's "that file does
    // not exist" would say it about a note the caller is looking at.
    expect(refused.code).toBe("ARCHIVE_UNAVAILABLE");
    expect(refused.message).toContain("9-archive");

    // The owner leg belongs here, while `9-archive` is still private — that is
    // the case this change alters, and asserting it after the folder is shared
    // would prove nothing about it.
    const owner = await archivePath(store, {
      path: "1-projects/pay.md",
      clearance: clearanceOf("private"),
      now: NOW,
    });
    expect(owner.paths[0]).toContain("9-archive/");

    await setFolderVisibility(store, {
      path: "9-archive",
      visibility: "team",
      clearance: clearanceOf("private"),
    });
    const allowed = await archivePath(store, {
      path: "1-projects/context-lc.md",
      clearance: clearanceOf("team"),
      now: NOW,
    });
    expect(allowed.paths[0]).toContain("9-archive/");
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
    const f = await keyedBucket(PARA_SEEDS);
    await shareProjects(f.store);
    await f.store.put("1-projects/team-folder/a.md", "# A\n");
    await f.store.put("1-projects/team-folder/b.md", "# B\n");

    const error = await capture(() =>
      movePath(f.store, {
        from: "1-projects/team-folder",
        to: "2-areas/hidden-folder",
        clearance: clearanceOf("team"),
        now: NOW,
      }),
    );
    expect(error.code).toBe("FILE_NOT_FOUND");
    expect(await liveRowsUnder(f, "2-areas/hidden-folder")).toEqual([]);

    // The control: the same folder move inside shared space carries both files.
    const moved = await movePath(f.store, {
      from: "1-projects/team-folder",
      to: "1-projects/renamed-folder",
      clearance: clearanceOf("team"),
      now: NOW,
    });
    expect((moved.moved ?? []).map((pair) => pair.to).sort()).toEqual([
      "1-projects/renamed-folder/a.md",
      "1-projects/renamed-folder/b.md",
    ]);
    expect(await liveRowsUnder(f, "1-projects/renamed-folder")).toEqual([
      "1-projects/renamed-folder",
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
    const f = await keyedBucket(PARA_SEEDS);
    await f.store.put("2-areas/shared/plan.md", "# Plan\n");
    await setFolderVisibility(f.store, {
      path: "2-areas/shared",
      visibility: "team",
      clearance: clearanceOf("private"),
    });

    const moved = await movePath(f.store, {
      from: "2-areas/shared",
      to: "2-areas/shared-renamed",
      clearance: clearanceOf("private"),
      now: NOW,
    });
    // A keyed folder move is one row change, answered with the folder's new path.
    expect(moved.paths).toEqual(["2-areas/shared-renamed"]);
    // ...and it really is still readable afterwards, which is the premise.
    const listing = await listFolder(treeView(f.store), { path: "2-areas/shared-renamed", clearance: clearanceOf("team") });
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
    // Rows mode (production): the note's own exception is its row's `access.base`, and the row moves with it.
    const f = await keyedBucket(PARA_SEEDS);
    await f.t.run((ctx) => ctx.db.insert("nodeMigration", { paused: false, accessSource: "rows", updatedAt: 1 }));
    await f.store.put("2-areas/open.md", "# Open\n");
    await f.t.run(async (ctx) => {
      const row = await treeNodeAt(ctx.db, f.workspaceId, "2-areas/open.md");
      await ctx.db.patch(row!._id, { access: { base: "team" } });
    });

    const refused = await capture(() =>
      movePath(f.store, {
        from: "2-areas/open.md",
        to: "2-areas/open-renamed.md",
        clearance: clearanceOf("team"),
        now: NOW,
      }),
    );
    expect(refused.code).toBe("FILE_NOT_FOUND");

    // The owner can, and the note keeps its exception.
    const moved = await movePath(f.store, {
      from: "2-areas/open.md",
      to: "2-areas/open-renamed.md",
      clearance: clearanceOf("private"),
      now: NOW,
    });
    expect(moved.paths).toEqual(["2-areas/open-renamed.md"]);
    expect(await rowOf2(f, "2-areas/open-renamed.md")).toEqual({
      path: "2-areas/open-renamed.md",
      access: { base: "team" },
    });
  });

  /**
   * A copy is not a move: `copyPrivacy` carries a note's exception but not a
   * folder's rule, so a copied folder lands under whatever rules already reach
   * it. Judging a copy against the post-move rules would let a caller copy a
   * shared folder into space they cannot see and believe it stayed shared.
   */
  test("copying a folder into space the caller cannot see is still refused", async () => {
    const f = await keyedBucket(PARA_SEEDS);
    await f.store.put("2-areas/shared/plan.md", "# Plan\n");
    await setFolderVisibility(f.store, {
      path: "2-areas/shared",
      visibility: "team",
      clearance: clearanceOf("private"),
    });
    const error = await capture(() =>
      copyPath(f.store, {
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
    const f = await keyedBucket(PARA_SEEDS);
    await shareProjects(f.store);
    await f.store.put("1-projects/mine.md", "# Mine\n");
    await f.store.put("1-projects/held-back.md", "# Held back\n");
    await setVisibility(f.store, {
      path: "1-projects/held-back.md",
      visibility: "private",
      clearance: clearanceOf("private"),
    });

    const taken = await capture(() =>
      movePath(f.store, {
        from: "1-projects/mine.md",
        to: "1-projects/held-back.md",
        clearance: clearanceOf("team"),
        now: NOW,
      }),
    );
    const free = await capture(() =>
      movePath(f.store, {
        from: "1-projects/mine.md",
        to: "2-areas/never.md",
        clearance: clearanceOf("team"),
        now: NOW,
      }),
    );
    expect(errorShape(taken)).toBe(errorShape(free));
    expect(taken.message).not.toContain("held-back");

    // ...and an ordinary move inside the shared folder still works.
    const moved = await movePath(f.store, {
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
    const f = await keyedBucket(PARA_SEEDS);
    await f.store.put("2-areas/shared/plan.md", "# Plan\n");
    await f.store.put("2-areas/sha/secret.md", "# Secret\n");
    await setFolderVisibility(f.store, {
      path: "2-areas/shared",
      visibility: "team",
      clearance: clearanceOf("private"),
    });

    const root = await listFolder(treeView(f.store), { path: "", clearance: clearanceOf("team") });
    expect(names(root.entries)).toContain("2-areas");

    const areas = await listFolder(treeView(f.store), { path: "2-areas", clearance: clearanceOf("team") });
    expect(names(areas.entries)).toContain("shared");
    // The prefix boundary: `2-areas/sha` is not unhidden by `2-areas/shared`.
    expect(names(areas.entries)).not.toContain("sha");
    // ...and nothing private inside the parent came with it.
    expect(names(areas.entries)).not.toContain("health.md");
  });

  test("a team exception unhides its own folder and not a name it prefixes", async () => {
    const f = await keyedBucket(PARA_SEEDS);
    await shareProjects(f.store);
    await f.store.put("2-areas/finance/public.md", "# Public\n");
    await f.store.put("2-areas/fin/secret.md", "# Secret\n");
    await setVisibility(f.store, {
      path: "2-areas/finance/public.md",
      visibility: "team",
      clearance: clearanceOf("private"),
    });

    const listing = await listFolder(treeView(f.store), { path: "2-areas", clearance: clearanceOf("team") });
    expect(names(listing.entries)).toContain("finance");
    expect(names(listing.entries)).not.toContain("fin");
  });
});

/**
 * Permanent delete is not available in a keyed workspace (`fileOps/deleting.ts`):
 * every workspace is keyed, and a keyed row and its key are retired only by
 * emptying the trash. What is left to assert is that the refusal changes
 * nothing, that the confirmation still has to be given, and that a caller who
 * cannot see a note gets the same answer as for a note that does not exist.
 */
describe("deleting is the permanent one", () => {
  test("without the confirmation, nothing happens", async () => {
    const f = await keyedBucket(PARA_SEEDS);
    const error = await capture(() =>
      deletePath(f.store, {
        path: "1-projects/context-lc.md",
        confirmation: "yes",
        clearance: clearanceOf("private"),
      }),
    );
    expect(error.code).toBe("CONFIRMATION_REQUIRED");
    expect(error.message).toMatch(/cannot be undone/);
    expect(await textAt(f, "1-projects/context-lc.md")).toContain("# Context.LC");
  });

  test("an empty confirmation is not a confirmation", async () => {
    const f = await keyedBucket(PARA_SEEDS);
    const error = await capture(() =>
      deletePath(f.store, { path: "1-projects/context-lc.md", confirmation: "", clearance: clearanceOf("private") }),
    );
    expect(error.code).toBe("CONFIRMATION_REQUIRED");
  });

  test("with the confirmation, a keyed workspace still refuses, and the note stays", async () => {
    const f = await keyedBucket(PARA_SEEDS);
    const error = await capture(() =>
      deletePath(f.store, {
        path: "1-projects/context-lc.md",
        confirmation: DELETE_CONFIRMATION,
        clearance: clearanceOf("private"),
      }),
    );
    expect(error.code).toBe("KEYED_WORKSPACE");
    expect(error.message).toMatch(/Permanent delete is not available in a keyed workspace/);
    expect(await textAt(f, "1-projects/context-lc.md")).toContain("# Context.LC");
  });

  test("a folder's permanent delete is refused too, and everything under it stays", async () => {
    const f = await keyedBucket(PARA_SEEDS); // An own folder: built-in ones cannot be deleted.
    for (const path of ["work/README.md", "work/plan.md", "work/deep/notes.md"]) await f.store.put(path, "# Note\n");
    const error = await capture(() =>
      deletePath(f.store, {
        path: "work",
        confirmation: DELETE_CONFIRMATION,
        clearance: clearanceOf("private"),
      }),
    );
    expect(error.code).toBe("KEYED_WORKSPACE");
    expect(await liveRowsUnder(f, "work")).toEqual([
      "work",
      "work/README.md",
      "work/deep",
      "work/deep/notes.md",
      "work/plan.md",
    ]);
  });

  test("a refused permanent delete leaves the note's exception in place", async () => {
    const f = await keyedBucket(PARA_SEEDS);
    await shareProjects(f.store);
    await capture(() =>
      deletePath(f.store, {
        path: "1-projects/pay.md",
        confirmation: DELETE_CONFIRMATION,
        clearance: clearanceOf("private"),
      }),
    );
    const { overrides } = await rowRulesOf(f);
    expect(overrides.has("1-projects/pay.md")).toBe(true);
  });

  test("a team caller cannot trash what they cannot see, and gets the answer for a note that is not there", async () => {
    const f = await keyedBucket(PARA_SEEDS);
    await shareProjects(f.store);
    const hidden = await capture(() =>
      trashPath(f.store, { path: "1-projects/pay.md", clearance: clearanceOf("team"), now: NOW }),
    );
    const absent = await capture(() =>
      trashPath(f.store, { path: "1-projects/never.md", clearance: clearanceOf("team"), now: NOW }),
    );
    expect(hidden.code).toBe("FILE_NOT_FOUND");
    expect(errorShape(hidden)).toBe(errorShape(absent));
    expect(await textAt(f, "1-projects/pay.md")).toContain("salaries");
  });

  test("a team caller's permanent delete of a hidden note is refused exactly as one of a note that is not there", async () => {
    const f = await keyedBucket(PARA_SEEDS);
    await shareProjects(f.store);
    const hidden = await capture(() =>
      deletePath(f.store, { path: "1-projects/pay.md", confirmation: DELETE_CONFIRMATION, clearance: clearanceOf("team") }),
    );
    const absent = await capture(() =>
      deletePath(f.store, { path: "1-projects/never.md", confirmation: DELETE_CONFIRMATION, clearance: clearanceOf("team") }),
    );
    expect(errorShape(hidden)).toBe(errorShape(absent));
    expect(await textAt(f, "1-projects/pay.md")).toContain("salaries");
  });
});

/* -------------------------------------------------------------------------- */
/*                                 visibility                                 */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/*                 a bulk operation acts on what you can see                  */
/* -------------------------------------------------------------------------- */
