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
  type FolderListing,
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

/**
 * A listing's answer, minus the path the caller supplied.
 *
 * `path` echoes the request, so it is the one field that may differ between a
 * withheld folder and an absent one without disclosing which is which. Every
 * other field has to match, and that is what these comparisons assert.
 */
function listingShape(listing: FolderListing): string {
  const { path: _echoed, ...rest } = listing;
  return JSON.stringify(rest);
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
    const hidden = await listFolder(store, { path: "2-areas", scope: "team" });
    const absent = await listFolder(store, { path: "9-imaginary", scope: "team" });
    expect(listingShape(hidden)).toBe(listingShape(absent));
  });

  /**
   * The same claim one level in, where it stops being true.
   *
   * The test above compares two folders at the ROOT, and the root default is
   * private — so a folder that never existed is not visible either, and both
   * legs refuse for the same reason. The axis it holds constant is the parent's
   * visibility, and that is the axis the collapse actually turns on.
   *
   * Inside a **team-visible** parent, a name that does not exist inherits
   * `team`, is visible, and returns an empty listing; a name that exists and is
   * private refuses. A member who guesses a folder name learns which one it is
   * — and `privacy.md` is withheld from team scope precisely so that "handing
   * it to a team-scoped caller would enumerate every private folder by name"
   * cannot happen. This is that, one guess at a time.
   *
   * `readFile` already collapses these two (a note it cannot see and a note
   * that is not there both throw); only the folder walk diverged.
   */
  /**
   * A private folder that CONTAINS something shared is still listable, and that
   * is what `folderVisibleAtScope` is for rather than `canSee`.
   *
   * `canSee` asks whether the folder's own default admits the caller; this asks
   * whether anything beneath it does. Swapping one for the other survived all
   * 1,383 checks and would re-break what that function's own comment records
   * having already been broken once: an owner who shared `2-areas/shared` out
   * of a private `2-areas` got a folder reachable only by somebody who already
   * knew its name.
   *
   * It matters more since the withheld branch stopped throwing: the failure is
   * now an empty listing rather than an error, which is the quieter of the two.
   */
  test("a private folder holding a shared one is still listable at team scope", async () => {
    const store = bucket();
    store.seed("2-areas/shared/a.md", "# A\n");
    await setFolderVisibility(store, {
      path: "2-areas/shared",
      visibility: "team",
      scope: "private",
    });

    const listing = await listFolder(store, { path: "2-areas", scope: "team" });
    expect(names(listing.entries)).toEqual(["shared"]);
    expect(names((await listFolder(store, { path: "2-areas/shared", scope: "team" })).entries)).toEqual([
      "a.md",
    ]);
  });

  test("and the same holds inside a folder the caller CAN see", async () => {
    const store = bucket();
    await shareProjects(store);
    store.seed("1-projects/secret-client/brief.md", "# Brief\n");
    await setFolderVisibility(store, {
      path: "1-projects/secret-client",
      visibility: "private",
      scope: "private",
    });

    const hidden = await listFolder(store, {
      path: "1-projects/secret-client",
      scope: "team",
    });
    const absent = await listFolder(store, {
      path: "1-projects/no-such-thing",
      scope: "team",
    });
    expect(listingShape(hidden)).toBe(listingShape(absent));
    // And the owner still sees it, so the collapse is about scope and not
    // about the folder having stopped existing.
    expect(
      names((await listFolder(store, { path: "1-projects/secret-client", scope: "private" })).entries),
    ).toEqual(["brief.md"]);

    // The two do the same WORK, not just give the same answer.
    //
    // The first version of this fix skipped the walk for a withheld folder —
    // `canSee` filters every entry out anyway, so the answer cannot differ.
    // Measured, that was backwards: the absent folder still walks, because it
    // has to discover there is nothing, so skipping made the withheld case do
    // strictly less work than the one it must be indistinguishable from. 0
    // listings against 1. Collapsing the result while forking the clock is the
    // same oracle one layer down, so this counts rather than argues.
    let lists = 0;
    const counted: FileStore = {
      ...store,
      list: (options) => {
        lists += 1;
        return store.list(options);
      },
    };
    await listFolder(counted, { path: "1-projects/secret-client", scope: "team" });
    const withheldLists = lists;
    lists = 0;
    await listFolder(counted, { path: "1-projects/no-such-thing", scope: "team" });
    expect(withheldLists).toBe(lists);
    expect(lists).toBeGreaterThan(0);
  });

  /**
   * The same claim one level DEEPER, where the first fix stopped being true.
   *
   * `folderDefault` was reported from `parentOf(folder)` when withheld. At
   * depth one that is right — an absent sibling inherits from the same parent,
   * so both legs print the same word. One level down the parent IS the private
   * folder, so the branch written to withhold a rule printed exactly that rule:
   *
   *     1-projects/secret-client/anything -> folderDefault "private"
   *     1-projects/never-existed/anything -> folderDefault "team"
   *
   * and the guessed segment need not exist, so it is one request per name. The
   * enumeration the withheld branch exists to close, one level down.
   *
   * What holds instead is the nearest ancestor VISIBLE AT THIS SCOPE. Every
   * ancestor that survives that walk is one the caller can already list, so it
   * publishes nothing they could not read off their own tree, and it equals
   * what an absent path inherits at every depth including the root.
   */
  test("and one level deeper, where the parent is the thing being withheld", async () => {
    const store = bucket();
    await shareProjects(store);
    store.seed("1-projects/secret-client/brief.md", "# Brief\n");
    await setFolderVisibility(store, {
      path: "1-projects/secret-client",
      visibility: "private",
      scope: "private",
    });

    const hidden = await listFolder(store, {
      path: "1-projects/secret-client/anything",
      scope: "team",
    });
    const absent = await listFolder(store, {
      path: "1-projects/never-existed/anything",
      scope: "team",
    });
    expect(listingShape(hidden)).toBe(listingShape(absent));
  });

  /**
   * ...and it stays equal against a store that reports truncation wrongly.
   *
   * `listFolder`'s own walk comment is written about a store that sets
   * `IsTruncated` with no `NextContinuationToken` — it names B2, Wasabi, MinIO
   * and "anything a self-hosted gateway points at", so this is a supported
   * self-hosting path rather than a corner. Against one of those the walk's
   * no-cursor branch sets `truncated` on page zero for any NON-EMPTY prefix and
   * never for an empty one, which is a boolean in the body saying whether the
   * private folder is there.
   *
   * The explicit `truncated: withheld ? false` on the return is what closes it,
   * and against a CONFORMING store the one-page walk masks that conditional
   * completely — removing it fails nothing in the rest of this file. Two
   * mechanisms that mask each other need a fixture that separates them, or the
   * survivor gets deleted as redundant by the next person to read it.
   */
  test("and against a store that reports truncation without a cursor", async () => {
    const store = bucket();
    await shareProjects(store);
    store.seed("1-projects/secret-client/brief.md", "# Brief\n");
    await setFolderVisibility(store, {
      path: "1-projects/secret-client",
      visibility: "private",
      scope: "private",
    });

    // Truncation claimed, continuation withheld — the shape the walk's own
    // comment is about. Nothing here is malicious; it is a store being loose
    // with a flag, which is the customer's provider and not our choice.
    const nonconforming: FileStore = {
      ...store,
      list: async (options) => {
        const page = await store.list(options);
        const objects = page.objects ?? [];
        const prefixes = page.delimitedPrefixes ?? [];
        return objects.length + prefixes.length > 0
          ? { ...page, truncated: true, cursor: undefined }
          : page;
      },
    };

    const hidden = await listFolder(nonconforming, {
      path: "1-projects/secret-client",
      scope: "team",
    });
    const absent = await listFolder(nonconforming, {
      path: "1-projects/no-such-thing",
      scope: "team",
    });
    expect(listingShape(hidden)).toBe(listingShape(absent));
  });

  /**
   * ...and the work stays equal for a folder too big for one page.
   *
   * The call-count assertion above uses a one-object folder, which is the only
   * size at which walking a withheld folder to the end costs what an absent one
   * costs. `limit` is a hint — Dropbox documents it as approximate and the
   * store is the customer's — so a page of ten turns a sixty-object private
   * folder into six round trips against the absent folder's one, and past
   * `LIST_PAGE_CAP` pages the body diverges too: `truncated: true` against
   * `false`. Both the clock and a boolean then scale with the size of the thing
   * being hidden, which is a coarser oracle than the name it was hiding.
   *
   * So a withheld folder does exactly one listing — what an absent one does —
   * and reports the empty shape.
   */
  test("and the work stays equal when the hidden folder needs more than one page", async () => {
    const store = bucket();
    await shareProjects(store);
    for (let i = 0; i < 60; i += 1) {
      store.seed(`1-projects/secret-client/n${String(i).padStart(2, "0")}.md`, "# N\n");
    }
    await setFolderVisibility(store, {
      path: "1-projects/secret-client",
      visibility: "private",
      scope: "private",
    });

    let lists = 0;
    const paged: FileStore = {
      ...store,
      list: async (options) => {
        lists += 1;
        const page = await store.list({ ...options, limit: 10 });
        const objects = (page.objects ?? []).slice(0, 10);
        const more = (page.objects ?? []).length > 10;
        return more
          ? { ...page, objects, truncated: true, cursor: objects[objects.length - 1]?.key }
          : page;
      },
    };

    const hidden = await listFolder(paged, {
      path: "1-projects/secret-client",
      scope: "team",
    });
    const withheldLists = lists;
    lists = 0;
    const absent = await listFolder(paged, {
      path: "1-projects/no-such-thing",
      scope: "team",
    });
    expect(listingShape(hidden)).toBe(listingShape(absent));
    expect(withheldLists).toBe(lists);
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
        scope: "team",
      }),
    );
    const free = await capture(() =>
      copyPath(store, {
        from: "1-projects/context-lc.md",
        to: "2-areas/finance/never-existed.md",
        scope: "team",
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
        scope: "team",
        now: NOW,
      }),
    );
    const free = await capture(() =>
      movePath(store, {
        from: "1-projects/context-lc.md",
        to: "2-areas/finance/never-existed.md",
        scope: "team",
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
        scope: "team",
        now: NOW,
      }),
    );
    expect(error.code).toBe("FILE_NOT_FOUND");
    expect(store.snapshot()["2-areas/finance/taken.md"]).toBeUndefined();
    // ...and the note is still where the rest of the team can see it.
    const listing = await listFolder(store, { path: "1-projects", scope: "team" });
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
      scope: "team",
      now: NOW,
    });
    expect(moved.paths).toEqual(["1-projects/renamed.md"]);
    const copied = await copyPath(store, {
      from: "1-projects/renamed.md",
      to: "1-projects/duplicate.md",
      scope: "team",
    });
    expect(copied.paths).toEqual(["1-projects/duplicate.md"]);
  });

  test("the owner is not affected — private scope sees everything", async () => {
    const store = await withHiddenNote();
    const moved = await movePath(store, {
      from: "1-projects/context-lc.md",
      to: "2-areas/finance/filed.md",
      scope: "private",
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
      archivePath(store, { path: "1-projects/context-lc.md", scope: "team", now: NOW }),
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
      scope: "private",
      now: NOW,
    });
    expect(owner.paths[0]).toContain("4-archive/");

    await setFolderVisibility(store, {
      path: "4-archive",
      visibility: "team",
      scope: "private",
    });
    const allowed = await archivePath(store, {
      path: "1-projects/context-lc.md",
      scope: "team",
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
        scope: "team",
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
      scope: "team",
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
      scope: "private",
    });

    const moved = await movePath(store, {
      from: "2-areas/shared",
      to: "2-areas/shared-renamed",
      scope: "private",
      now: NOW,
    });
    expect(moved.paths).toEqual(["2-areas/shared-renamed/plan.md"]);
    // ...and it really is still readable afterwards, which is the premise.
    const listing = await listFolder(store, { path: "2-areas/shared-renamed", scope: "team" });
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
      scope: "private",
    });
    // They can read it — that is the whole point of the exception.
    const readable = await readFile(store, { path: "2-areas/open.md", scope: "team" });
    expect(readable.visibility).toBe("team");

    const refused = await capture(() =>
      movePath(store, {
        from: "2-areas/open.md",
        to: "2-areas/open-renamed.md",
        scope: "team",
        now: NOW,
      }),
    );
    expect(refused.code).toBe("FILE_NOT_FOUND");

    // The owner can, and the note keeps its exception.
    const moved = await movePath(store, {
      from: "2-areas/open.md",
      to: "2-areas/open-renamed.md",
      scope: "private",
      now: NOW,
    });
    expect(moved.paths).toEqual(["2-areas/open-renamed.md"]);
    const after = await readFile(store, { path: "2-areas/open-renamed.md", scope: "team" });
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
      scope: "private",
    });
    const error = await capture(() =>
      copyPath(store, {
        from: "2-areas/shared",
        to: "2-areas/elsewhere",
        scope: "team",
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
      scope: "private",
    });

    const taken = await capture(() =>
      movePath(store, {
        from: "1-projects/mine.md",
        to: "1-projects/held-back.md",
        scope: "team",
        now: NOW,
      }),
    );
    const free = await capture(() =>
      movePath(store, {
        from: "1-projects/mine.md",
        to: "2-areas/never.md",
        scope: "team",
        now: NOW,
      }),
    );
    expect(errorShape(taken)).toBe(errorShape(free));
    expect(taken.message).not.toContain("held-back");

    // ...and an ordinary move inside the shared folder still works.
    const moved = await movePath(store, {
      from: "1-projects/mine.md",
      to: "1-projects/renamed.md",
      scope: "team",
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
      scope: "private",
    });

    const root = await listFolder(store, { path: "", scope: "team" });
    expect(names(root.entries)).toContain("2-areas");

    const areas = await listFolder(store, { path: "2-areas", scope: "team" });
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
      scope: "private",
    });

    const listing = await listFolder(store, { path: "2-areas", scope: "team" });
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

