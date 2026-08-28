/**
 * THE FILE EDITOR'S OPERATIONS.
 *
 * Every one of them, against an in-memory bucket, including the failure paths.
 * `lib/fileOps.ts` takes a `ContextStore` and nothing else, which is what lets
 * these run with no credential, no workspace and no session — and what keeps
 * the one function that *does* hold a credential
 * (`functions/files.runFileOperation`) small enough to audit by reading it.
 *
 * The assertions that matter most, and why:
 *
 *  - **A stale etag is a conflict, never an overwrite.** Two people editing the
 *    same note is not exotic; it is the normal case for a context that is also
 *    open in Obsidian and being written by an AI client. A last-writer-wins
 *    save loses work silently.
 *  - **A `team` caller cannot read, list, or infer a `private` note.** The
 *    error for "not yours" is compared byte-for-byte with the error for "never
 *    existed", in the style of `isolation.test.ts`. "Both fail" is not enough.
 *  - **Archive is recoverable and delete is not.** Both are asserted as
 *    behaviour, because "permanently delete" quietly keeping a copy would be a
 *    lie told by the one product whose whole claim is that you know where your
 *    data is.
 */

import { describe, expect, test } from "vitest";
import { gatewayInternals } from "./gatewayFormat.helpers";
import { memoryStore, type MemoryStore } from "./storeStub.helpers";
import {
  DELETE_CONFIRMATION,
  FileOpError,
  type FileStore,
  archivePath,
  copyPath,
  createFolder,
  deletePath,
  duplicateName,
  duplicatePath,
  listFolder,
  movePath,
  readFile,
  resetPrivacyManifest,
  setFolderVisibility,
  setVisibility,
  writeFile,
} from "../functions/lib/fileOps";
import { PRIVACY_KEY, parsePrivacyManifest } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";

const NOW = 1_800_000_000_000;

/**
 * A bucket that looks like a real one: the PARA scaffold's own `privacy.md`,
 * a shared folder, a private folder, and one exception in each direction.
 */
function bucket(options: { ignoreIfMatch?: boolean } = {}): MemoryStore & FileStore {
  const store = memoryStore(options) as MemoryStore & FileStore;
  store.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  store.seed("index.md", "# Context\n");
  store.seed("0-inbox/README.md", "# Inbox\n");
  store.seed("1-projects/README.md", "# Projects\n");
  store.seed("1-projects/context-lc.md", "# Context.LC\n\nnotes\n");
  store.seed("1-projects/pay.md", "# Pay\n\nsalaries\n");
  store.seed("2-areas/README.md", "# Areas\n");
  store.seed("2-areas/health.md", "# Health\n");
  store.seed("4-archive/README.md", "# Archive\n");
  store.seed(".history/1-projects/context-lc.md.old.md", "# older\n");
  // Every note in a real bucket has been edited at least once, and every one of
  // those edits left the version it replaced in `.history/`. A fixture without
  // these describes a bucket nobody has — and let the delete tests below pass
  // by having nothing to find, which is exactly how the copy on the console's
  // delete dialog came to be false.
  store.seed(".history/1-projects/pay.md.2026-07-01T09-00-00-000Z.md", "# Pay\n\nsalaries\n");
  store.seed(
    ".history/1-projects/pay.md.2026-07-02T09-00-00-000Z.move.md",
    "# Pay\n\nsalaries\n",
  );
  store.seed(".history/2-areas/health.md.2026-07-01T09-00-00-000Z.md", "# Health\n\nolder\n");
  return store;
}

/** Every `.history/` key still in the bucket. */
function historyKeys(store: MemoryStore): string[] {
  return Object.keys(store.snapshot()).filter((key) => key.startsWith(".history/"));
}

/** Make `1-projects` team-visible, with one note held back as an exception. */
async function shareProjects(store: FileStore): Promise<void> {
  await setFolderVisibility(store, {
    path: "1-projects",
    visibility: "team",
    scope: "private",
  });
  await setVisibility(store, {
    path: "1-projects/pay.md",
    visibility: "private",
    scope: "private",
  });
}

async function capture(fn: () => Promise<unknown>): Promise<FileOpError> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof FileOpError) return error;
    throw error;
  }
  throw new Error("Expected the operation to throw, but it resolved.");
}

/** Serialize a failure so two of them can be compared exactly. */
function errorShape(error: FileOpError): string {
  return JSON.stringify({
    code: error.code,
    message: error.message,
    currentEtag: error.currentEtag ?? null,
  });
}

function names(entries: { name: string }[]): string[] {
  return entries.map((entry) => entry.name);
}

/* -------------------------------------------------------------------------- */
/*                                  listing                                   */
/* -------------------------------------------------------------------------- */

