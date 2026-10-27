import { describe, expect, test } from "vitest";
import { clearanceOf } from "../../functions/lib/clearance";
import { archivePath, copyPath, createFolder, duplicateName, duplicatePath, listFolder, movePath, readFile, renderNewFolderAbout, restoreTrashedPath, trashPath, writeFile } from "../../functions/lib/fileOps";
import { treeView } from "../../functions/lib/fileOps/walk";
import { canSee, isPlumbing } from "../../functions/lib/privacy";
import { NOW, shareProjects, capture, errorShape, names } from "./fixtures.helpers";
import {
  bytesAt,
  keyedBucket,
  KeyedBucket,
  liveAt,
  liveRowsUnder,
  notesAt,
  PARA_SEEDS,
  rowOf2,
  rowRulesOf,
  textAt,
} from "./keyedFixture.fileops1.helpers";
import {
  setFolderVisibility,
  setVisibility,
  renderPrivacyManifestForFolders,
} from "../seededRules.helpers";
import { nodeAt as treeNodeAt } from "../../functions/lib/nodes/paths";

/** The rules a keyed bucket's rows give a reader: the answer `canSee` is asked with. */
const manifestOf = rowRulesOf;

/** The note's live rows beneath a folder, as paths, folder itself excluded. */
async function notesUnder(f: KeyedBucket, folder: string): Promise<string[]> {
  return (await liveRowsUnder(f, folder)).filter((path) => path !== folder);
}

/* -------------------------------------------------------------------------- */
/*                          creating, copying, moving                         */
/* -------------------------------------------------------------------------- */

describe("creating a folder", () => {
  test("writes an about.md so the folder is real for every other tool", async () => {
    const f = await keyedBucket(PARA_SEEDS);
    const created = await createFolder(f.store, {
      path: "1-projects/new-thing",
      clearance: clearanceOf("private"),
      now: NOW,
    });
    expect(created.readme).toBe("1-projects/new-thing/about.md");
    expect(await liveAt(f, "1-projects/new-thing/about.md")).toBe(true);
    expect(await liveAt(f, "1-projects/new-thing/README.md")).toBe(false);
    const listing = await listFolder(treeView(f.store), { path: "1-projects", clearance: clearanceOf("private") });
    expect(names(listing.entries)).toContain("new-thing");
  });

  /**
   * A new folder's one key is its about note, written empty: a heading would
   * title the folder page and go stale when the folder is renamed.
   */
  test("the about.md is written empty", async () => {
    const f = await keyedBucket(PARA_SEEDS);
    const created = await createFolder(f.store, {
      path: "1-projects/new-thing",
      clearance: clearanceOf("private"),
      now: NOW,
    });
    expect(created.readme).toBe("1-projects/new-thing/about.md");
    expect(await textAt(f, created.readme)).toBe("");
    expect(await notesUnder(f, "1-projects/new-thing")).toEqual(["1-projects/new-thing/about.md"]);
    expect(renderNewFolderAbout("1-projects/new-thing")).toBe("");
  });

  test("creating one twice is refused rather than silently reused", async () => {
    const f = await keyedBucket(PARA_SEEDS);
    await createFolder(f.store, { path: "1-projects/new-thing", clearance: clearanceOf("private"), now: NOW });
    const error = await capture(() =>
      createFolder(f.store, { path: "1-projects/new-thing", clearance: clearanceOf("private"), now: NOW }),
    );
    expect(error.code).toBe("DESTINATION_EXISTS");
  });

  /**
   * "That folder already exists" is a true sentence and, said to someone who
   * cannot see the folder, it is also a disclosure. Both existing tests above
   * run at `private` scope, so the whole team-scope population of this
   * operation was untested — and it answered `DESTINATION_EXISTS` for a folder
   * the same caller's `listFolder` refuses to admit is there.
   *
   * The damage is that a miss is uniform. Every name that is not there answers
   * `FILE_NOT_FOUND`, so any other answer is a confirmed hit, and the names
   * worth guessing in somebody's private half are short words: a client, an
   * employer, a diagnosis, a legal matter. No manifest rule names `finance`
   * here — this is object existence leaking on its own, not the rule set.
   */
  test("a hidden folder is not confirmed by trying to create it", async () => {
    const f = await keyedBucket(PARA_SEEDS);
    await shareProjects(f.store);
    await f.store.put("2-areas/finance/README.md", "# Finance\n");

    // The premise: at team scope `2-areas` is not in the tree at all.
    const root = await listFolder(treeView(f.store), { path: "", clearance: clearanceOf("team") });
    expect(names(root.entries)).not.toContain("2-areas");

    const hit = await capture(() =>
      createFolder(f.store, { path: "2-areas/finance", clearance: clearanceOf("team"), now: NOW }),
    );
    const miss = await capture(() =>
      createFolder(f.store, { path: "2-areas/never-existed", clearance: clearanceOf("team"), now: NOW }),
    );
    expect(errorShape(hit)).toBe(errorShape(miss));
    expect(hit.code).toBe("FILE_NOT_FOUND");

    // ...and the refusal is not a blanket one. A guard that refused every
    // team-scope creation would satisfy the two assertions above while
    // breaking the operation for every editor who is allowed to use it.
    const allowed = await createFolder(f.store, {
      path: "1-projects/new-thing",
      clearance: clearanceOf("team"),
      now: NOW,
    });
    expect(allowed.readme).toBe("1-projects/new-thing/about.md");
  });
});