/* -------------------------------------------------------------------------- */
/*                 a bulk operation acts on what you can see                  */
/* -------------------------------------------------------------------------- */

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
      scope: "private",
    });
    return store;
  }

  test("deleting a folder leaves what the caller cannot see, and its history", async () => {
    const store = await mixedFolder();
    const result = await deletePath(store, {
      path: "1-projects/mixed",
      scope: "team",
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
      scope: "private",
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
      scope: "team",
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
      scope: "team",
      now: NOW,
    });

    const clean = bucket();
    await shareProjects(clean);
    clean.seed("1-projects/mixed/public.md", "# Public\n");
    const plain = await movePath(clean, {
      from: "1-projects/mixed",
      to: "1-projects/renamed",
      scope: "team",
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
      scope: "private",
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
      scope: "private",
    });

    const error = await capture(() =>
      copyPath(store, { from: "1-projects/src", to: "1-projects/dest", scope: "team" }),
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
      scope: "private",
    });
    return store;
  }

  test("a partial delete leaves the rule that still governs the survivor", async () => {
    const store = await ruleHiddenFolder();
    const result = await deletePath(store, {
      path: "1-projects/mixed",
      scope: "team",
      confirmation: DELETE_CONFIRMATION,
    });
    expect(result.paths).toEqual(["1-projects/mixed/public.md"]);

    // The survivor is still there, and still *private*. Reading it is the
    // assertion that matters: the rule surviving is only the mechanism.
    const leak = await capture(() =>
      readFile(store, { path: "1-projects/mixed/deep/secret.md", scope: "team" }),
    );
    expect(leak.code).toBe("FILE_NOT_FOUND");
    const owner = await readFile(store, {
      path: "1-projects/mixed/deep/secret.md",
      scope: "private",
    });
    expect(owner.text).toContain("200k");
  });

  test("a partial move leaves the rule where the survivor still is", async () => {
    const store = await ruleHiddenFolder();
    const moved = await movePath(store, {
      from: "1-projects/mixed",
      to: "1-projects/moved",
      scope: "team",
      now: NOW,
    });
    expect(moved.paths).toEqual(["1-projects/moved/public.md"]);

    // The note did not move, so its rule must not have moved either.
    const leak = await capture(() =>
      readFile(store, { path: "1-projects/mixed/deep/secret.md", scope: "team" }),
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
      scope: "private",
    });
    const moved = await movePath(store, {
      from: "2-areas/whole",
      to: "2-areas/whole-2",
      scope: "private",
      now: NOW,
    });
    expect(moved.paths).toEqual(["2-areas/whole-2/note.md"]);
    const listing = await listFolder(store, { path: "2-areas/whole-2", scope: "team" });
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
        scope: "private",
      });
      if (hides) {
        await setVisibility(store, {
          path: "2-areas/shared/secret.md",
          visibility: "private",
          scope: "private",
        });
      }
      // The caller sees the same folder either way before they act.
      const before = await listFolder(store, { path: "2-areas/shared", scope: "team" });
      expect(names(before.entries)).toEqual(["a.md"]);
      return {
        store,
        result: await capture(() =>
          movePath(store, {
            from: "2-areas/shared",
            to: "2-areas/renamed",
            scope: "team",
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
      readFile(hiding.store, { path: "2-areas/shared/secret.md", scope: "team" }),
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
      scope: "private",
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
        scope: "team",
        confirmation: DELETE_CONFIRMATION,
      }),
    );
    expect(error.code).toBe("FOLDER_TOO_LARGE");
    // Nothing was deleted and, above all, nothing was published.
    expect(store.snapshot()["1-projects/huge/aaa.md"]).toBeDefined();
    const leak = await capture(() =>
      readFile(store, { path: "1-projects/huge/zdeep/secret.md", scope: "team" }),
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
        scope: "team",
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
        scope: "team",
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
      scope: "private",
    });

    const refused = await capture(() =>
      movePath(store, {
        from: "2-areas/shared",
        to: "2-areas/elsewhere",
        scope: "team",
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
      scope: "team",
      now: NOW,
    });
    expect(moved.paths).toEqual(["1-projects/elsewhere/a.md"]);
  });

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
        scope: "private",
      });
      await setFolderVisibility(store, {
        path: "1-projects/mixed/hr/comp",
        visibility: "private",
        scope: "private",
      });
      return store;
    }
    const secret = "1-projects/mixed/hr/comp/secret.md";

    const deleted = await twoRules();
    await deletePath(deleted, {
      path: "1-projects/mixed",
      scope: "team",
      confirmation: DELETE_CONFIRMATION,
    });
    expect((await capture(() => readFile(deleted, { path: secret, scope: "team" }))).code).toBe(
      "FILE_NOT_FOUND",
    );
    expect((await readFile(deleted, { path: secret, scope: "private" })).text).toContain("200k");

    const moved = await twoRules();
    await movePath(moved, {
      from: "1-projects/mixed",
      to: "1-projects/moved",
      scope: "team",
      now: NOW,
    });
    expect((await capture(() => readFile(moved, { path: secret, scope: "team" }))).code).toBe(
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
      scope: "private",
    });
    await setVisibility(store, {
      path: "2-areas/shared/x.md",
      visibility: "private",
      scope: "private",
    });

    await movePath(store, {
      from: "2-areas/shared",
      to: "2-areas/renamed",
      scope: "private",
      now: NOW,
    });
    const manifest = store.snapshot()[PRIVACY_KEY] as string;
    expect(manifest).toContain("2-areas/renamed: team");
    // The old prefix keeps no rule. Not because a survivor did not need it —
    // there is no survivor here, the walk is at owner scope and both notes
    // moved. The rule follows the folder, and nothing is left pointing at an
    // empty prefix. (Two earlier comments here described a survivor held back
    // by its exception, and a third said "the keys afterwards are" three
    // particular ones — the bucket holds fourteen. Both are the same habit as
    // row 108, so the claim is an assertion now rather than a sentence.)
    expect(manifest).not.toContain("2-areas/shared: team");
    expect(
      Object.keys(store.snapshot()).filter((key) => key.startsWith("2-areas/shared/")),
    ).toEqual([]);
    // The exception travelled with it, so the note is private at its new path.
    // Asserting the OLD path was unreadable proved nothing — it had moved away,
    // so it was unreadable for the trivial reason and stayed unreadable with
    // the exception dropped entirely.
    expect(
      (await capture(() => readFile(store, { path: "2-areas/renamed/x.md", scope: "team" }))).code,
    ).toBe("FILE_NOT_FOUND");
    expect((await readFile(store, { path: "2-areas/renamed/x.md", scope: "private" })).text).toBe(
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
      scope: "private",
    });
    await setFolderVisibility(store, {
      path: "1-projects/a/b/hr",
      visibility: "private",
      scope: "private",
    });
    await setFolderVisibility(store, {
      path: "1-projects/a/b/b/hr/deep",
      visibility: "team",
      scope: "private",
    });
    const secret = "1-projects/a/b/hr/deep/secret.md";

    const error = await capture(() =>
      movePath(store, { from: "1-projects/a/b", to: "1-projects/a", scope: "team", now: NOW }),
    );
    expect(error.code).toBe("PATH_INVALID");
    expect((await capture(() => readFile(store, { path: secret, scope: "team" }))).code).toBe(
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
            scope: "private",
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
      scope: "private",
    });
    await setFolderVisibility(store, {
      path: "1-projects/src/hr",
      visibility: "private",
      scope: "private",
    });
    // A rule for a folder that does not exist — left behind by a delete, or
    // hand-written. This is the only way a rename can still collide now that
    // moving a folder onto an existing one is refused outright.
    await setFolderVisibility(store, {
      path: "1-projects/dst/hr",
      visibility: "team",
      scope: "private",
    });

    await movePath(store, {
      from: "1-projects/src",
      to: "1-projects/dst",
      scope: "private",
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
          readFile(store, { path: "1-projects/dst/hr/secret.md", scope: "team" }),
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
      scope: "private",
    });
    await setFolderVisibility(store, {
      path: "1-projects/mixed/hr",
      visibility: "private",
      scope: "private",
    });
    await setFolderVisibility(store, {
      path: "1-projects/mixed/legal",
      visibility: "private",
      scope: "private",
    });

    await deletePath(store, {
      path: "1-projects/mixed",
      scope: "team",
      confirmation: DELETE_CONFIRMATION,
    });

    for (const path of [
      "1-projects/mixed/aaa.md",
      "1-projects/mixed/hr/pay.md",
      "1-projects/mixed/legal/case.md",
    ]) {
      expect((await capture(() => readFile(store, { path, scope: "team" }))).code).toBe(
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
      scope: "private",
    });

    const hiddenBefore = await capture(() =>
      readFile(store, { path: "2-areas/dst/secret.md", scope: "team" }),
    );
    expect(hiddenBefore.code).toBe("FILE_NOT_FOUND");

    const error = await capture(() =>
      movePath(store, {
        from: "1-projects/src",
        to: "2-areas/dst",
        scope: "team",
        now: NOW,
      }),
    );
    // The caller cannot see `2-areas/dst`, so the refusal must not admit it is
    // there — same shape `createFolder`'s collision check uses.
    expect(error.code).toBe("FILE_NOT_FOUND");
    const stillHidden = await capture(() =>
      readFile(store, { path: "2-areas/dst/secret.md", scope: "team" }),
    );
    expect(stillHidden.code).toBe("FILE_NOT_FOUND");
  });

  test("merging two visible folders is refused, and says so plainly", async () => {
    const store = bucket();
    await shareProjects(store);
    store.seed("1-projects/one/a.md", "# A\n");
    store.seed("1-projects/two/b.md", "# B\n");

    const error = await capture(() =>
      movePath(store, { from: "1-projects/one", to: "1-projects/two", scope: "team", now: NOW }),
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
      scope: "team",
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
        scope: "private",
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
          movePath(store, { from: "2-areas/open.md", to: destination, scope: "team", now: NOW }),
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
      scope: "team",
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
        scope: "private",
      });
      return {
        store,
        result: await capture(() =>
          movePath(store, {
            from: "2-areas/shared-project",
            to: destination,
            scope: "team",
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
      scope: "team",
      now: NOW,
    });
    expect(moved.paths).toEqual(["1-projects/proj-renamed/plan.md"]);
  });

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
    const store = bucket();
    store.seed("1-projects/src/a.md", "# A\n");
    store.seed("2-areas/mixed/shared.md", "# Shared\n");
    store.seed("2-areas/mixed/secret.md", "# Secret\n");
    await shareProjects(store);
    // `2-areas` is private; the folder is in the tree only because of this.
    await setVisibility(store, {
      path: "2-areas/mixed/shared.md",
      visibility: "team",
      scope: "private",
    });
    const listing = await listFolder(store, { path: "2-areas", scope: "team" });
    expect(names(listing.entries)).toContain("mixed");

    const error = await capture(() =>
      movePath(store, {
        from: "1-projects/src",
        to: "2-areas/mixed",
        scope: "team",
        now: NOW,
      }),
    );
    expect(error.code).toBe("DESTINATION_EXISTS");
    // ...and nothing merged.
    expect(store.snapshot()["1-projects/src/a.md"]).toBeDefined();
    expect(store.snapshot()["2-areas/mixed/secret.md"]).toBeDefined();
  });

  /**
   * "The destination must not exist" is about a destination of either kind.
   * File-onto-file was always caught by the collision loop and folder-onto-
   * folder by the merge refusal; the two crossed pairs went through and left a
   * file key shadowing a folder prefix, which a Dropbox binding cannot even
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
      copyPath(store, { from: PRIVACY_KEY, to: "1-projects/leaked.md", scope: "private" }),
    );
    expect(copied.code).toBe("PRIVACY_MANIFEST_READ_ONLY");
    expect(store.snapshot()["1-projects/leaked.md"]).toBeUndefined();

    // The same refusal `movePath` already gave, and the same one a duplicate
    // gets, since it routes through here.
    const duplicated = await capture(() =>
      duplicatePath(store, { path: PRIVACY_KEY, scope: "private" }),
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
          scope: "private",
        });
      }
      return duplicatePath(store, { path: "1-projects/note.md", scope: "team" });
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
    const store = bucket();
    store.seed("2-areas/shared/a.md", "# A\n");
    store.seed("2-areas/shared/held.md", "# Held back\n");
    await setFolderVisibility(store, {
      path: "2-areas/shared",
      visibility: "team",
      scope: "private",
    });
    // The survivor is held back by its own exception, so it never rested on the
    // folder's `team` rule and that rule is not the folder's to keep.
    await setVisibility(store, {
      path: "2-areas/shared/held.md",
      visibility: "private",
      scope: "private",
    });

    const result = await deletePath(store, {
      path: "2-areas/shared",
      scope: "team",
      confirmation: DELETE_CONFIRMATION,
    });
    expect(result.paths).toEqual(["2-areas/shared/a.md"]);

    const manifest = store.snapshot()[PRIVACY_KEY] as string;
    expect(manifest).not.toContain("2-areas/shared: team");
    // ...so the folder is gone from the caller's tree rather than sitting there
    // empty, and the survivor is still private and still there.
    // Gone from the caller's tree — the root listing no longer names it — and
    // asking for it directly gives the same empty answer any absent name does,
    // rather than a refusal that would confirm it is still there.
    expect(names((await listFolder(store, { path: "2-areas", scope: "team" })).entries)).not.toContain(
      "shared",
    );
    const gone = await listFolder(store, { path: "2-areas/shared", scope: "team" });
    const never = await listFolder(store, { path: "2-areas/never-existed", scope: "team" });
    expect(listingShape(gone)).toBe(listingShape(never));
    const leak = await capture(() =>
      readFile(store, { path: "2-areas/shared/held.md", scope: "team" }),
    );
    expect(leak.code).toBe("FILE_NOT_FOUND");
    expect(store.snapshot()["2-areas/shared/held.md"]).toBeDefined();
  });

  test("a name in use by a subfolder is stepped over when duplicating", async () => {
    const store = bucket();
    await shareProjects(store);
    store.seed("1-projects/note.md", "# Note\n");
    // A FOLDER holding the name the duplicate would pick. Landing a file key
    // beside a folder prefix is the shape `movePath` refuses outright.
    store.seed("1-projects/note copy.md/inner.md", "# Inner\n");

    const duplicated = await duplicatePath(store, { path: "1-projects/note.md", scope: "team" });
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
      scope: "private",
    });

    // A page that drops the earlier key — a provider returning fewer objects
    // than asked for, which S3 and Dropbox both may do. Without the refusal the
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
      duplicatePath(thin, { path: "1-projects/note.md", scope: "team" }),
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
    const store = bucket();
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

    const refused = await capture(() =>
      movePath(store, {
        from: "1-projects/mine.md",
        to: "1-projects/echo.md",
        scope: "team",
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
    const store = bucket();
    await shareProjects(store);
    store.seed("1-projects/mine.md", "# Mine\n");
    await setFolderVisibility(store, {
      path: "1-projects/target.md",
      visibility: "private",
      scope: "private",
    });

    const refused = await capture(() =>
      movePath(store, {
        from: "1-projects/mine.md",
        to: "1-projects/target.md",
        scope: "team",
        now: NOW,
      }),
    );
    expect(refused.code).toBe("FILE_NOT_FOUND");
    expect(store.snapshot()["1-projects/target.md"]).toBeUndefined();

    // The control: an ordinary destination in the same folder still moves.
    const moved = await movePath(store, {
      from: "1-projects/mine.md",
      to: "1-projects/ordinary.md",
      scope: "team",
      now: NOW,
    });
    expect(moved.paths).toEqual(["1-projects/ordinary.md"]);
  });

  test("a destination that exists as the other kind is refused too", async () => {
    const ontoFile = bucket();
    ontoFile.seed("1-projects/src/a.md", "# A\n");
    ontoFile.seed("1-projects/dst", "# I am a file key\n");
    const folderOntoFile = await capture(() =>
      movePath(ontoFile, {
        from: "1-projects/src",
        to: "1-projects/dst",
        scope: "private",
        now: NOW,
      }),
    );
    expect(folderOntoFile.code).toBe("DESTINATION_EXISTS");
    expect(ontoFile.snapshot()["1-projects/src/a.md"]).toBeDefined();

    const ontoFolder = bucket();
    ontoFolder.seed("1-projects/b.md", "# B\n");
    ontoFolder.seed("1-projects/dst/inner.md", "# Inner\n");
    const fileOntoFolder = await capture(() =>
      movePath(ontoFolder, {
        from: "1-projects/b.md",
        to: "1-projects/dst",
        scope: "private",
        now: NOW,
      }),
    );
    expect(fileOntoFolder.code).toBe("DESTINATION_EXISTS");
    expect(ontoFolder.snapshot()["1-projects/b.md"]).toBeDefined();
  });

  /**
   * Archiving a child and then its parent inside one millisecond lands the
   * second archive on top of the first, which the merge refusal now stops. The
   * archive stamp is server-generated and never caller-chosen, so giving it a
   * free one discloses nothing and keeps "never merges" true rather than
   * carving an exception into it.
   */
  test("archiving a child and then its parent in the same millisecond works", async () => {
    const store = bucket();
    store.seed("1-projects/proj/inner/x.md", "# X\n");
    store.seed("1-projects/proj/y.md", "# Y\n");

    const child = await archivePath(store, {
      path: "1-projects/proj/inner",
      scope: "private",
      now: NOW,
    });
    const parent = await archivePath(store, {
      path: "1-projects/proj",
      scope: "private",
      now: NOW,
    });
    expect(child.paths[0]).toContain("/1-projects/proj/inner/x.md");
    expect(parent.paths[0]).toContain("/1-projects/proj/y.md");
    // Two distinct archive trees, and the first one is intact.
    expect(store.snapshot()[child.paths[0]!]).toBeDefined();
    expect(store.snapshot()[parent.paths[0]!]).toBeDefined();
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
    const store = bucket();
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
      scope: "private",
    });
    await setFolderVisibility(store, {
      path: "1-projects/zzz",
      visibility: "private",
      scope: "private",
    });
    await setVisibility(store, {
      path: "1-projects/zzz/n.md",
      visibility: "team",
      scope: "private",
    });

    const moved = await movePath(store, {
      from: "1-projects/zzz",
      to: "1-projects/aaa",
      scope: "private",
      now: NOW,
    });
    expect(moved.paths).toEqual(["1-projects/aaa/n.md"]);
    // The note kept the visibility it had; it did not become private because
    // an exception was dropped as redundant against a rule that was never
    // written.
    const file = await readFile(store, { path: "1-projects/aaa/n.md", scope: "team" });
    expect(file.visibility).toBe("team");
  });

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
      scope: "private",
    });
    await setFolderVisibility(store, {
      path: "1-projects/aaa-team",
      visibility: "team",
      scope: "private",
    });

    const error = await capture(() =>
      movePath(store, {
        from: "1-projects/aaa-team",
        to: "1-projects/zzz-hidden",
        scope: "team",
        now: NOW,
      }),
    );
    expect(error.code).toBe("FILE_NOT_FOUND");
    // The note stayed where its owner can still reach it.
    expect(store.snapshot()["1-projects/aaa-team/plan.md"]).toBeDefined();
    const listing = await listFolder(store, { path: "1-projects/aaa-team", scope: "team" });
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
      scope: "private",
    });
    await setFolderVisibility(store, {
      path: "1-projects/aaa/hr",
      visibility: "private",
      scope: "private",
    });
    await setFolderVisibility(store, {
      path: "1-projects/zzz/hr",
      visibility: "team",
      scope: "private",
    });

    await movePath(store, {
      from: "1-projects/aaa",
      to: "1-projects/zzz",
      scope: "private",
      now: NOW,
    });

    const manifest = store.snapshot()[PRIVACY_KEY] as string;
    const lines = manifest.split("\n").filter((line) => line.includes("1-projects/zzz/hr:"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("private");
    expect(
      (
        await capture(() =>
          readFile(store, { path: "1-projects/zzz/hr/secret.md", scope: "team" }),
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
      scope: "private",
    });

    await deletePath(store, {
      path: "1-projects/mixed",
      scope: "team",
      confirmation: DELETE_CONFIRMATION,
    });

    const manifest = store.snapshot()[PRIVACY_KEY] as string;
    const lines = manifest
      .split("\n")
      .filter((line) => line.trim().startsWith("1-projects/mixed/hr:"));
    expect(lines).toHaveLength(1);
    for (const path of ["1-projects/mixed/hr/pay.md", "1-projects/mixed/hr/bonus.md"]) {
      expect((await capture(() => readFile(store, { path, scope: "team" }))).code).toBe(
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
      scope: "private",
    });
    await setFolderVisibility(store, {
      path: "1-projects/mixed/hr/comp",
      visibility: "private",
      scope: "private",
    });
    const secret = "1-projects/mixed/hr/comp/secret.md";
    expect((await capture(() => readFile(store, { path: secret, scope: "team" }))).code).toBe(
      "FILE_NOT_FOUND",
    );

    await deletePath(store, {
      path: "1-projects/mixed",
      scope: "team",
      confirmation: DELETE_CONFIRMATION,
    });
    expect((await capture(() => readFile(store, { path: secret, scope: "team" }))).code).toBe(
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
        scope: "private",
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
      scope: "private",
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
      scope: "private",
    });

    const result = await deletePath(store, {
      path: "1-projects",
      scope: "team",
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
      scope: "private",
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
      scope: "private",
    });

    const result = await deletePath(store, {
      path: "1-projects/hist",
      scope: "team",
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
      scope: "private",
    });

    const taken = await capture(() =>
      movePath(store, {
        from: "1-projects/src.md",
        to: "1-projects/hidden-name.md",
        scope: "team",
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
        scope: "team",
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
      scope: "team",
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
      scope: "private",
    });

    const root = await listFolder(store, { path: "", scope: "team" });
    expect(names(root.entries)).not.toContain("3-resources");
    // The control: the same shape with a `team` rule does unhide it.
    await setFolderVisibility(store, {
      path: "3-resources/deep",
      visibility: "team",
      scope: "private",
    });
    const shared = await listFolder(store, { path: "", scope: "team" });
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
      scope: "private",
    });

    await movePath(store, {
      from: "1-projects/sub",
      to: "1-projects/sub-moved",
      scope: "team",
      now: NOW,
    });
    const leak = await capture(() =>
      readFile(store, { path: "1-projects/subway/secret.md", scope: "team" }),
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
      scope: "private",
    });

    const hidden = await capture(() =>
      deletePath(store, {
        path: "1-projects/allhidden",
        scope: "team",
        confirmation: DELETE_CONFIRMATION,
      }),
    );
    const absent = await capture(() =>
      deletePath(store, {
        path: "1-projects/never-existed",
        scope: "team",
        confirmation: DELETE_CONFIRMATION,
      }),
    );
    expect(errorShape(hidden)).toBe(errorShape(absent));
    expect(store.snapshot()["1-projects/allhidden/one.md"]).toBeDefined();
  });
});

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