describe("listing a folder", () => {
  test("folders come first, then files, each alphabetically", async () => {
    const store = bucket();
    const listing = await listFolder(store, { path: "", scope: "private" });
    expect(names(listing.entries)).toEqual([
      "0-inbox",
      "1-projects",
      "2-areas",
      "4-archive",
      "index.md",
      "privacy.md",
    ]);
  });

  test("plumbing is never listed, at any scope", async () => {
    const store = bucket();
    const listing = await listFolder(store, { path: "", scope: "private" });
    expect(names(listing.entries)).not.toContain(".history");
  });

  test("a folder reports its own default, so the row can show it", async () => {
    const store = bucket();
    await shareProjects(store);
    expect((await listFolder(store, { path: "1-projects", scope: "private" })).folderDefault).toBe(
      "team",
    );
    expect((await listFolder(store, { path: "2-areas", scope: "private" })).folderDefault).toBe(
      "private",
    );
  });

  /**
   * The UI rule, as data: a file is marked **only** when it differs from its
   * folder. Marking every note in a private folder "private" is noise that
   * hides the one note that is not.
   */
  test("only the exceptions are flagged", async () => {
    const store = bucket();
    await shareProjects(store);
    const listing = await listFolder(store, { path: "1-projects", scope: "private" });
    const flagged = listing.entries.filter((entry) => entry.exception);
    expect(names(flagged)).toEqual(["pay.md"]);
    expect(flagged[0].visibility).toBe("private");
    expect(flagged[0].inherited).toBe("team");

    const ordinary = listing.entries.find((entry) => entry.name === "context-lc.md")!;
    expect(ordinary.exception).toBe(false);
    expect(ordinary.visibility).toBe("team");
  });

  test("privacy.md is listed for its owner, and marked read-only", async () => {
    const store = bucket();
    const listing = await listFolder(store, { path: "", scope: "private" });
    const manifest = listing.entries.find((entry) => entry.name === PRIVACY_KEY)!;
    expect(manifest.readOnly).toBe(true);
  });

  test("a manifest the gateway cannot parse is reported, not guessed at", async () => {
    const store = bucket();
    store.seed(PRIVACY_KEY, "# no managed block here\n");
    const listing = await listFolder(store, { path: "", scope: "private" });
    expect(listing.manifestUsable).toBe(false);
    // …and everything falls back to private, which is the safe direction.
    const team = await listFolder(store, { path: "", scope: "team" });
    expect(team.entries).toEqual([]);
  });
});

describe("a team-scoped caller sees only what is shared", () => {
  test("a private folder is not listed", async () => {
    const store = bucket();
    await shareProjects(store);
    const listing = await listFolder(store, { path: "", scope: "team" });
    expect(names(listing.entries)).toEqual(["1-projects"]);
  });

  test("privacy.md is never listed for a team caller — it names every private folder", async () => {
    const store = bucket();
    await shareProjects(store);
    const listing = await listFolder(store, { path: "", scope: "team" });
    expect(names(listing.entries)).not.toContain(PRIVACY_KEY);
  });

  test("a private exception inside a shared folder is not listed", async () => {
    const store = bucket();
    await shareProjects(store);
    const listing = await listFolder(store, { path: "1-projects", scope: "team" });
    // Case-insensitive alphabetical, the order Obsidian shows.
    expect(names(listing.entries)).toEqual(["context-lc.md", "README.md"]);
  });

  /**
   * The inverse, and the reason folder visibility is computed from the
   * exception map rather than from the folder rule alone: a shared note inside
   * a private folder must still be reachable, or the exception is unusable.
   */
  test("a shared note inside a private folder keeps its folder reachable", async () => {
    const store = bucket();
    await setVisibility(store, {
      path: "2-areas/health.md",
      visibility: "team",
      scope: "private",
    });
    const root = await listFolder(store, { path: "", scope: "team" });
    expect(names(root.entries)).toContain("2-areas");
    const inside = await listFolder(store, { path: "2-areas", scope: "team" });
    expect(names(inside.entries)).toEqual(["health.md"]);
  });

  test("listing a private folder fails exactly as listing a folder that never existed", async () => {
    const store = bucket();
    await shareProjects(store);
    const hidden = await capture(() => listFolder(store, { path: "2-areas", scope: "team" }));
    const absent = await capture(() =>
      listFolder(store, { path: "9-imaginary", scope: "team" }),
    );
    expect(errorShape(hidden)).toBe(errorShape(absent));
  });
});

/* -------------------------------------------------------------------------- */
/*                                  reading                                   */
/* -------------------------------------------------------------------------- */

describe("reading a note", () => {
  test("returns the markdown and an etag to save against", async () => {
    const store = bucket();
    const file = await readFile(store, { path: "1-projects/context-lc.md", scope: "private" });
    expect(file.text).toContain("# Context.LC");
    expect(file.etag).toBeTruthy();
    expect(file.readOnly).toBe(false);
  });

  test("privacy.md reads back, marked read-only", async () => {
    const store = bucket();
    const file = await readFile(store, { path: PRIVACY_KEY, scope: "private" });
    expect(file.readOnly).toBe(true);
    expect(file.text).toContain("BEGIN BRAIN PRIVACY RULES");
  });

  test("a team caller reading a private note gets the same error as for a missing one", async () => {
    const store = bucket();
    await shareProjects(store);
    const hidden = await capture(() =>
      readFile(store, { path: "1-projects/pay.md", scope: "team" }),
    );
    const absent = await capture(() =>
      readFile(store, { path: "1-projects/never-existed.md", scope: "team" }),
    );
    expect(errorShape(hidden)).toBe(errorShape(absent));
    expect(hidden.code).toBe("FILE_NOT_FOUND");
  });

  test("a team caller cannot read privacy.md", async () => {
    const store = bucket();
    await shareProjects(store);
    const error = await capture(() => readFile(store, { path: PRIVACY_KEY, scope: "team" }));
    expect(error.code).toBe("FILE_NOT_FOUND");
  });

  test("a traversal path is refused rather than resolved", async () => {
    const store = bucket();
    const error = await capture(() =>
      readFile(store, { path: "1-projects/../privacy.md", scope: "team" }),
    );
    expect(error.code).toBe("PATH_INVALID");
  });
});