describe("duplicate names", () => {
  test("follows Obsidian's convention", () => {
    expect(duplicateName("foo.md", new Set())).toBe("foo copy.md");
    expect(duplicateName("foo.md", new Set(["foo copy.md"]))).toBe("foo copy 2.md");
    expect(duplicateName("foo.md", new Set(["foo copy.md", "foo copy 2.md"]))).toBe(
      "foo copy 3.md",
    );
  });

  test("a folder with no extension keeps its whole name", () => {
    expect(duplicateName("notes", new Set())).toBe("notes copy");
  });

  test("a dotfile-looking name is not split at its leading dot", () => {
    expect(duplicateName(".keep", new Set())).toBe(".keep copy");
  });
});

describe("moving and renaming", () => {
  test("a collaborative move returns the etag after rewriting its own links", async () => {
    const f = await keyedBucket(PARA_SEEDS);
    await f.store.put("1-projects/old.md", "# Old\n\n[[old]]\n");
    const moved = await movePath(f.store, {
      from: "1-projects/old.md",
      to: "1-projects/nested/new.md",
      clearance: clearanceOf("private"),
      now: NOW,
    });
    const current = await readFile(f.store, {
      path: "1-projects/nested/new.md",
      clearance: clearanceOf("private"),
    });

    expect(moved.etag).toBe(current.etag);
  });

  test("a rename is a move whose parent does not change", async () => {
    const f = await keyedBucket(PARA_SEEDS);
    await movePath(f.store, {
      from: "1-projects/context-lc.md",
      to: "1-projects/context.md",
      clearance: clearanceOf("private"),
      now: NOW,
    });
    expect(await textAt(f, "1-projects/context.md")).toContain("# Context.LC");
    expect(await liveAt(f, "1-projects/context-lc.md")).toBe(false);
  });

  // An own folder: the built-in ones (`1-projects`) stay where they are.
  test("a whole folder moves, keeping its shape", async () => {
    const f = await keyedBucket(PARA_SEEDS);
    await f.store.put("work/context-lc.md", "# Context.LC\n\nnotes\n");
    await f.store.put("work/money/pay.md", "# Pay\n\nsalaries\n");
    await movePath(f.store, {
      from: "work",
      to: "2-areas/work",
      clearance: clearanceOf("private"),
      now: NOW,
    });
    expect(await textAt(f, "2-areas/work/context-lc.md")).toContain("# Context.LC");
    expect(await textAt(f, "2-areas/work/money/pay.md")).toContain("salaries");
    expect(await liveAt(f, "work/money/pay.md")).toBe(false);
  });

  test("an existing destination is refused rather than merged over", async () => {
    const f = await keyedBucket(PARA_SEEDS);
    const error = await capture(() =>
      movePath(f.store, {
        from: "1-projects/context-lc.md",
        to: "1-projects/pay.md",
        clearance: clearanceOf("private"),
        now: NOW,
      }),
    );
    expect(error.code).toBe("DESTINATION_EXISTS");
    expect(await textAt(f, "1-projects/pay.md")).toContain("salaries");
  });

  test("a refused collaborative collision cannot loosen the destination ACL", async () => {
    const f = await keyedBucket(PARA_SEEDS);
    await shareProjects(f.store);
    const before = await capture(() =>
      readFile(f.store, {
        path: "1-projects/pay.md",
        clearance: clearanceOf("team"),
      }),
    );
    expect(before.code).toBe("FILE_NOT_FOUND");

    const refusal = await capture(() =>
      movePath(f.store, {
        from: "1-projects/context-lc.md",
        to: "1-projects/pay.md",
        clearance: clearanceOf("private"),
        now: NOW,
      }),
    );
    const after = await capture(() =>
      readFile(f.store, {
        path: "1-projects/pay.md",
        clearance: clearanceOf("team"),
      }),
    );

    expect(refusal.code).toBe("DESTINATION_EXISTS");
    expect(after.code).toBe("FILE_NOT_FOUND");
  });

  test("a folder cannot be moved inside itself", async () => {
    const f = await keyedBucket(PARA_SEEDS);
    const error = await capture(() =>
      movePath(f.store, {
        from: "1-projects",
        to: "1-projects/inner",
        clearance: clearanceOf("private"),
        now: NOW,
      }),
    );
    expect(error.code).toBe("PATH_INVALID");
  });

  test("moving something that is not there fails like anything else that is not there", async () => {
    const f = await keyedBucket(PARA_SEEDS);
    const error = await capture(() =>
      movePath(f.store, { from: "1-projects/ghost.md", to: "1-projects/x.md", clearance: clearanceOf("private"), now: NOW }),
    );
    expect(error.code).toBe("FILE_NOT_FOUND");
  });

  /**
   * The one that would be easy to skip. Without it, dragging a private note
   * into a shared folder publishes it to everyone with team access, because
   * the note's own exception keeping it private does not follow it.
   *
   * Rows mode (production): the note row's own `access.base` is the exception,
   * and the move carries the row, so it still reads private at its new name.
   * File mode (`privacy.md` as the rules) is not asserted here; see the report.
   */
  test("a private note dragged into a shared folder stays private", async () => {
    const f = await keyedBucket(PARA_SEEDS);
    await f.t.run((ctx) => ctx.db.insert("nodeMigration", { paused: false, accessSource: "rows", updatedAt: 1 }));
    await f.t.run(async (ctx) => {
      const row = await treeNodeAt(ctx.db, f.workspaceId, "1-projects/pay.md");
      await ctx.db.patch(row!._id, { access: { base: "private" } });
    });
    await movePath(f.store, {
      from: "1-projects/pay.md",
      to: "1-projects/finance-pay.md",
      clearance: clearanceOf("private"),
      now: NOW,
    });
    expect(await rowOf2(f, "1-projects/finance-pay.md")).toEqual({
      path: "1-projects/finance-pay.md",
      access: { base: "private" },
    });
    expect(await liveAt(f, "1-projects/pay.md")).toBe(false);
  });

  test("moving a folder moves its folder default with it", async () => {
    const f = await keyedBucket(PARA_SEEDS);
    await f.store.put("work/context-lc.md", "# Context.LC\n");
    await f.store.put("work/pay.md", "# Pay\n\nsalaries\n");
    await setFolderVisibility(f.store, { path: "work", visibility: "team", clearance: clearanceOf("private") });
    await setVisibility(f.store, { path: "work/pay.md", visibility: "private", clearance: clearanceOf("private") });
    await movePath(f.store, {
      from: "work",
      to: "5-work",
      clearance: clearanceOf("private"),
      now: NOW,
    });
    const manifest = await manifestOf(f);
    expect(manifest.rules.find((rule) => rule.prefix === "5-work")?.vis).toBe("team");
    expect(manifest.overrides.get("5-work/pay.md")).toBe("private");
  });

  test("a note that is private only because of its folder does not become readable by moving it into a shared one", async () => {
    const f = await keyedBucket(PARA_SEEDS);
    await shareProjects(f.store);
    await movePath(f.store, {
      from: "2-areas/health.md",
      to: "1-projects/health.md",
      clearance: clearanceOf("private"),
      now: NOW,
    });
    const manifest = await manifestOf(f);
    expect(canSee("1-projects/health.md", "team", manifest.rules, manifest.overrides)).toBe(false);
  });

  test("a folder that is private only because its parent is keeps its subtree private when it moves into a shared folder", async () => {
    const f = await keyedBucket(PARA_SEEDS);
    await shareProjects(f.store);
    await f.store.put("2-areas/clinic/notes.md", "# Notes\n");
    await f.store.put("2-areas/clinic/deep/more.md", "# More\n");
    await movePath(f.store, {
      from: "2-areas/clinic",
      to: "1-projects/clinic",
      clearance: clearanceOf("private"),
      now: NOW,
    });
    const manifest = await manifestOf(f);
    expect(canSee("1-projects/clinic/notes.md", "team", manifest.rules, manifest.overrides)).toBe(false);
    expect(canSee("1-projects/clinic/deep/more.md", "team", manifest.rules, manifest.overrides)).toBe(false);
    // One rule, not one exception per note: the manifest a customer opens has
    // to stay readable after a folder move.
    expect(manifest.overrides.has("1-projects/clinic/notes.md")).toBe(false);
    expect(manifest.rules.find((rule) => rule.prefix === "1-projects/clinic")?.vis).toBe("private");
  });
});

