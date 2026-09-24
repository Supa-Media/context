import { describe, expect, test } from "vitest";
import { clearanceOf } from "../../functions/lib/clearance";
import {
  type FileStore,
  archivePath,
  copyPath,
  createFolder,
  duplicateName,
  duplicatePath,
  listFolder,
  movePath,
  readFile,
  renderFolderPlaceholder,
  restoreTrashedPath,
  setFolderVisibility,
  setVisibility,
  trashPath,
  writeFile,
} from "../../functions/lib/fileOps";
import {
  PRIVACY_KEY,
  canSee,
  isPlumbing,
  parsePrivacyManifest,
} from "../../functions/lib/privacy";
import { renderPrivacyManifestForFolders } from "../../functions/lib/scaffold";
import {
  type MemoryStore,
  memoryStore,
} from "../storeStub.helpers";
import {
  NOW,
  bucket,
  shareProjects,
  capture,
  errorShape,
  names,
} from "./fixtures.helpers";

/* -------------------------------------------------------------------------- */
/*                          creating, copying, moving                         */
/* -------------------------------------------------------------------------- */

describe("creating a folder", () => {
  test("writes a README so the folder is real for every other tool", async () => {
    const store = bucket();
    const created = await createFolder(store, {
      path: "1-projects/new-thing",
      clearance: clearanceOf("private"),
      now: NOW,
    });
    expect(created.readme).toBe("1-projects/new-thing/README.md");
    const listing = await listFolder(store, { path: "1-projects", clearance: clearanceOf("private") });
    expect(names(listing.entries)).toContain("new-thing");
  });

  /**
   * What is in it, and why it is not `# new-thing`.
   *
   * That was the old body: the opening line of a note somebody had started, on a
   * file nobody wrote, at the top of every folder they made. The console hides
   * it now (`isFolderPlaceholder`), so the only readers left are Obsidian and
   * whatever else opens the bucket — and to them an empty overview page reads
   * like a task. It says what it is instead.
   *
   * SABOTAGE: putting the heading back fails this; dropping the folder's name
   * from the sentence fails the second assertion and leaves a reader in Obsidian
   * with no way to tell which prefix the file is holding open.
   */
  test("the README says it is a placeholder rather than starting a note nobody wrote", async () => {
    const store = bucket();
    const created = await createFolder(store, {
      path: "1-projects/new-thing",
      clearance: clearanceOf("private"),
      now: NOW,
    });
    const body = store.snapshot()[created.readme];
    expect(body).toContain("Folder placeholder.");
    // It names the prefix it is holding open, so a reader in Obsidian knows
    // which folder they are looking at the mechanics of.
    expect(body).toContain("1-projects/new-thing/");
    // No heading: a `#` line is what made it look like an unfinished note.
    expect(body.startsWith("#")).toBe(false);
    expect(renderFolderPlaceholder("1-projects/new-thing")).toBe(body);
  });

  test("creating one twice is refused rather than silently reused", async () => {
    const store = bucket();
    await createFolder(store, { path: "1-projects/new-thing", clearance: clearanceOf("private"), now: NOW });
    const error = await capture(() =>
      createFolder(store, { path: "1-projects/new-thing", clearance: clearanceOf("private"), now: NOW }),
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
    const store = bucket();
    await shareProjects(store);
    store.seed("2-areas/finance/README.md", "# Finance\n");

    // The premise: at team scope `2-areas` is not in the tree at all.
    const root = await listFolder(store, { path: "", clearance: clearanceOf("team") });
    expect(names(root.entries)).not.toContain("2-areas");

    const hit = await capture(() =>
      createFolder(store, { path: "2-areas/finance", clearance: clearanceOf("team"), now: NOW }),
    );
    const miss = await capture(() =>
      createFolder(store, { path: "2-areas/never-existed", clearance: clearanceOf("team"), now: NOW }),
    );
    expect(errorShape(hit)).toBe(errorShape(miss));
    expect(hit.code).toBe("FILE_NOT_FOUND");

    // ...and the refusal is not a blanket one. A guard that refused every
    // team-scope creation would satisfy the two assertions above while
    // breaking the operation for every editor who is allowed to use it.
    const allowed = await createFolder(store, {
      path: "1-projects/new-thing",
      clearance: clearanceOf("team"),
      now: NOW,
    });
    expect(allowed.readme).toBe("1-projects/new-thing/README.md");
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
  test("a collaborative private note is narrowed before destination bytes appear", async () => {
    const store = bucket({ conditional: true });
    await shareProjects(store);
    const originalPut = store.put.bind(store);
    let visibilityWhileLanding: string | null = null;
    store.put = async (key, value, options) => {
      const written = await originalPut(key, value, options);
      if (key === "1-projects/health.md" && written !== null) {
        const observed = await capture(() =>
          readFile(store, {
            path: "1-projects/health.md",
            clearance: clearanceOf("team"),
          }),
        );
        visibilityWhileLanding = observed.code;
      }
      return written;
    };

    await movePath(store, {
      from: "2-areas/health.md",
      to: "1-projects/health.md",
      clearance: clearanceOf("private"),
      now: NOW,
    });

    expect(visibilityWhileLanding).toBe("FILE_NOT_FOUND");
  });

  test("a collaborative move returns the etag after rewriting its own links", async () => {
    const store = bucket({ conditional: true });
    store.seed("1-projects/old.md", "# Old\n\n[[old]]\n");
    const moved = await movePath(store, {
      from: "1-projects/old.md",
      to: "1-projects/nested/new.md",
      clearance: clearanceOf("private"),
      now: NOW,
    });
    const current = await readFile(store, {
      path: "1-projects/nested/new.md",
      clearance: clearanceOf("private"),
    });

    expect(moved.etag).toBe(current.etag);
  });

  test("a rename is a move whose parent does not change", async () => {
    const store = bucket();
    await movePath(store, {
      from: "1-projects/context-lc.md",
      to: "1-projects/context.md",
      clearance: clearanceOf("private"),
      now: NOW,
    });
    const snapshot = store.snapshot();
    expect(snapshot["1-projects/context.md"]).toContain("# Context.LC");
    expect(snapshot["1-projects/context-lc.md"]).toBeUndefined();
  });

  test("a whole folder moves, keeping its shape", async () => {
    const store = bucket();
    await movePath(store, {
      from: "1-projects",
      to: "2-areas/projects",
      clearance: clearanceOf("private"),
      now: NOW,
    });
    const snapshot = store.snapshot();
    expect(snapshot["2-areas/projects/context-lc.md"]).toContain("# Context.LC");
    expect(snapshot["2-areas/projects/pay.md"]).toContain("salaries");
    expect(snapshot["1-projects/pay.md"]).toBeUndefined();
  });

  test("an existing destination is refused rather than merged over", async () => {
    const store = bucket();
    const error = await capture(() =>
      movePath(store, {
        from: "1-projects/context-lc.md",
        to: "1-projects/pay.md",
        clearance: clearanceOf("private"),
        now: NOW,
      }),
    );
    expect(error.code).toBe("DESTINATION_EXISTS");
    expect(store.snapshot()["1-projects/pay.md"]).toContain("salaries");
  });

  test("a refused collaborative collision cannot loosen the destination ACL", async () => {
    const store = bucket({ conditional: true });
    await shareProjects(store);
    const before = await capture(() =>
      readFile(store, {
        path: "1-projects/pay.md",
        clearance: clearanceOf("team"),
      }),
    );
    expect(before.code).toBe("FILE_NOT_FOUND");

    const refusal = await capture(() =>
      movePath(store, {
        from: "1-projects/context-lc.md",
        to: "1-projects/pay.md",
        clearance: clearanceOf("private"),
        now: NOW,
      }),
    );
    const after = await capture(() =>
      readFile(store, {
        path: "1-projects/pay.md",
        clearance: clearanceOf("team"),
      }),
    );

    expect(refusal.code).toBe("DESTINATION_EXISTS");
    expect(after.code).toBe("FILE_NOT_FOUND");
  });

  test("a folder cannot be moved inside itself", async () => {
    const store = bucket();
    const error = await capture(() =>
      movePath(store, {
        from: "1-projects",
        to: "1-projects/inner",
        clearance: clearanceOf("private"),
        now: NOW,
      }),
    );
    expect(error.code).toBe("PATH_INVALID");
  });

  test("moving something that is not there fails like anything else that is not there", async () => {
    const store = bucket();
    const error = await capture(() =>
      movePath(store, { from: "1-projects/ghost.md", to: "1-projects/x.md", clearance: clearanceOf("private"), now: NOW }),
    );
    expect(error.code).toBe("FILE_NOT_FOUND");
  });

  /**
   * The one that would be easy to skip. Without it, dragging a private note
   * into a shared folder publishes it to everyone with team access, because
   * the exception keeping it private still names a path that no longer exists.
   */
  test("a private note dragged into a shared folder stays private", async () => {
    const store = bucket();
    await shareProjects(store);
    // `2-areas` is private, `1-projects` is team. Give the note an exception
    // that survives the move: mark it team inside private 2-areas…
    await setVisibility(store, {
      path: "2-areas/health.md",
      visibility: "team",
      clearance: clearanceOf("private"),
    });
    await movePath(store, {
      from: "1-projects/pay.md",
      to: "1-projects/finance-pay.md",
      clearance: clearanceOf("private"),
      now: NOW,
    });
    const manifest = parsePrivacyManifest(store.snapshot()[PRIVACY_KEY]);
    expect(manifest.overrides.get("1-projects/finance-pay.md")).toBe("private");
    expect(manifest.overrides.has("1-projects/pay.md")).toBe(false);
  });

  test("moving a folder moves its folder default with it", async () => {
    const store = bucket();
    await shareProjects(store);
    await movePath(store, {
      from: "1-projects",
      to: "5-work",
      clearance: clearanceOf("private"),
      now: NOW,
    });
    const manifest = parsePrivacyManifest(store.snapshot()[PRIVACY_KEY]);
    expect(manifest.rules.find((rule) => rule.prefix === "5-work")?.vis).toBe("team");
    expect(manifest.overrides.get("5-work/pay.md")).toBe("private");
  });

  test("a note that is private only because of its folder does not become readable by moving it into a shared one", async () => {
    const store = bucket();
    await shareProjects(store);
    await movePath(store, {
      from: "2-areas/health.md",
      to: "1-projects/health.md",
      clearance: clearanceOf("private"),
      now: NOW,
    });
    const manifest = parsePrivacyManifest(store.snapshot()[PRIVACY_KEY]);
    expect(canSee("1-projects/health.md", "team", manifest.rules, manifest.overrides)).toBe(false);
  });

  test("a folder that is private only because its parent is keeps its subtree private when it moves into a shared folder", async () => {
    const store = bucket();
    await shareProjects(store);
    store.seed("2-areas/clinic/notes.md", "# Notes\n");
    store.seed("2-areas/clinic/deep/more.md", "# More\n");
    await movePath(store, {
      from: "2-areas/clinic",
      to: "1-projects/clinic",
      clearance: clearanceOf("private"),
      now: NOW,
    });
    const manifest = parsePrivacyManifest(store.snapshot()[PRIVACY_KEY]);
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
    const store = bucket();
    await shareProjects(store);
    await copyPath(store, {
      from: "2-areas/health.md",
      to: "1-projects/health-copy.md",
      clearance: clearanceOf("private"),
    });
    const manifest = parsePrivacyManifest(store.snapshot()[PRIVACY_KEY]);
    expect(canSee("1-projects/health-copy.md", "team", manifest.rules, manifest.overrides)).toBe(false);
    // The original is untouched, which is what makes this one hard to notice.
    expect(canSee("2-areas/health.md", "team", manifest.rules, manifest.overrides)).toBe(false);
  });

  test("a copied folder that was private only because its parent is carries one rule, not an exception per note", async () => {
    const store = bucket();
    await shareProjects(store);
    store.seed("2-areas/clinic/notes.md", "# Notes\n");
    store.seed("2-areas/clinic/deep/more.md", "# More\n");
    await copyPath(store, {
      from: "2-areas/clinic",
      to: "1-projects/clinic",
      clearance: clearanceOf("private"),
    });
    const manifest = parsePrivacyManifest(store.snapshot()[PRIVACY_KEY]);
    expect(canSee("1-projects/clinic/deep/more.md", "team", manifest.rules, manifest.overrides)).toBe(false);
    expect(manifest.overrides.has("1-projects/clinic/notes.md")).toBe(false);
    expect(manifest.rules.find((rule) => rule.prefix === "1-projects/clinic")?.vis).toBe("private");
  });

  test("duplicate lands beside the original under a free name", async () => {
    const store = bucket();
    const result = await duplicatePath(store, {
      path: "1-projects/context-lc.md",
      clearance: clearanceOf("private"),
    });
    expect(result.to).toBe("1-projects/context-lc copy.md");
    expect(store.snapshot()[result.to]).toContain("# Context.LC");
    expect(store.snapshot()["1-projects/context-lc.md"]).toContain("# Context.LC");
  });

  test("duplicating twice does not collide", async () => {
    const store = bucket();
    await duplicatePath(store, { path: "1-projects/context-lc.md", clearance: clearanceOf("private") });
    const second = await duplicatePath(store, {
      path: "1-projects/context-lc.md",
      clearance: clearanceOf("private"),
    });
    expect(second.to).toBe("1-projects/context-lc copy 2.md");
  });

  test("paste puts a copy at an explicit destination", async () => {
    const store = bucket();
    await copyPath(store, {
      from: "1-projects/context-lc.md",
      to: "2-areas/context-lc.md",
      clearance: clearanceOf("private"),
    });
    expect(store.snapshot()["2-areas/context-lc.md"]).toContain("# Context.LC");
    expect(store.snapshot()["1-projects/context-lc.md"]).toContain("# Context.LC");
  });

  test("a copy keeps the original's visibility rather than inheriting a wider one", async () => {
    const store = bucket();
    await shareProjects(store);
    await copyPath(store, {
      from: "1-projects/pay.md",
      to: "1-projects/pay-2027.md",
      clearance: clearanceOf("private"),
    });
    const manifest = parsePrivacyManifest(store.snapshot()[PRIVACY_KEY]);
    expect(manifest.overrides.get("1-projects/pay-2027.md")).toBe("private");
  });

  test("pasting over something is refused", async () => {
    const store = bucket();
    const error = await capture(() =>
      copyPath(store, {
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
    const store = bucket();
    // An owner who shares their archive so the team can see what was retired.
    // Nothing about that choice should reach into a private folder.
    await setFolderVisibility(store, {
      path: "4-archive",
      visibility: "team",
      clearance: clearanceOf("private"),
    });
    const archived = await archivePath(store, {
      path: "2-areas/health.md",
      clearance: clearanceOf("private"),
      now: NOW,
    });
    const manifest = parsePrivacyManifest(store.snapshot()[PRIVACY_KEY]);
    expect(canSee(archived.paths[0]!, "team", manifest.rules, manifest.overrides)).toBe(false);
  });

  test("the note moves into 4-archive with its original path preserved", async () => {
    const store = bucket();
    const result = await archivePath(store, {
      path: "1-projects/context-lc.md",
      clearance: clearanceOf("private"),
      now: NOW,
    });
    expect(result.to).toMatch(/^4-archive\/[\dTZ-]+\/1-projects\/context-lc\.md$/);
    expect(store.snapshot()[result.to]).toContain("# Context.LC");
    expect(store.snapshot()["1-projects/context-lc.md"]).toBeUndefined();
  });

  test("and moving it back restores it exactly", async () => {
    const store = bucket();
    const original = store.snapshot()["1-projects/context-lc.md"];
    const archived = await archivePath(store, {
      path: "1-projects/context-lc.md",
      clearance: clearanceOf("private"),
      now: NOW,
    });
    await movePath(store, {
      from: archived.to,
      to: "1-projects/context-lc.md",
      clearance: clearanceOf("private"),
      now: NOW + 1000,
    });
    expect(store.snapshot()["1-projects/context-lc.md"]).toBe(original);
  });

  test("archiving twice does not collide", async () => {
    const store = bucket();
    const first = await archivePath(store, {
      path: "1-projects/context-lc.md",
      clearance: clearanceOf("private"),
      now: NOW,
    });
    await writeFile(store, {
      path: "1-projects/context-lc.md",
      text: "# Again\n",
      clearance: clearanceOf("private"),
      now: NOW,
    });
    const second = await archivePath(store, {
      path: "1-projects/context-lc.md",
      clearance: clearanceOf("private"),
      now: NOW + 60_000,
    });
    expect(second.to).not.toBe(first.to);
    expect(store.snapshot()[first.to]).toBeTruthy();
    expect(store.snapshot()[second.to]).toBeTruthy();
  });

  test("something already in the archive is not archived again", async () => {
    const store = bucket();
    const error = await capture(() =>
      archivePath(store, { path: "4-archive/README.md", clearance: clearanceOf("private"), now: NOW }),
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
    const store = memoryStore() as MemoryStore & FileStore;
    store.seed(
      PRIVACY_KEY,
      renderPrivacyManifestForFolders(["0-inbox", "1-projects", "5-archive"]),
    );
    store.seed("1-projects/pitch.md", "# Pitch\n");

    const result = await archivePath(store, {
      path: "1-projects/pitch.md",
      clearance: clearanceOf("private"),
      now: NOW,
    });

    expect(result.to).toMatch(/^5-archive\/[\dTZ-]+\/1-projects\/pitch\.md$/);
    expect(
      Object.keys(store.snapshot()).some((key) => key.startsWith("4-archive/")),
      "it invented a second archive beside the real one",
    ).toBe(false);
  });

  /**
   * And on a layout with no archive at all it now refuses, which is what the
   * gateway has always done. Creating the folder was the disagreement: two
   * surfaces, one bucket, opposite answers to "does this context archive".
   */
  test("a layout with no archive is told so rather than given one", async () => {
    const store = memoryStore() as MemoryStore & FileStore;
    store.seed(PRIVACY_KEY, renderPrivacyManifestForFolders(["Journal", "Clients"]));
    store.seed("Journal/day.md", "# A day\n");

    const error = await capture(() =>
      archivePath(store, { path: "Journal/day.md", clearance: clearanceOf("private"), now: NOW }),
    );

    expect(error.code).toBe("ARCHIVE_UNAVAILABLE");
    expect(store.snapshot()["Journal/day.md"]).toBeTruthy();
    expect(Object.keys(store.snapshot()).some((key) => key.includes("archive/"))).toBe(false);
  });
});

describe("trash is hidden and reversible", () => {
  test("a team editor can trash and restore a shared note without changing privacy", async () => {
    const store = bucket();
    await shareProjects(store);
    const privacy = store.snapshot()[PRIVACY_KEY];

    const trashed = await trashPath(store, {
      path: "1-projects/context-lc.md",
      clearance: clearanceOf("team"),
      now: NOW,
    });
    expect(trashed.to).toMatch(/^\.context\/trash\/[\dTZ-]+\/1-projects\/context-lc\.md$/);
    expect(store.snapshot()[trashed.to]).toContain("# Context.LC");
    expect(store.snapshot()["1-projects/context-lc.md"]).toBeUndefined();
    expect(store.snapshot()[PRIVACY_KEY]).toBe(privacy);
    expect(isPlumbing(trashed.to)).toBe(true);

    await restoreTrashedPath(store, {
      from: trashed.to,
      to: "1-projects/context-lc.md",
      clearance: clearanceOf("team"),
    });
    expect(store.snapshot()["1-projects/context-lc.md"]).toContain("# Context.LC");
    expect(store.snapshot()[trashed.to]).toBeUndefined();
    expect(store.snapshot()[PRIVACY_KEY]).toBe(privacy);
  });

  test("restore cannot redirect a trash entry to a different path", async () => {
    const store = bucket();
    const trashed = await trashPath(store, {
      path: "1-projects/context-lc.md",
      clearance: clearanceOf("private"),
      now: NOW,
    });
    const error = await capture(() =>
      restoreTrashedPath(store, {
        from: trashed.to,
        to: "2-areas/context-lc.md",
        clearance: clearanceOf("private"),
      }),
    );
    expect(error.code).toBe("PATH_INVALID");
  });

  test("trash and restore preserve attachment bytes", async () => {
    const store = bucket();
    const bytes = new Uint8Array([0, 255, 17, 128, 3]);
    store.seed("1-projects/image.png", bytes);
    const trashed = await trashPath(store, {
      path: "1-projects/image.png",
      clearance: clearanceOf("private"),
      now: NOW,
    });
    expect(store.bytesOf(trashed.to)).toEqual(bytes);

    await restoreTrashedPath(store, {
      from: trashed.to,
      to: "1-projects/image.png",
      clearance: clearanceOf("private"),
    });
    expect(store.bytesOf("1-projects/image.png")).toEqual(bytes);
  });
});