/* -------------------------------------------------------------------------- */
/*                            writing and conflicts                           */
/* -------------------------------------------------------------------------- */

describe("saving a note", () => {
  test("creates a new one when no etag is supplied", async () => {
    const store = bucket();
    const written = await writeFile(store, {
      path: "1-projects/new.md",
      text: "# New\n",
      scope: "private",
      now: NOW,
    });
    expect(written.path).toBe("1-projects/new.md");
    expect(store.snapshot()["1-projects/new.md"]).toBe("# New\n");
  });

  test("updates an existing one when the etag matches", async () => {
    const store = bucket();
    const read = await readFile(store, { path: "1-projects/context-lc.md", scope: "private" });
    const written = await writeFile(store, {
      path: read.path,
      text: "# Edited\n",
      expectedEtag: read.etag,
      scope: "private",
      now: NOW,
    });
    expect(written.etag).not.toBe(read.etag);
    expect(store.snapshot()["1-projects/context-lc.md"]).toBe("# Edited\n");
  });

  test("the replaced version is kept under .history/", async () => {
    const store = bucket();
    const read = await readFile(store, { path: "1-projects/context-lc.md", scope: "private" });
    await writeFile(store, {
      path: read.path,
      text: "# Edited\n",
      expectedEtag: read.etag,
      scope: "private",
      now: NOW,
    });
    const history = Object.keys(store.snapshot()).filter(
      (key) => key.startsWith(".history/1-projects/context-lc.md.") && key.endsWith(".md"),
    );
    expect(history.length).toBeGreaterThan(1);
  });

  /* ------------------------------ conflicts ------------------------------- */

  test("a stale etag is a conflict, and the file is untouched", async () => {
    const store = bucket();
    const first = await readFile(store, { path: "1-projects/context-lc.md", scope: "private" });

    // Somebody else — Obsidian, an AI client — saves first.
    await writeFile(store, {
      path: first.path,
      text: "# Theirs\n",
      expectedEtag: first.etag,
      scope: "private",
      now: NOW,
    });

    const error = await capture(() =>
      writeFile(store, {
        path: first.path,
        text: "# Mine\n",
        expectedEtag: first.etag,
        scope: "private",
        now: NOW,
      }),
    );
    expect(error.code).toBe("CONFLICT");
    expect(error.message).toMatch(/changed somewhere else/);
    expect(store.snapshot()["1-projects/context-lc.md"]).toBe("# Theirs\n");
  });

  test("the conflict carries the current etag, so the console can offer to reload", async () => {
    const store = bucket();
    const first = await readFile(store, { path: "1-projects/context-lc.md", scope: "private" });
    await writeFile(store, {
      path: first.path,
      text: "# Theirs\n",
      expectedEtag: first.etag,
      scope: "private",
      now: NOW,
    });
    const error = await capture(() =>
      writeFile(store, {
        path: first.path,
        text: "# Mine\n",
        expectedEtag: first.etag,
        scope: "private",
        now: NOW,
      }),
    );
    const current = await readFile(store, { path: first.path, scope: "private" });
    expect(error.currentEtag).toBe(current.etag);
  });

  /**
   * The case a backend that ignores `If-Match` would otherwise turn into a
   * silent overwrite. B2 and Wasabi do exactly that, which is why
   * `probeStore` refuses to take the capability on faith and why the write
   * path falls back to a read-compare instead of dropping the check.
   */
  test("a backend that ignores If-Match still reports the conflict, and says how it checked", async () => {
    const store = bucket({ ignoreIfMatch: true });
    const first = await readFile(store, { path: "1-projects/context-lc.md", scope: "private" });
    const theirs = await writeFile(store, {
      path: first.path,
      text: "# Theirs\n",
      expectedEtag: first.etag,
      scope: "private",
      now: NOW,
    });
    expect(theirs.conflictCheck).toBe("read-compare");

    const error = await capture(() =>
      writeFile(store, {
        path: first.path,
        text: "# Mine\n",
        expectedEtag: first.etag,
        scope: "private",
        now: NOW,
      }),
    );
    expect(error.code).toBe("CONFLICT");
    expect(store.snapshot()["1-projects/context-lc.md"]).toBe("# Theirs\n");
  });

  test("a conditional backend says so, so the console does not have to guess", async () => {
    const store = bucket();
    const read = await readFile(store, { path: "1-projects/context-lc.md", scope: "private" });
    const written = await writeFile(store, {
      path: read.path,
      text: "# Edited\n",
      expectedEtag: read.etag,
      scope: "private",
      now: NOW,
    });
    expect(written.conflictCheck).toBe("conditional");
  });

  test("creating over something that already exists is a conflict, not an overwrite", async () => {
    const store = bucket();
    const error = await capture(() =>
      writeFile(store, {
        path: "1-projects/context-lc.md",
        text: "# Clobbered\n",
        scope: "private",
        now: NOW,
      }),
    );
    expect(error.code).toBe("CONFLICT");
    expect(store.snapshot()["1-projects/context-lc.md"]).toContain("# Context.LC");
  });

  test("saving a note somebody else deleted is a conflict, not a resurrection", async () => {
    const store = bucket();
    const read = await readFile(store, { path: "1-projects/context-lc.md", scope: "private" });
    await store.delete(read.path);
    const error = await capture(() =>
      writeFile(store, {
        path: read.path,
        text: "# Mine\n",
        expectedEtag: read.etag,
        scope: "private",
        now: NOW,
      }),
    );
    expect(error.code).toBe("CONFLICT");
    expect(error.message).toMatch(/deleted somewhere else/);
  });

  /* ------------------------------- refusals ------------------------------- */

  test("privacy.md cannot be written directly", async () => {
    const store = bucket();
    const before = store.snapshot()[PRIVACY_KEY];
    const error = await capture(() =>
      writeFile(store, {
        path: PRIVACY_KEY,
        text: "everything: team\n",
        scope: "private",
        now: NOW,
      }),
    );
    expect(error.code).toBe("PRIVACY_MANIFEST_READ_ONLY");
    expect(error.message).toMatch(/generated from your visibility settings/);
    expect(store.snapshot()[PRIVACY_KEY]).toBe(before);
  });

  test("plumbing paths cannot be written", async () => {
    const store = bucket();
    const error = await capture(() =>
      writeFile(store, {
        path: ".history/forged.md",
        text: "x",
        scope: "private",
        now: NOW,
      }),
    );
    expect(error.code).toBe("PATH_INVALID");
  });

  test("an oversized note is refused, and the message does not quote it", async () => {
    const store = bucket();
    const huge = "x".repeat(2_000_001);
    const error = await capture(() =>
      writeFile(store, { path: "1-projects/huge.md", text: huge, scope: "private", now: NOW }),
    );
    expect(error.code).toBe("CONTENT_TOO_LARGE");
    expect(error.message).not.toContain("xxx");
  });

  test("a team caller cannot create a note in a folder they cannot see", async () => {
    const store = bucket();
    await shareProjects(store);
    const error = await capture(() =>
      writeFile(store, {
        path: "2-areas/sneaky.md",
        text: "# Sneaky\n",
        scope: "team",
        now: NOW,
      }),
    );
    expect(error.code).toBe("FILE_NOT_FOUND");
    expect(store.snapshot()["2-areas/sneaky.md"]).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/*                          creating, copying, moving                         */
/* -------------------------------------------------------------------------- */

describe("creating a folder", () => {
  test("writes a README so the folder is real for every other tool", async () => {
    const store = bucket();
    const created = await createFolder(store, {
      path: "1-projects/new-thing",
      scope: "private",
      now: NOW,
    });
    expect(created.readme).toBe("1-projects/new-thing/README.md");
    expect(store.snapshot()[created.readme]).toContain("# new-thing");
    const listing = await listFolder(store, { path: "1-projects", scope: "private" });
    expect(names(listing.entries)).toContain("new-thing");
  });

  test("creating one twice is refused rather than silently reused", async () => {
    const store = bucket();
    await createFolder(store, { path: "1-projects/new-thing", scope: "private", now: NOW });
    const error = await capture(() =>
      createFolder(store, { path: "1-projects/new-thing", scope: "private", now: NOW }),
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
    const root = await listFolder(store, { path: "", scope: "team" });
    expect(names(root.entries)).not.toContain("2-areas");

    const hit = await capture(() =>
      createFolder(store, { path: "2-areas/finance", scope: "team", now: NOW }),
    );
    const miss = await capture(() =>
      createFolder(store, { path: "2-areas/never-existed", scope: "team", now: NOW }),
    );
    expect(errorShape(hit)).toBe(errorShape(miss));
    expect(hit.code).toBe("FILE_NOT_FOUND");

    // ...and the refusal is not a blanket one. A guard that refused every
    // team-scope creation would satisfy the two assertions above while
    // breaking the operation for every editor who is allowed to use it.
    const allowed = await createFolder(store, {
      path: "1-projects/new-thing",
      scope: "team",
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
  test("a rename is a move whose parent does not change", async () => {
    const store = bucket();
    await movePath(store, {
      from: "1-projects/context-lc.md",
      to: "1-projects/context.md",
      scope: "private",
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
      scope: "private",
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
        scope: "private",
        now: NOW,
      }),
    );
    expect(error.code).toBe("DESTINATION_EXISTS");
    expect(store.snapshot()["1-projects/pay.md"]).toContain("salaries");
  });

  test("a folder cannot be moved inside itself", async () => {
    const store = bucket();
    const error = await capture(() =>
      movePath(store, {
        from: "1-projects",
        to: "1-projects/inner",
        scope: "private",
        now: NOW,
      }),
    );
    expect(error.code).toBe("PATH_INVALID");
  });

  test("moving something that is not there fails like anything else that is not there", async () => {
    const store = bucket();
    const error = await capture(() =>
      movePath(store, { from: "1-projects/ghost.md", to: "1-projects/x.md", scope: "private", now: NOW }),
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
      scope: "private",
    });
    await movePath(store, {
      from: "1-projects/pay.md",
      to: "1-projects/finance-pay.md",
      scope: "private",
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
      scope: "private",
      now: NOW,
    });
    const manifest = parsePrivacyManifest(store.snapshot()[PRIVACY_KEY]);
    expect(manifest.rules.find((rule) => rule.prefix === "5-work")?.vis).toBe("team");
    expect(manifest.overrides.get("5-work/pay.md")).toBe("private");
  });
});

describe("copying and duplicating", () => {
  test("duplicate lands beside the original under a free name", async () => {
    const store = bucket();
    const result = await duplicatePath(store, {
      path: "1-projects/context-lc.md",
      scope: "private",
    });
    expect(result.to).toBe("1-projects/context-lc copy.md");
    expect(store.snapshot()[result.to]).toContain("# Context.LC");
    expect(store.snapshot()["1-projects/context-lc.md"]).toContain("# Context.LC");
  });

  test("duplicating twice does not collide", async () => {
    const store = bucket();
    await duplicatePath(store, { path: "1-projects/context-lc.md", scope: "private" });
    const second = await duplicatePath(store, {
      path: "1-projects/context-lc.md",
      scope: "private",
    });
    expect(second.to).toBe("1-projects/context-lc copy 2.md");
  });

  test("paste puts a copy at an explicit destination", async () => {
    const store = bucket();
    await copyPath(store, {
      from: "1-projects/context-lc.md",
      to: "2-areas/context-lc.md",
      scope: "private",
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
      scope: "private",
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
        scope: "private",
      }),
    );
    expect(error.code).toBe("DESTINATION_EXISTS");
  });
});

/* -------------------------------------------------------------------------- */
/*                            archiving and deleting                          */
/* -------------------------------------------------------------------------- */

describe("archiving is the recoverable one", () => {
  test("the note moves into 4-archive with its original path preserved", async () => {
    const store = bucket();
    const result = await archivePath(store, {
      path: "1-projects/context-lc.md",
      scope: "private",
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
      scope: "private",
      now: NOW,
    });
    await movePath(store, {
      from: archived.to,
      to: "1-projects/context-lc.md",
      scope: "private",
      now: NOW + 1000,
    });
    expect(store.snapshot()["1-projects/context-lc.md"]).toBe(original);
  });

  test("archiving twice does not collide", async () => {
    const store = bucket();
    const first = await archivePath(store, {
      path: "1-projects/context-lc.md",
      scope: "private",
      now: NOW,
    });
    await writeFile(store, {
      path: "1-projects/context-lc.md",
      text: "# Again\n",
      scope: "private",
      now: NOW,
    });
    const second = await archivePath(store, {
      path: "1-projects/context-lc.md",
      scope: "private",
      now: NOW + 60_000,
    });
    expect(second.to).not.toBe(first.to);
    expect(store.snapshot()[first.to]).toBeTruthy();
    expect(store.snapshot()[second.to]).toBeTruthy();
  });

  test("something already in the archive is not archived again", async () => {
    const store = bucket();
    const error = await capture(() =>
      archivePath(store, { path: "4-archive/README.md", scope: "private", now: NOW }),
    );
    expect(error.code).toBe("PATH_INVALID");
  });
});

describe("deleting is the permanent one", () => {
  test("without the confirmation, nothing happens", async () => {
    const store = bucket();
    const error = await capture(() =>
      deletePath(store, {
        path: "1-projects/context-lc.md",
        confirmation: "yes",
        scope: "private",
      }),
    );
    expect(error.code).toBe("CONFIRMATION_REQUIRED");
    expect(error.message).toMatch(/cannot be undone/);
    expect(store.snapshot()["1-projects/context-lc.md"]).toContain("# Context.LC");
  });

  test("an empty confirmation is not a confirmation", async () => {
    const store = bucket();
    const error = await capture(() =>
      deletePath(store, { path: "1-projects/context-lc.md", confirmation: "", scope: "private" }),
    );
    expect(error.code).toBe("CONFIRMATION_REQUIRED");
  });

  test("with the confirmation, the file is gone", async () => {
    const store = bucket();
    await deletePath(store, {
      path: "1-projects/context-lc.md",
      confirmation: DELETE_CONFIRMATION,
      scope: "private",
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
      scope: "private",
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
      scope: "private",
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
        scope: "private",
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
        scope: "private",
      });
      expect(
        Object.entries(store.snapshot()).filter(([, body]) => body.includes("salaries")),
      ).toEqual([]);
    });

    /**
     * The version an *edit* left behind, not one a fixture planted. This is the
     * path a real person takes: write a note, change it, delete it.
     */
    test("a note written, edited, then deleted leaves nothing of either version", async () => {
      const store = bucket();
      const first = await writeFile(store, {
        path: "1-projects/secret.md",
        text: "# Secret\n\nthe first draft\n",
        scope: "private",
        now: NOW,
      });
      await writeFile(store, {
        path: "1-projects/secret.md",
        text: "# Secret\n\nthe second draft\n",
        expectedEtag: first.etag,
        scope: "private",
        now: NOW + 60_000,
      });
      // The bug, stated: the edit really did stash the first draft.
      expect(
        historyKeys(store).some((key) => store.snapshot()[key].includes("the first draft")),
      ).toBe(true);

      await deletePath(store, {
        path: "1-projects/secret.md",
        confirmation: DELETE_CONFIRMATION,
        scope: "private",
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
        scope: "private",
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
        scope: "private",
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
      await archivePath(store, { path: "2-areas/health.md", scope: "private", now: NOW });
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
          scope: "private",
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
          scope: "team",
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
      scope: "private",
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
        scope: "team",
      }),
    );
    expect(error.code).toBe("FILE_NOT_FOUND");
    expect(store.snapshot()["1-projects/pay.md"]).toContain("salaries");
  });
});

/* -------------------------------------------------------------------------- */
/*                                 visibility                                 */
/* -------------------------------------------------------------------------- */

describe("changing visibility goes through the manifest", () => {
  const gateway = gatewayInternals();

  test("the manifest it writes is one the gateway itself accepts", async () => {
    const store = bucket();
    await shareProjects(store);
    const parsed = gateway.parsePrivacyManifest(store.snapshot()[PRIVACY_KEY]);
    expect(parsed.rules.find((rule) => rule.prefix === "1-projects")?.vis).toBe("team");
    expect(parsed.overrides.get("1-projects/pay.md")).toBe("private");
  });

  test("and the gateway then hides the note from a team client", async () => {
    const store = bucket();
    await shareProjects(store);
    const parsed = gateway.parsePrivacyManifest(store.snapshot()[PRIVACY_KEY]);
    expect(
      gateway.canSee("1-projects/pay.md", "team", parsed.rules, parsed.overrides),
    ).toBe(false);
    expect(
      gateway.canSee("1-projects/context-lc.md", "team", parsed.rules, parsed.overrides),
    ).toBe(true);
  });

  test("setting a note back to its folder default removes the exception", async () => {
    const store = bucket();
    await shareProjects(store);
    const result = await setVisibility(store, {
      path: "1-projects/pay.md",
      visibility: "team",
      scope: "private",
    });
    expect(result.exception).toBe(false);
    const parsed = parsePrivacyManifest(store.snapshot()[PRIVACY_KEY]);
    expect(parsed.overrides.has("1-projects/pay.md")).toBe(false);
  });

  test("a redundant exception is never written in the first place", async () => {
    const store = bucket();
    await setVisibility(store, {
      path: "2-areas/health.md",
      visibility: "private",
      scope: "private",
    });
    const parsed = parsePrivacyManifest(store.snapshot()[PRIVACY_KEY]);
    expect(parsed.overrides.size).toBe(0);
  });

  test("the prose around the managed block is preserved", async () => {
    const store = bucket();
    await shareProjects(store);
    const text = store.snapshot()[PRIVACY_KEY];
    expect(text).toContain("# Access map");
    expect(text).toContain("role: privacy-manifest");
  });

  test("only markdown notes get their own visibility", async () => {
    const store = bucket();
    const error = await capture(() =>
      setVisibility(store, { path: "1-projects", visibility: "team", scope: "private" }),
    );
    expect(error.code).toBe("PATH_INVALID");
    expect(error.message).toMatch(/folder's default/);
  });

  test("privacy.md cannot be given a visibility of its own", async () => {
    const store = bucket();
    const error = await capture(() =>
      setVisibility(store, { path: PRIVACY_KEY, visibility: "team", scope: "private" }),
    );
    expect(error.code).toBe("PRIVACY_MANIFEST_READ_ONLY");
  });

  test("a bucket with no manifest says so instead of inventing one", async () => {
    const store = memoryStore() as MemoryStore & FileStore;
    store.seed("1-projects/a.md", "# A\n");
    const error = await capture(() =>
      setVisibility(store, { path: "1-projects/a.md", visibility: "team", scope: "private" }),
    );
    expect(error.code).toBe("PRIVACY_MANIFEST_MISSING");
  });

  test("a manifest that does not parse is refused rather than overwritten", async () => {
    const store = bucket();
    store.seed(PRIVACY_KEY, "# somebody broke the block\n");
    const error = await capture(() =>
      setVisibility(store, {
        path: "1-projects/context-lc.md",
        visibility: "team",
        scope: "private",
      }),
    );
    expect(error.code).toBe("PRIVACY_MANIFEST_INVALID");
    expect(store.snapshot()[PRIVACY_KEY]).toBe("# somebody broke the block\n");
  });

  test("a folder default is visible on the folder, and every unexceptional note follows it", async () => {
    const store = bucket();
    await setFolderVisibility(store, {
      path: "2-areas",
      visibility: "team",
      scope: "private",
    });
    const listing = await listFolder(store, { path: "2-areas", scope: "private" });
    expect(listing.folderDefault).toBe("team");
    expect(listing.entries.every((entry) => entry.exception === false)).toBe(true);
    expect(names(await listFolder(store, { path: "2-areas", scope: "team" }).then((l) => l.entries))).toContain(
      "health.md",
    );
  });

  /**
   * The manifest is the one file the console, the gateway and Obsidian all
   * rewrite. A lost update here is not a lost paragraph — it is a note that was
   * meant to be private and is not.
   */
  test("a manifest changed underneath us is retried, not clobbered", async () => {
    const store = bucket();
    let interfered = false;
    const realGet = store.get.bind(store);
    store.get = async (key: string) => {
      const object = await realGet(key);
      if (key === PRIVACY_KEY && !interfered) {
        interfered = true;
        // Somebody else lands a change between our read and our write.
        await setFolderVisibility(store, {
          path: "3-resources",
          visibility: "team",
          scope: "private",
        });
      }
      return object;
    };

    await setFolderVisibility(store, {
      path: "1-projects",
      visibility: "team",
      scope: "private",
    });

    const parsed = parsePrivacyManifest(store.snapshot()[PRIVACY_KEY]);
    expect(parsed.rules.find((rule) => rule.prefix === "1-projects")?.vis).toBe("team");
    // The interfering change survived too — that is what "retried" means.
    expect(parsed.rules.find((rule) => rule.prefix === "3-resources")?.vis).toBe("team");
  });
});

/**
 * REPAIRING A BROKEN privacy.md.
 *
 * The tests above establish that a manifest which does not parse fails closed
 * and that every write to it is refused — which, before `resetPrivacyManifest`,
 * meant a bucket in that state had no way out through this product at all. The
 * gateway is no help either: `write_note` answers "that path is reserved" for
 * `privacy.md`, and `set_folder_visibility` answers "privacy.md is required
 * before folder visibility can be changed". So the console told people to do
 * something neither of its two write paths permits.
 *
 * What follows is the repair, and the four properties that keep it from being
 * a way to flatten somebody's access map: it refuses a manifest that parses, it
 * writes every folder private, it needs owner clearance, and it keeps the file
 * it replaced.
 */
describe("resetting a privacy.md that cannot be read", () => {
  /** A bucket whose manifest is unparseable — the state the console warns on. */
  function brokenBucket(): MemoryStore & FileStore {
    const store = bucket();
    store.seed(PRIVACY_KEY, "folder_defaults:\n  1-projects: team\n");
    return store;
  }

  test("the state it repairs is exactly the state the console warns about", async () => {
    const store = brokenBucket();
    expect((await listFolder(store, { path: "", scope: "private" })).manifestUsable).toBe(false);

    await resetPrivacyManifest(store, { scope: "private", now: NOW });

    expect((await listFolder(store, { path: "", scope: "private" })).manifestUsable).toBe(true);
  });

  test("what it writes parses, and the gateway agrees that it does", async () => {
    const store = brokenBucket();
    await resetPrivacyManifest(store, { scope: "private", now: NOW });

    const text = store.snapshot()[PRIVACY_KEY];
    // Ours, and then the gateway's own parser out of its source — the same
    // differential check `scaffold.test.ts` makes, because a manifest only this
    // repo can read is not a repair.
    expect(() => parsePrivacyManifest(text)).not.toThrow();
    expect(() => gatewayInternals().parsePrivacyManifest(text)).not.toThrow();
  });

  test("it declares the folders the bucket actually has, not the five PARA ones", async () => {
    const store = memoryStore() as MemoryStore & FileStore;
    store.seed(PRIVACY_KEY, "# broken\n");
    store.seed("Journal/2026-01-01.md", "# a day\n");
    store.seed("Clients/acme.md", "# Acme\n");
    store.seed("inbox.md", "# loose at the root\n");

    const result = await resetPrivacyManifest(store, { scope: "private", now: NOW });

    expect(result.folders).toEqual(["Clients", "Journal"]);
    const parsed = parsePrivacyManifest(store.snapshot()[PRIVACY_KEY]);
    expect(parsed.rules.map((rule) => rule.prefix).sort()).toEqual(["Clients", "Journal"]);
    // A person who wants to share `Journal` now has a line to change. Handing
    // them `0-inbox … 4-archive` would have given them five lines for folders
    // they do not have and none for the two they do.
  });

  test("nothing becomes visible: every folder is written private", async () => {
    const store = brokenBucket();
    // The broken file *says* `1-projects: team`. Reading it as anything but a
    // failure is the bug this whole path exists to avoid, so the repair must
    // not resurrect that line either.
    await resetPrivacyManifest(store, { scope: "private", now: NOW });

    const parsed = parsePrivacyManifest(store.snapshot()[PRIVACY_KEY]);
    expect(parsed.rules.every((rule) => rule.vis === "private")).toBe(true);
    expect(parsed.overrides.size).toBe(0);
    // The observable consequence, which is the assertion that matters: a
    // team-scoped caller could see nothing before the repair and can see
    // nothing after it.
    expect((await listFolder(store, { path: "", scope: "team" })).entries).toEqual([]);
  });

  test("plumbing folders never reach the manifest, which would make it unparseable", async () => {
    const store = brokenBucket();
    store.seed(".obsidian/workspace.json", "{}\n");

    const result = await resetPrivacyManifest(store, { scope: "private", now: NOW });

    expect(result.folders).not.toContain(".history");
    expect(result.folders).not.toContain(".obsidian");
    // Belt and braces: the parser rejects a dot-segment rule outright, so a
    // leak here would produce a manifest that does not parse — a repair that
    // leaves the bucket exactly as broken as it found it.
    expect(() => parsePrivacyManifest(store.snapshot()[PRIVACY_KEY])).not.toThrow();
  });

  test("a folder whose name cannot be a rule is dropped, not written into the file", async () => {
    // Bucket keys are far more permissive than a manifest line. A colon breaks
    // `parsePrivacyManifest`'s rule pattern outright, so one such folder would
    // make the repair write a file that does not parse — leaving the bucket
    // exactly as broken as it found it, with the person's one exit spent.
    const store = memoryStore() as MemoryStore & FileStore;
    store.seed(PRIVACY_KEY, "# broken\n");
    store.seed("2026: notes/a.md", "# a\n");
    // The second name is here to keep the guard honest about *how* it decides.
    // A colon blacklist would pass every other assertion in this file, and it
    // would let this one through: `  2026#notes: private` loses everything
    // after the `#` to the parser's comment stripper, leaving `2026` with no
    // colon on it, which the parser rejects outright. Only asking the real
    // parser catches both.
    store.seed("2026#notes/a.md", "# a\n");
    store.seed("1-projects/a.md", "# a\n");

    const result = await resetPrivacyManifest(store, { scope: "private", now: NOW });

    expect(result.folders).toEqual(["1-projects"]);
    expect(result.partial).toBe(true);
    expect(() => parsePrivacyManifest(store.snapshot()[PRIVACY_KEY])).not.toThrow();
  });

  test("a folder name cannot inject rules into the manifest", async () => {
    // A newline is a legal S3 key character and nothing between the bucket and
    // this function has to have come through our own path validation — Obsidian
    // sync, rclone, and the provider's console all write keys directly. A name
    // carrying its own line break would otherwise append whatever it liked to
    // `folder_defaults`, and the useful thing to append is `: team`.
    const store = memoryStore() as MemoryStore & FileStore;
    store.seed(PRIVACY_KEY, "# broken\n");
    store.seed("innocent\n  2-areas: team\n#/a.md", "# a\n");
    store.seed("2-areas/secret.md", "# secret\n");

    await resetPrivacyManifest(store, { scope: "private", now: NOW });

    const parsed = parsePrivacyManifest(store.snapshot()[PRIVACY_KEY]);
    // Not "the file contains no `team`" — the manifest's own prose explains
    // what `team` means, and asserting on the whole text would pass or fail on
    // the wording rather than on the rules.
    expect(parsed.rules.every((rule) => rule.vis === "private")).toBe(true);
    // `2-areas` is a real folder here and rightly gets a line; what the
    // injection was for is that the line say `team`. It says `private`.
    expect(parsed.rules.find((rule) => rule.prefix === "2-areas")?.vis).toBe("private");
    expect(parsed.overrides.size).toBe(0);
    // The observable consequence: the note the injected rule was reaching for
    // is still invisible to a team-scoped caller.
    expect((await listFolder(store, { path: "", scope: "team" })).entries).toEqual([]);
  });

  test("a complete walk of ordinary folders is not reported as partial", async () => {
    const store = brokenBucket();
    const result = await resetPrivacyManifest(store, { scope: "private", now: NOW });
    expect(result.partial).toBe(false);
  });

  test("the unreadable file is kept, so a typo does not cost forty rules", async () => {
    const store = brokenBucket();
    const original = store.snapshot()[PRIVACY_KEY];

    const result = await resetPrivacyManifest(store, { scope: "private", now: NOW });

    expect(result.backedUpTo).not.toBeNull();
    expect(result.backedUpTo!.startsWith(".history/")).toBe(true);
    expect(store.snapshot()[result.backedUpTo!]).toBe(original);
  });

  test("a bucket with no manifest at all is repaired, and has nothing to keep", async () => {
    const store = memoryStore() as MemoryStore & FileStore;
    store.seed("1-projects/a.md", "# A\n");

    const result = await resetPrivacyManifest(store, { scope: "private", now: NOW });

    expect(result.backedUpTo).toBeNull();
    expect(historyKeys(store)).toEqual([]);
    // And the thing that was impossible a moment ago now works.
    await setFolderVisibility(store, { path: "1-projects", visibility: "team", scope: "private" });
    expect(parsePrivacyManifest(store.snapshot()[PRIVACY_KEY]).rules).toContainEqual({
      prefix: "1-projects",
      vis: "team",
    });
  });

  test("a manifest that parses is refused — this is not a way to flatten one", async () => {
    const store = bucket();
    await shareProjects(store);
    const before = store.snapshot()[PRIVACY_KEY];

    const error = await capture(() => resetPrivacyManifest(store, { scope: "private", now: NOW }));

    expect(error.code).toBe("PRIVACY_MANIFEST_USABLE");
    expect(store.snapshot()[PRIVACY_KEY]).toBe(before);
    expect(historyKeys(store).some((key) => key.includes(PRIVACY_KEY))).toBe(false);
  });

  test("a team-scoped caller cannot rewrite the access map that governs them", async () => {
    const store = brokenBucket();
    const before = store.snapshot()[PRIVACY_KEY];

    const error = await capture(() => resetPrivacyManifest(store, { scope: "team", now: NOW }));

    expect(error.code).toBe("PRIVACY_MANIFEST_READ_ONLY");
    expect(store.snapshot()[PRIVACY_KEY]).toBe(before);
  });

  test("a repair that lands between our read and our write loses, rather than clobbering", async () => {
    const store = brokenBucket();
    const realGet = store.get.bind(store);
    let interfered = false;
    store.get = async (key: string) => {
      const object = await realGet(key);
      if (key === PRIVACY_KEY && !interfered) {
        interfered = true;
        // Somebody fixed it by hand in Obsidian while we were deciding to.
        store.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
      }
      return object;
    };

    const error = await capture(() => resetPrivacyManifest(store, { scope: "private", now: NOW }));

    expect(error.code).toBe("CONFLICT");
    expect(store.snapshot()[PRIVACY_KEY]).toBe(renderPrivacyManifest("para"));
  });
});