describe("copying and duplicating", () => {
  test("a copy of an inherited-private note does not become readable by landing in a shared folder", async () => {
    const f = await keyedBucket(PARA_SEEDS);
    await shareProjects(f.store);
    await copyPath(f.store, {
      from: "2-areas/health.md",
      to: "1-projects/health-copy.md",
      clearance: clearanceOf("private"),
    });
    const manifest = await manifestOf(f);
    expect(canSee("1-projects/health-copy.md", "team", manifest.rules, manifest.overrides)).toBe(false);
    // The original is untouched, which is what makes this one hard to notice.
    expect(canSee("2-areas/health.md", "team", manifest.rules, manifest.overrides)).toBe(false);
  });

  test("a copied folder that was private only because its parent is carries one rule, not an exception per note", async () => {
    const f = await keyedBucket(PARA_SEEDS);
    await shareProjects(f.store);
    await f.store.put("2-areas/clinic/notes.md", "# Notes\n");
    await f.store.put("2-areas/clinic/deep/more.md", "# More\n");
    await copyPath(f.store, {
      from: "2-areas/clinic",
      to: "1-projects/clinic",
      clearance: clearanceOf("private"),
    });
    const manifest = await manifestOf(f);
    expect(canSee("1-projects/clinic/deep/more.md", "team", manifest.rules, manifest.overrides)).toBe(false);
    expect(manifest.overrides.has("1-projects/clinic/notes.md")).toBe(false);
    expect(manifest.rules.find((rule) => rule.prefix === "1-projects/clinic")?.vis).toBe("private");
  });

  test("duplicate lands beside the original under a free name", async () => {
    const f = await keyedBucket(PARA_SEEDS);
    const result = await duplicatePath(f.store, {
      path: "1-projects/context-lc.md",
      clearance: clearanceOf("private"),
    });
    expect(result.to).toBe("1-projects/context-lc copy.md");
    expect(await textAt(f, result.to)).toContain("# Context.LC");
    expect(await textAt(f, "1-projects/context-lc.md")).toContain("# Context.LC");
  });

  test("duplicating twice does not collide", async () => {
    const f = await keyedBucket(PARA_SEEDS);
    await duplicatePath(f.store, { path: "1-projects/context-lc.md", clearance: clearanceOf("private") });
    const second = await duplicatePath(f.store, {
      path: "1-projects/context-lc.md",
      clearance: clearanceOf("private"),
    });
    expect(second.to).toBe("1-projects/context-lc copy 2.md");
  });

  test("paste puts a copy at an explicit destination", async () => {
    const f = await keyedBucket(PARA_SEEDS);
    await copyPath(f.store, {
      from: "1-projects/context-lc.md",
      to: "2-areas/context-lc.md",
      clearance: clearanceOf("private"),
    });
    expect(await textAt(f, "2-areas/context-lc.md")).toContain("# Context.LC");
    expect(await textAt(f, "1-projects/context-lc.md")).toContain("# Context.LC");
  });

  test("a copy keeps the original's visibility rather than inheriting a wider one", async () => {
    const f = await keyedBucket(PARA_SEEDS);
    await shareProjects(f.store);
    await copyPath(f.store, {
      from: "1-projects/pay.md",
      to: "1-projects/pay-2027.md",
      clearance: clearanceOf("private"),
    });
    expect((await manifestOf(f)).overrides.get("1-projects/pay-2027.md")).toBe("private");
  });

  test("pasting over something is refused", async () => {
    const f = await keyedBucket(PARA_SEEDS);
    const error = await capture(() =>
      copyPath(f.store, {
        from: "1-projects/context-lc.md",
        to: "1-projects/pay.md",
        clearance: clearanceOf("private"),
      }),
    );
    expect(error.code).toBe("DESTINATION_EXISTS");
  });
});