/* -------------------------------------------------------------------------- */
/*                  guards nobody had checked, and one honest comment          */
/* -------------------------------------------------------------------------- */

describe("a walk that says it is truncated and offers nowhere to go", () => {
  /**
   * `truncated` and `cursor` are read from two independent XML tags — see
   * `readTag` in `apps/mcp/src/store/s3.js`, which sets `IsTruncated` from one
   * element and `NextContinuationToken` from another and never checks that
   * they agree. A response carrying the first without the second therefore
   * reaches this module as `{ truncated: true, cursor: undefined }`, and every
   * walk in `fileOps.ts` read that as "finished": `!listing.truncated ||
   * !listing.cursor` is true, so the three walks that refuse broke *and set
   * `complete`*, and the two that report a short listing reported none.
   *
   * That is the row-83 defect reachable a second way. An incomplete walk read
   * as complete is what lets `rulesSurvivorsRestOn` decide a note it never saw
   * is not a survivor, and drop the rule that was hiding it.
   *
   * The endpoint is the customer's own, so this is not cross-tenant; it is
   * their own bucket, on a provider or proxy that answers slightly wrong,
   * publishing their own private notes. "Only a nonconforming store does this"
   * is the reasoning that put the bug here, and B2, Wasabi, MinIO and whatever
   * somebody points a self-hosted gateway at are all in scope.
   */
  function stalling(store: MemoryStore & FileStore): FileStore {
    return {
      ...store,
      list: async (options) => ({
        ...(await store.list(options)),
        truncated: true,
        cursor: undefined,
      }),
    };
  }

  test("a folder delete is refused rather than half-done", async () => {
    const store = bucket();
    await shareProjects(store);
    store.seed("1-projects/huge/aaa.md", "# A\n");
    store.seed("1-projects/huge/zdeep/secret.md", "# Salaries\n\n200k\n");
    await setFolderVisibility(store, {
      path: "1-projects/huge/zdeep",
      visibility: "private",
      scope: "private",
    });

    const error = await capture(() =>
      deletePath(stalling(store), {
        path: "1-projects/huge",
        scope: "team",
        confirmation: DELETE_CONFIRMATION,
      }),
    );

    expect(error.code).toBe("LISTING_INCOMPLETE");
    expect(store.snapshot()["1-projects/huge/aaa.md"]).toBeDefined();
    const leak = await capture(() =>
      readFile(store, { path: "1-projects/huge/zdeep/secret.md", scope: "team" }),
    );
    expect(leak.code).toBe("FILE_NOT_FOUND");
  });

  test("a file delete is refused rather than deciding a neighbour is not there", async () => {
    // `namesExtending` — the notes whose names extend the one being deleted.
    // They are its survivors, and a short list of them is not a smaller answer:
    // `historyKeysFor` resolves each snapshot to the longest name that owns it,
    // so a survivor missing from the list hands its own history to the delete,
    // and `forgetPrivacy` then drops the rule that was governing it.
    const store = bucket();
    await shareProjects(store);
    store.seed("1-projects/context-lc.md.notes.md", "# Notes\n");
    store.seed(".history/1-projects/context-lc.md.notes.md.2026-07-01T09-00-00-000Z.md", "# older\n");

    const error = await capture(() =>
      deletePath(stalling(store), {
        path: "1-projects/context-lc.md",
        scope: "team",
        confirmation: DELETE_CONFIRMATION,
      }),
    );

    expect(error.code).toBe("LISTING_INCOMPLETE");
    expect(store.snapshot()["1-projects/context-lc.md"]).toBeDefined();
    // The neighbour nobody asked to delete, and its history.
    expect(store.snapshot()["1-projects/context-lc.md.notes.md"]).toBeDefined();
    expect(
      store.snapshot()[".history/1-projects/context-lc.md.notes.md.2026-07-01T09-00-00-000Z.md"],
    ).toBeDefined();
  });

  test("a duplicate is refused rather than picking a name off a short list", async () => {
    // `namesInUse`. A short list of taken names is not a smaller answer, it is
    // a wrong one: the name it picks is then refused by `copyPath`'s guard if
    // and only if a hidden note holds it.
    const store = bucket();
    await shareProjects(store);

    const error = await capture(() =>
      duplicatePath(stalling(store), { path: "1-projects/context-lc.md", scope: "team" }),
    );

    expect(error.code).toBe("LISTING_INCOMPLETE");
  });

  test("a store that replays one cursor is a store fault on every walk", async () => {
    // `keysUnder` had this pinned on both its exits; `namesInUse` and
    // `namesExtending` had only the no-cursor one, so reverting their
    // `stop = "store"` on the REPEATED-cursor exit passed all 1121 checks. The
    // code was right at all six sites and pinned at four. What drifts back if
    // nothing holds it is the wrong remedy: somebody duplicating a note against
    // a cursor-replaying endpoint told to "move some of them first".
    const store = bucket();
    await shareProjects(store);
    store.seed("1-projects/context-lc.md.notes.md", "# Notes\n");
    const replaying: FileStore = {
      ...store,
      list: async (options) => ({
        ...(await store.list(options)),
        truncated: true,
        cursor: options?.cursor ?? "same",
      }),
    };

    // `namesInUse`, via duplicate.
    expect(
      (await capture(() =>
        duplicatePath(replaying, { path: "1-projects/context-lc.md", scope: "team" }),
      )).code,
    ).toBe("LISTING_INCOMPLETE");

    // `namesExtending`, via a single-file delete.
    expect(
      (await capture(() =>
        deletePath(replaying, {
          path: "1-projects/context-lc.md",
          scope: "team",
          confirmation: DELETE_CONFIRMATION,
        }),
      )).code,
    ).toBe("LISTING_INCOMPLETE");
  });

  test("a listing that could not finish says so", async () => {
    const store = bucket();
    await shareProjects(store);

    const listing = await listFolder(stalling(store), { path: "1-projects", scope: "team" });

    // A floor is never printed as a total — the rule the note census follows.
    expect(listing.truncated).toBe(true);
  });

  test("a path the caller cannot see is refused before its parent is walked", async () => {
    // `duplicatePath` listed the parent folder to pick a free name, and did it
    // before anything had checked the path the caller named.
    //
    // What that discloses is the parent's **size**, not its existence — the two
    // paths below differ in which folder they name, and both folders are ones
    // this caller cannot see into. `namesInUse` refuses a walk it could not
    // finish, so the big one answered `LISTING_INCOMPLETE` and the small one
    // `FILE_NOT_FOUND`. (An earlier version of this comment claimed the
    // difference was hidden-versus-absent, which is wrong: those two share a
    // parent, so no ordering can separate them. A comment about what a test
    // proves is a claim with nothing checking it — this one is measured.)
    //
    // The other half is that a full walk of a folder the caller cannot see ran
    // at all, on the strength of a name they typed.
    const store = bucket();
    await shareProjects(store);
    store.seed("2-areas/big/x.md", "# X\n");
    store.seed("2-areas/small/x.md", "# X\n");

    // Only the big folder stalls. Everything else lists normally, so the two
    // probes differ in exactly one thing.
    const lopsided: FileStore = {
      ...store,
      list: async (options) => {
        const page = await store.list(options);
        return options?.prefix === "2-areas/big/"
          ? { ...page, truncated: true, cursor: undefined }
          : page;
      },
    };

    const big = await capture(() =>
      duplicatePath(lopsided, { path: "2-areas/big/x.md", scope: "team" }),
    );
    const small = await capture(() =>
      duplicatePath(lopsided, { path: "2-areas/small/x.md", scope: "team" }),
    );

    expect(big.code).toBe("FILE_NOT_FOUND");
    expect(errorShape(big)).toBe(errorShape(small));
  });

  test("duplicate refuses a reserved path the way every other operation does", async () => {
    // Putting the visibility check first is only safe in `copyPath`'s order,
    // which is `assertWritablePath` and then `canSee`. Dropped, it made
    // Duplicate the one operation in this file answering `FILE_NOT_FOUND` for a
    // dot-prefixed path — a difference with no security in either direction and
    // every chance of confusing somebody reading two error messages side by
    // side. Pinned against `copyPath`, so the two cannot drift again.
    const store = bucket();
    await shareProjects(store);

    for (const [path, scope] of [
      [PRIVACY_KEY, "team"],
      [PRIVACY_KEY, "private"],
      [".history/1-projects/context-lc.md.old.md", "private"],
      [".history/1-projects/context-lc.md.old.md", "team"],
    ] as const) {
      const viaDuplicate = await capture(() => duplicatePath(store, { path, scope }));
      const viaCopy = await capture(() =>
        copyPath(store, { from: path, to: "1-projects/anywhere.md", scope }),
      );
      expect(errorShape(viaDuplicate)).toBe(errorShape(viaCopy));
    }
  });

  test("a manifest repair that could not see every folder is partial", async () => {
    const store = bucket();
    store.seed(PRIVACY_KEY, "# broken\n");

    const result = await resetPrivacyManifest(stalling(store), { scope: "private", now: NOW });

    // The folders it did see still get their `private` line — a folder it
    // missed inherits `default_visibility: private`, so the repair still fails
    // closed. What must not happen is the short list being reported complete.
    expect(result.partial).toBe(true);
  });
});

