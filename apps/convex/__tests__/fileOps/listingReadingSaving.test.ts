import { describe, expect, test } from "vitest";
import { clearanceOf } from "../../functions/lib/clearance";
import {
  type FileStore,
  listFolder,
  readFile,
  setFolderVisibility,
  setVisibility,
  writeFile,
} from "../../functions/lib/fileOps";
import {
  PRIVACY_KEY,
  canSee,
} from "../../functions/lib/privacy";
import {
  NOW,
  bucket,
  shareProjects,
  capture,
  errorShape,
  listingShape,
  names,
} from "./fixtures";

describe("listing a folder", () => {
  test("folders come first, then files, each alphabetically", async () => {
    const store = bucket();
    const listing = await listFolder(store, { path: "", clearance: clearanceOf("private") });
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
    const listing = await listFolder(store, { path: "", clearance: clearanceOf("private") });
    expect(names(listing.entries)).not.toContain(".history");
  });

  test("a folder reports its own default, so the row can show it", async () => {
    const store = bucket();
    await shareProjects(store);
    expect((await listFolder(store, { path: "1-projects", clearance: clearanceOf("private") })).folderDefault).toBe(
      "team",
    );
    expect((await listFolder(store, { path: "2-areas", clearance: clearanceOf("private") })).folderDefault).toBe(
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
    const listing = await listFolder(store, { path: "1-projects", clearance: clearanceOf("private") });
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
    const listing = await listFolder(store, { path: "", clearance: clearanceOf("private") });
    const manifest = listing.entries.find((entry) => entry.name === PRIVACY_KEY)!;
    expect(manifest.readOnly).toBe(true);
  });

  test("a manifest the gateway cannot parse is reported, not guessed at", async () => {
    const store = bucket();
    store.seed(PRIVACY_KEY, "# no managed block here\n");
    const listing = await listFolder(store, { path: "", clearance: clearanceOf("private") });
    expect(listing.manifestUsable).toBe(false);
    // …and everything falls back to private, which is the safe direction.
    const team = await listFolder(store, { path: "", clearance: clearanceOf("team") });
    expect(team.entries).toEqual([]);
  });
});

describe("a team-scoped caller sees only what is shared", () => {
  test("a private folder is not listed", async () => {
    const store = bucket();
    await shareProjects(store);
    const listing = await listFolder(store, { path: "", clearance: clearanceOf("team") });
    expect(names(listing.entries)).toEqual(["1-projects"]);
  });

  test("privacy.md is never listed for a team caller — it names every private folder", async () => {
    const store = bucket();
    await shareProjects(store);
    const listing = await listFolder(store, { path: "", clearance: clearanceOf("team") });
    expect(names(listing.entries)).not.toContain(PRIVACY_KEY);
  });

  test("a private exception inside a shared folder is not listed", async () => {
    const store = bucket();
    await shareProjects(store);
    const listing = await listFolder(store, { path: "1-projects", clearance: clearanceOf("team") });
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
      clearance: clearanceOf("private"),
    });
    const root = await listFolder(store, { path: "", clearance: clearanceOf("team") });
    expect(names(root.entries)).toContain("2-areas");
    const inside = await listFolder(store, { path: "2-areas", clearance: clearanceOf("team") });
    expect(names(inside.entries)).toEqual(["health.md"]);
  });

  test("listing a private folder fails exactly as listing a folder that never existed", async () => {
    const store = bucket();
    await shareProjects(store);
    const hidden = await listFolder(store, { path: "2-areas", clearance: clearanceOf("team") });
    const absent = await listFolder(store, { path: "9-imaginary", clearance: clearanceOf("team") });
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
      clearance: clearanceOf("private"),
    });

    const listing = await listFolder(store, { path: "2-areas", clearance: clearanceOf("team") });
    expect(names(listing.entries)).toEqual(["shared"]);
    expect(names((await listFolder(store, { path: "2-areas/shared", clearance: clearanceOf("team") })).entries)).toEqual([
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
      clearance: clearanceOf("private"),
    });

    const hidden = await listFolder(store, {
      path: "1-projects/secret-client",
      clearance: clearanceOf("team"),
    });
    const absent = await listFolder(store, {
      path: "1-projects/no-such-thing",
      clearance: clearanceOf("team"),
    });
    expect(listingShape(hidden)).toBe(listingShape(absent));
    // And the owner still sees it, so the collapse is about scope and not
    // about the folder having stopped existing.
    expect(
      names((await listFolder(store, { path: "1-projects/secret-client", clearance: clearanceOf("private") })).entries),
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
    await listFolder(counted, { path: "1-projects/secret-client", clearance: clearanceOf("team") });
    const withheldLists = lists;
    lists = 0;
    await listFolder(counted, { path: "1-projects/no-such-thing", clearance: clearanceOf("team") });
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
      clearance: clearanceOf("private"),
    });

    const hidden = await listFolder(store, {
      path: "1-projects/secret-client/anything",
      clearance: clearanceOf("team"),
    });
    const absent = await listFolder(store, {
      path: "1-projects/never-existed/anything",
      clearance: clearanceOf("team"),
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
      clearance: clearanceOf("private"),
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
      clearance: clearanceOf("team"),
    });
    const absent = await listFolder(nonconforming, {
      path: "1-projects/no-such-thing",
      clearance: clearanceOf("team"),
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
      clearance: clearanceOf("private"),
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
      clearance: clearanceOf("team"),
    });
    const withheldLists = lists;
    lists = 0;
    const absent = await listFolder(paged, {
      path: "1-projects/no-such-thing",
      clearance: clearanceOf("team"),
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
    const file = await readFile(store, { path: "1-projects/context-lc.md", clearance: clearanceOf("private") });
    expect(file.text).toContain("# Context.LC");
    expect(file.etag).toBeTruthy();
    expect(file.readOnly).toBe(false);
  });

  test("privacy.md reads back, marked read-only", async () => {
    const store = bucket();
    const file = await readFile(store, { path: PRIVACY_KEY, clearance: clearanceOf("private") });
    expect(file.readOnly).toBe(true);
    expect(file.text).toContain("BEGIN BRAIN PRIVACY RULES");
  });

  test("a team caller reading a private note gets the same error as for a missing one", async () => {
    const store = bucket();
    await shareProjects(store);
    const hidden = await capture(() =>
      readFile(store, { path: "1-projects/pay.md", clearance: clearanceOf("team") }),
    );
    const absent = await capture(() =>
      readFile(store, { path: "1-projects/never-existed.md", clearance: clearanceOf("team") }),
    );
    expect(errorShape(hidden)).toBe(errorShape(absent));
    expect(hidden.code).toBe("FILE_NOT_FOUND");
  });

  test("a team caller cannot read privacy.md", async () => {
    const store = bucket();
    await shareProjects(store);
    const error = await capture(() => readFile(store, { path: PRIVACY_KEY, clearance: clearanceOf("team") }));
    expect(error.code).toBe("FILE_NOT_FOUND");
  });

  test("a traversal path is refused rather than resolved", async () => {
    const store = bucket();
    const error = await capture(() =>
      readFile(store, { path: "1-projects/../privacy.md", clearance: clearanceOf("team") }),
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
      clearance: clearanceOf("private"),
      now: NOW,
    });
    expect(written.path).toBe("1-projects/new.md");
    expect(store.snapshot()["1-projects/new.md"]).toBe("# New\n");
  });

  test("updates an existing one when the etag matches", async () => {
    const store = bucket();
    const read = await readFile(store, { path: "1-projects/context-lc.md", clearance: clearanceOf("private") });
    const written = await writeFile(store, {
      path: read.path,
      text: "# Edited\n",
      expectedEtag: read.etag,
      clearance: clearanceOf("private"),
      now: NOW,
    });
    expect(written.etag).not.toBe(read.etag);
    expect(store.snapshot()["1-projects/context-lc.md"]).toBe("# Edited\n");
  });

  test("the replaced version is not copied anywhere", async () => {
    const store = bucket();
    const before = Object.keys(store.snapshot());
    const read = await readFile(store, { path: "1-projects/context-lc.md", clearance: clearanceOf("private") });
    await writeFile(store, {
      path: read.path,
      text: "# Edited\n",
      expectedEtag: read.etag,
      clearance: clearanceOf("private"),
      now: NOW,
    });
    // Not "no `.history/` key" — the whole bucket. A snapshot that moved to a
    // different prefix is the same second copy of somebody's note under a new
    // name, and versioning at the provider is what keeps versions now.
    expect(Object.keys(store.snapshot()).sort()).toEqual(before.sort());
    expect(
      Object.values(store.snapshot()).filter((body) => body === "# Context.LC\n\nnotes\n"),
    ).toEqual([]);
  });

  /* ------------------------------ conflicts ------------------------------- */

  test("a stale etag is a conflict, and the file is untouched", async () => {
    const store = bucket();
    const first = await readFile(store, { path: "1-projects/context-lc.md", clearance: clearanceOf("private") });

    // Somebody else — Obsidian, an AI client — saves first.
    await writeFile(store, {
      path: first.path,
      text: "# Theirs\n",
      expectedEtag: first.etag,
      clearance: clearanceOf("private"),
      now: NOW,
    });

    const error = await capture(() =>
      writeFile(store, {
        path: first.path,
        text: "# Mine\n",
        expectedEtag: first.etag,
        clearance: clearanceOf("private"),
        now: NOW,
      }),
    );
    expect(error.code).toBe("CONFLICT");
    expect(error.message).toMatch(/changed somewhere else/);
    expect(store.snapshot()["1-projects/context-lc.md"]).toBe("# Theirs\n");
  });

  test("the conflict carries the current etag, so the console can offer to reload", async () => {
    const store = bucket();
    const first = await readFile(store, { path: "1-projects/context-lc.md", clearance: clearanceOf("private") });
    await writeFile(store, {
      path: first.path,
      text: "# Theirs\n",
      expectedEtag: first.etag,
      clearance: clearanceOf("private"),
      now: NOW,
    });
    const error = await capture(() =>
      writeFile(store, {
        path: first.path,
        text: "# Mine\n",
        expectedEtag: first.etag,
        clearance: clearanceOf("private"),
        now: NOW,
      }),
    );
    const current = await readFile(store, { path: first.path, clearance: clearanceOf("private") });
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
    const first = await readFile(store, { path: "1-projects/context-lc.md", clearance: clearanceOf("private") });
    const theirs = await writeFile(store, {
      path: first.path,
      text: "# Theirs\n",
      expectedEtag: first.etag,
      clearance: clearanceOf("private"),
      now: NOW,
    });
    expect(theirs.conflictCheck).toBe("read-compare");

    const error = await capture(() =>
      writeFile(store, {
        path: first.path,
        text: "# Mine\n",
        expectedEtag: first.etag,
        clearance: clearanceOf("private"),
        now: NOW,
      }),
    );
    expect(error.code).toBe("CONFLICT");
    expect(store.snapshot()["1-projects/context-lc.md"]).toBe("# Theirs\n");
  });

  test("a conditional backend says so, so the console does not have to guess", async () => {
    const store = bucket();
    const read = await readFile(store, { path: "1-projects/context-lc.md", clearance: clearanceOf("private") });
    const written = await writeFile(store, {
      path: read.path,
      text: "# Edited\n",
      expectedEtag: read.etag,
      clearance: clearanceOf("private"),
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
        clearance: clearanceOf("private"),
        now: NOW,
      }),
    );
    expect(error.code).toBe("CONFLICT");
    expect(store.snapshot()["1-projects/context-lc.md"]).toContain("# Context.LC");
  });

  test("saving a note somebody else deleted is a conflict, not a resurrection", async () => {
    const store = bucket();
    const read = await readFile(store, { path: "1-projects/context-lc.md", clearance: clearanceOf("private") });
    await store.delete(read.path);
    const error = await capture(() =>
      writeFile(store, {
        path: read.path,
        text: "# Mine\n",
        expectedEtag: read.etag,
        clearance: clearanceOf("private"),
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
        clearance: clearanceOf("private"),
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
        clearance: clearanceOf("private"),
        now: NOW,
      }),
    );
    expect(error.code).toBe("PATH_INVALID");
  });

  test("an oversized note is refused, and the message does not quote it", async () => {
    const store = bucket();
    const huge = "x".repeat(2_000_001);
    const error = await capture(() =>
      writeFile(store, { path: "1-projects/huge.md", text: huge, clearance: clearanceOf("private"), now: NOW }),
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
        clearance: clearanceOf("team"),
        now: NOW,
      }),
    );
    expect(error.code).toBe("FILE_NOT_FOUND");
    expect(store.snapshot()["2-areas/sneaky.md"]).toBeUndefined();
  });
});