/* -------------------------------------------------------------------------- */
/*                            archiving and deleting                          */
/* -------------------------------------------------------------------------- */

describe("archiving is the recoverable one", () => {
  test("archiving a note that is private only because of its folder does not publish it to a shared archive", async () => {
    const f = await keyedBucket(PARA_SEEDS);
    // An owner who shares their archive so the team can see what was retired.
    // Nothing about that choice should reach into a private folder.
    await setFolderVisibility(f.store, {
      path: "9-archive",
      visibility: "team",
      clearance: clearanceOf("private"),
    });
    const archived = await archivePath(f.store, {
      path: "2-areas/health.md",
      clearance: clearanceOf("private"),
      now: NOW,
    });
    const manifest = await manifestOf(f);
    expect(canSee(archived.paths[0]!, "team", manifest.rules, manifest.overrides)).toBe(false);
  });

  test("the note moves into 9-archive at its own path, beside everything archived from its folder", async () => {
    const f = await keyedBucket(PARA_SEEDS);
    const result = await archivePath(f.store, {
      path: "1-projects/context-lc.md",
      clearance: clearanceOf("private"),
      now: NOW,
    });
    expect(result.to).toBe("9-archive/1-projects/context-lc.md");
    expect(await textAt(f, result.to)).toContain("# Context.LC");
    expect(await liveAt(f, "1-projects/context-lc.md")).toBe(false);
  });

  test("and moving it back restores it exactly", async () => {
    const f = await keyedBucket(PARA_SEEDS);
    const original = await textAt(f, "1-projects/context-lc.md");
    const archived = await archivePath(f.store, {
      path: "1-projects/context-lc.md",
      clearance: clearanceOf("private"),
      now: NOW,
    });
    await movePath(f.store, {
      from: archived.to,
      to: "1-projects/context-lc.md",
      clearance: clearanceOf("private"),
      now: NOW + 1000,
    });
    expect(await textAt(f, "1-projects/context-lc.md")).toBe(original);
  });

  test("archiving twice does not collide", async () => {
    const f = await keyedBucket(PARA_SEEDS);
    const first = await archivePath(f.store, {
      path: "1-projects/context-lc.md",
      clearance: clearanceOf("private"),
      now: NOW,
    });
    await writeFile(f.store, {
      path: "1-projects/context-lc.md",
      text: "# Again\n",
      clearance: clearanceOf("private"),
      now: NOW,
    });
    const second = await archivePath(f.store, {
      path: "1-projects/context-lc.md",
      clearance: clearanceOf("private"),
      now: NOW + 60_000,
    });
    expect(second.to).not.toBe(first.to);
    // Archived twice from one folder: the second arrives numbered, never on top of the first.
    expect(second.to).toBe("9-archive/1-projects/context-lc (2).md");
    expect(await textAt(f, first.to)).toBeTruthy();
    expect(await textAt(f, second.to)).toBeTruthy();
  });

  test("archiving a folder whose name is already in the archive merges into it, a taken note numbered", async () => {
    const f = await keyedBucket(PARA_SEEDS);
    await f.store.put("1-projects/launch/notes.md", "# Newer notes\n");
    await f.store.put("1-projects/launch/plan.md", "# Plan\n");
    await f.store.put("9-archive/1-projects/launch/notes.md", "# Older notes\n");
    const result = await archivePath(f.store, { path: "1-projects/launch", clearance: clearanceOf("private"), now: NOW });
    expect(await textAt(f, "9-archive/1-projects/launch/notes.md")).toBe("# Older notes\n");
    expect(await textAt(f, "9-archive/1-projects/launch/notes (2).md")).toBe("# Newer notes\n");
    expect(await textAt(f, "9-archive/1-projects/launch/plan.md")).toBe("# Plan\n");
    expect(await liveRowsUnder(f, "1-projects/launch")).toEqual([]);
    expect(result.from).toBe("1-projects/launch");
    expect(result.to).toBe("9-archive/1-projects/launch");
  });

  test("something already in the archive is not archived again", async () => {
    const f = await keyedBucket(PARA_SEEDS);
    const error = await capture(() =>
      archivePath(f.store, { path: "9-archive/README.md", clearance: clearanceOf("private"), now: NOW }),
    );
    expect(error.code).toBe("PATH_INVALID");
  });

  /**
   * The console used to write `4-archive` whatever the layout said, so a
   * workspace built from the `company` preset — the default for a shared
   * context, whose archive is `5-archive` — got a second archive silently
   * created beside the one it already had, in a bucket its owner also sees in
   * Obsidian. Meanwhile `archive_note` refused the same workspace outright.
   * One resolver answers both now.
   */
  test("the destination is the archive this context declares, not a literal", async () => {
    const f = await keyedBucket(
      { "1-projects/pitch.md": "# Pitch\n" },
      { manifest: renderPrivacyManifestForFolders(["0-inbox", "1-projects", "5-archive"]) },
    );

    const result = await archivePath(f.store, {
      path: "1-projects/pitch.md",
      clearance: clearanceOf("private"),
      now: NOW,
    });

    expect(result.to).toBe("5-archive/1-projects/pitch.md");
    expect(
      (await liveRowsUnder(f, "4-archive")).length,
      "it invented a second archive beside the real one",
    ).toBe(0);
  });

  /**
   * And on a layout with no archive at all it now refuses, which is what the
   * gateway has always done. Creating the folder was the disagreement: two
   * surfaces, one bucket, opposite answers to "does this context archive".
   */
  test("a layout with no archive is told so rather than given one", async () => {
    const f = await keyedBucket(
      { "Journal/day.md": "# A day\n" },
      { manifest: renderPrivacyManifestForFolders(["Journal", "Clients"]) },
    );

    const error = await capture(() =>
      archivePath(f.store, { path: "Journal/day.md", clearance: clearanceOf("private"), now: NOW }),
    );

    expect(error.code).toBe("ARCHIVE_UNAVAILABLE");
    expect(await textAt(f, "Journal/day.md")).toBeTruthy();
    expect((await liveRowsUnder(f, "9-archive")).length).toBe(0);
  });
});