describe("three guards that no test was holding", () => {
  /**
   * All three of these mutated to **zero** failures across the whole suite
   * before this block existed: `movePath`'s `canSee(from)`, `copyPath`'s
   * `canSee(from)`, and `copyPath`'s `sources.length === 0`. Each was written
   * deliberately and each was doing real work — a guard nobody has checked is
   * not a guard, and the way that gets found is by breaking it on purpose.
   */

  test("a team caller cannot move a note they cannot see", async () => {
    // `2-areas` is private by default and `health.md` carries no exception, so
    // its privacy rests entirely on the folder rule — which the destination
    // does not have. Without the guard the note lands in a `team` folder with
    // nothing carried across and becomes readable.
    const store = bucket();
    await shareProjects(store);

    const refusal = await capture(() =>
      movePath(store, {
        from: "2-areas/health.md",
        to: "1-projects/leaked.md",
        scope: "team",
        now: NOW,
      }),
    );
    const absent = await capture(() =>
      movePath(store, {
        from: "2-areas/never-existed.md",
        to: "1-projects/leaked.md",
        scope: "team",
        now: NOW,
      }),
    );

    expect(refusal.code).toBe("FILE_NOT_FOUND");
    expect(errorShape(refusal)).toBe(errorShape(absent));
    expect(store.snapshot()["2-areas/health.md"]).toBeDefined();
    expect(store.snapshot()["1-projects/leaked.md"]).toBeUndefined();
  });

  test("a team caller cannot copy a note they cannot see", async () => {
    // `copyPrivacy` carries an exact-note exception and nothing else, so a note
    // private by folder rule arrives at a `team` destination with no exception
    // at all. The copy is not a lesser harm than the move: it is the contents,
    // readable, and the original still in place to make it look untouched.
    const store = bucket();
    await shareProjects(store);

    const refusal = await capture(() =>
      copyPath(store, { from: "2-areas/health.md", to: "1-projects/leaked.md", scope: "team" }),
    );
    const absent = await capture(() =>
      copyPath(store, {
        from: "2-areas/never-existed.md",
        to: "1-projects/leaked.md",
        scope: "team",
      }),
    );

    expect(refusal.code).toBe("FILE_NOT_FOUND");
    expect(errorShape(refusal)).toBe(errorShape(absent));
    expect(store.snapshot()["1-projects/leaked.md"]).toBeUndefined();
    expect(
      (await capture(() => readFile(store, { path: "1-projects/leaked.md", scope: "team" }))).code,
    ).toBe("FILE_NOT_FOUND");
  });

  test("copying a visible folder whose every note is hidden is not a quiet success", async () => {
    // The folder is `team` — the caller can see it — and everything inside it
    // carries a `private` exception, so the walk returns nothing. Without the
    // guard this answers `paths: []` and HTTP success, while a folder that was
    // never there answers `FILE_NOT_FOUND`. That difference is an existence
    // oracle for a folder whose entire contents are private.
    const store = bucket();
    await shareProjects(store);
    store.seed("1-projects/hr/comp.md", "# Salaries\n\n200k\n");
    await setVisibility(store, {
      path: "1-projects/hr/comp.md",
      visibility: "private",
      scope: "private",
    });

    const refusal = await capture(() =>
      copyPath(store, { from: "1-projects/hr", to: "1-projects/hr-copy", scope: "team" }),
    );
    const absent = await capture(() =>
      copyPath(store, { from: "1-projects/nothing", to: "1-projects/hr-copy", scope: "team" }),
    );

    expect(refusal.code).toBe("FILE_NOT_FOUND");
    expect(errorShape(refusal)).toBe(errorShape(absent));
    expect(store.snapshot()["1-projects/hr-copy/comp.md"]).toBeUndefined();
  });
});

describe("a rule no survivor needs, told truthfully", () => {
  /**
   * `a rule no survivor needs is not retained` claimed to be the test a "keep
   * every rule under the folder" implementation fails. It is not: it moves at
   * owner scope, where `rulesSurvivorsRestOn` returns on its first line, and
   * `return [...candidates]` passes it. Its comment has been corrected.
   *
   * The drop *is* pinned, on the delete path, by `a rule no survivor rests on
   * is dropped, at team scope`. This adds the move path, which had none, and
   * one consequence that test does not reach: the rule left standing is on a
   * prefix inside the owner's private area, so a note the owner writes there
   * afterwards is readable by anyone with team access. Verified by substituting
   * `return [...candidates]` and watching this fail.
   */
  test("the moved folder's own rule does not stay behind on a private prefix", async () => {
    const store = bucket();
    await shareProjects(store);
    // Inside `2-areas`, which is private, one folder deliberately shared.
    store.seed("2-areas/mixed/public.md", "# Public\n");
    store.seed("2-areas/mixed/hr/secret.md", "# Salaries\n\n200k\n");
    await setFolderVisibility(store, {
      path: "2-areas/mixed",
      visibility: "team",
      scope: "private",
    });
    await setFolderVisibility(store, {
      path: "2-areas/mixed/hr",
      visibility: "private",
      scope: "private",
    });

    await movePath(store, {
      from: "2-areas/mixed",
      to: "1-projects/renamed",
      scope: "team",
      now: NOW,
    });

    const manifest = store.snapshot()[PRIVACY_KEY] as string;
    // The survivor is still hidden, which is row 82 and stays true. It does not
    // need `2-areas/mixed/hr: private` to be, because with `2-areas/mixed: team`
    // gone it rests on `2-areas: private` — which is exactly the reasoning
    // `rulesSurvivorsRestOn` does, and why it retains a rule only when removing
    // it would change what the survivor resolves to.
    expect(
      (await capture(() => readFile(store, { path: "2-areas/mixed/hr/secret.md", scope: "team" })))
        .code,
    ).toBe("FILE_NOT_FOUND");
    // The rule no survivor rests on does not.
    expect(manifest).not.toContain("2-areas/mixed: team");
    // And the consequence, which is what makes this worth a test: the prefix
    // the caller emptied is back inside the owner's private area.
    await writeFile(store, {
      path: "2-areas/mixed/afterwards.md",
      text: "# Written later\n",
      scope: "private",
      now: NOW,
    });
    expect(
      (await capture(() => readFile(store, { path: "2-areas/mixed/afterwards.md", scope: "team" })))
        .code,
    ).toBe("FILE_NOT_FOUND");
  });
});