describe("trash is hidden and reversible", () => {
  test("a team editor can trash and restore a shared note without changing privacy", async () => {
    const f = await keyedBucket(PARA_SEEDS);
    await shareProjects(f.store);
    const rulesBefore = await rowRulesOf(f);

    const trashed = await trashPath(f.store, {
      path: "1-projects/context-lc.md",
      clearance: clearanceOf("team"),
      now: NOW,
    });
    expect(trashed.to).toMatch(/^\.context\/trash\/[\dTZ-]+\/1-projects\/context-lc\.md$/);
    expect(await textAt(f, trashed.to)).toContain("# Context.LC");
    expect(await liveAt(f, "1-projects/context-lc.md")).toBe(false);
    expect(await rowRulesOf(f)).toEqual(rulesBefore);
    expect(isPlumbing(trashed.to)).toBe(true);

    await restoreTrashedPath(f.store, {
      from: trashed.to,
      to: "1-projects/context-lc.md",
      clearance: clearanceOf("team"),
    });
    expect(await textAt(f, "1-projects/context-lc.md")).toContain("# Context.LC");
    expect(await liveAt(f, trashed.to)).toBe(false);
    expect(await rowRulesOf(f)).toEqual(rulesBefore);
  });

  test("restore cannot redirect a trash entry to a different path", async () => {
    const f = await keyedBucket(PARA_SEEDS);
    const trashed = await trashPath(f.store, {
      path: "1-projects/context-lc.md",
      clearance: clearanceOf("private"),
      now: NOW,
    });
    const error = await capture(() =>
      restoreTrashedPath(f.store, {
        from: trashed.to,
        to: "2-areas/context-lc.md",
        clearance: clearanceOf("private"),
      }),
    );
    expect(error.code).toBe("PATH_INVALID");
  });

  test("trash and restore preserve attachment bytes", async () => {
    const f = await keyedBucket(PARA_SEEDS);
    const bytes = new Uint8Array([0, 255, 17, 128, 3]);
    await f.store.put("1-projects/image.png", bytes);
    const trashed = await trashPath(f.store, {
      path: "1-projects/image.png",
      clearance: clearanceOf("private"),
      now: NOW,
    });
    expect(await bytesAt(f, trashed.to)).toEqual(bytes);

    await restoreTrashedPath(f.store, {
      from: trashed.to,
      to: "1-projects/image.png",
      clearance: clearanceOf("private"),
    });
    expect(await bytesAt(f, "1-projects/image.png")).toEqual(bytes);
  });
});
