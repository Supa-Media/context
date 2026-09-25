/**
 * WHAT THE OFFLINE MIRROR IS FED.
 *
 * The app keeps every note its person can see on the device, the way Apple
 * Notes or Obsidian does. Three things on the server make that possible, and
 * each has one property that a tidier version would lose:
 *
 *  - **`syncManifest`** enumerates everything the caller may see, recursively,
 *    with the store's own etag per object — so a sync compares versions
 *    without reading a single note. It is filtered by the *same* `canSee` every
 *    read uses, and its resume cursor is a path the caller was given, never the
 *    store's continuation token (which is base64 of the last backend key, and
 *    that key can be a note the caller may not see).
 *  - **`readFiles`** reads a batch through `readFile`'s own internals. A path
 *    the caller may not see and a path that does not exist answer
 *    byte-identically, exactly as a single read does.
 *  - **`writeFile`'s create** — no `expectedEtag` — is made atomic with
 *    `onlyIf: { absent: true }` where the binding proved it can do that, so a
 *    new note queued offline cannot clobber one created elsewhere meanwhile.
 *
 * Against the in-memory bucket, with no credential, no workspace and no
 * session; `files.test.ts` proves the same three through the real actions.
 */

import { describe, expect, test } from "vitest";
import { clearanceOf } from "../functions/lib/clearance";
import { memoryStore, type MemoryStore } from "./storeStub.helpers";
import {
  FileOpError,
  type FileStore,
  listFolder,
  MANIFEST_PAGE_ENTRIES,
  MANIFEST_PAGE_FOLDERS,
  READ_BATCH_BYTES,
  READ_BATCH_PATHS,
  type SyncManifest,
  readFile,
  readFiles,
  setFolderVisibility,
  setVisibility,
  syncManifest,
  writeFile,
} from "../functions/lib/fileOps";
import { PRIVACY_KEY, type Visibility } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";

const NOW = 1_800_000_000_000;
const OWNER = clearanceOf("private");
const TEAM = clearanceOf("team");

/** Private paths in the fixture. None may appear anywhere a team reader looks. */
const HIDDEN = ["1-projects/pay.md", "2-areas/health.md", "2-areas/README.md", PRIVACY_KEY];

/**
 * A PARA bucket with `1-projects` shared, one note held back inside it, a
 * private folder, and the plumbing a manifest must never surface.
 */
async function bucket(
  options: Parameters<typeof memoryStore>[0] = {},
): Promise<MemoryStore & FileStore> {
  const store = memoryStore(options) as MemoryStore & FileStore;
  store.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  store.seed("index.md", "# Context\n");
  store.seed("1-projects/README.md", "# Projects\n");
  store.seed("1-projects/context-lc.md", "# Context.LC\n\nnotes\n");
  store.seed("1-projects/deep/nested/plan.md", "# Plan\n");
  store.seed("1-projects/pay.md", "# Pay\n\nsalaries\n");
  store.seed("2-areas/README.md", "# Areas\n");
  store.seed("2-areas/health.md", "# Health\n");
  store.seed(".history/1-projects/pay.md.old.md", "# older\n");
  store.seed(".context/audit/2026-09.jsonl", "{}\n");
  store.seed(".audit/legacy.jsonl", "{}\n");
  store.seed(".obsidian/app.json", "{}\n");
  await setFolderVisibility(store, { path: "1-projects", visibility: "team", clearance: OWNER });
  await setVisibility(store, { path: "1-projects/pay.md", visibility: "private", clearance: OWNER });
  return store;
}

/** Every object read, so a test can prove the manifest reads no note. */
function countingGets(store: MemoryStore & FileStore): string[] {
  const gets: string[] = [];
  const get = store.get.bind(store);
  store.get = async (key: string) => {
    gets.push(key);
    return get(key);
  };
  return gets;
}

/**
 * Make the store answer in pages of `size` keys, whatever was asked for — so
 * one manifest call follows the store's own continuation token across several
 * pages, and that token (the last *backend* key of a page, as on real S3) is
 * sitting right there for a careless cursor to hand back.
 */
function smallPages(store: MemoryStore & FileStore, size: number): void {
  const list = store.list.bind(store);
  store.list = async (options) => list({ ...options, limit: size });
}

/** Walk a manifest to its end, the way the client will. */
async function everyPage(
  store: FileStore,
  clearance: ReturnType<typeof clearanceOf>,
  pageEntries: number,
): Promise<SyncManifest[]> {
  const pages: SyncManifest[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 50; guard += 1) {
    const page = await syncManifest(store, { clearance, cursor, pageEntries });
    pages.push(page);
    if (page.cursor === null) return pages;
    cursor = page.cursor;
  }
  throw new Error("the manifest never ended");
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

/* -------------------------------------------------------------------------- */
/*                                the manifest                                */
/* -------------------------------------------------------------------------- */

describe("the sync manifest", () => {
  test("default pages stay below Convex's 8,192-element return limit", async () => {
    const store = memoryStore() as MemoryStore & FileStore;
    store.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
    for (let index = 0; index < 8_200; index += 1) {
      store.seed(`bulk/note-${String(index).padStart(5, "0")}.md`, "# Note\n");
    }

    const pages: SyncManifest[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await syncManifest(store, { clearance: OWNER, cursor });
      pages.push(page);
      expect(page.entries.length).toBeLessThan(8_192);
      expect(page.folders.length).toBeLessThan(8_192);
      if (page.cursor === null) break;
      cursor = page.cursor;
    }

    expect(MANIFEST_PAGE_ENTRIES).toBeLessThan(8_192);
    expect(MANIFEST_PAGE_FOLDERS).toBeLessThan(8_192);
    expect(pages).toHaveLength(3);
    expect(pages.flatMap((page) => page.entries)).toHaveLength(8_201);
    expect(pages.at(-1)?.truncated).toBe(false);
  });

  test("an owner gets every file, recursively, with the etag a read would return", async () => {
    const store = await bucket();
    const manifest = await syncManifest(store, { clearance: OWNER });

    expect(manifest.entries.map((entry) => entry.path).sort()).toEqual(
      [
        "1-projects/README.md",
        "1-projects/context-lc.md",
        "1-projects/deep/nested/plan.md",
        "1-projects/pay.md",
        "2-areas/README.md",
        "2-areas/health.md",
        "index.md",
        PRIVACY_KEY,
      ].sort(),
    );
    expect(manifest.cursor).toBeNull();
    expect(manifest.truncated).toBe(false);
    expect(manifest.manifestUsable).toBe(true);

    for (const entry of manifest.entries) {
      const read = await readFile(store, { path: entry.path, clearance: OWNER });
      expect(entry.etag).toBe(read.etag);
      expect(entry.size).toBe(store.objects.get(entry.path)!.body.length);
      expect(entry.visibility).toBe(read.visibility);
      expect(entry.exception).toBe(read.exception);
    }
    // `privacy.md` is the owner's to see, and never to type into — the same
    // flag a listing and a read carry.
    expect(manifest.entries.find((entry) => entry.path === PRIVACY_KEY)?.readOnly).toBe(true);
    expect(manifest.entries.find((entry) => entry.path === "1-projects/pay.md")?.exception).toBe(true);
  });

  test("Context's own plumbing is never part of it, even for an owner", async () => {
    const store = await bucket();
    const rendered = JSON.stringify(await syncManifest(store, { clearance: OWNER }));
    for (const plumbing of [".history/", ".context/", ".audit/", ".obsidian/"]) {
      expect(rendered).not.toContain(plumbing);
    }
  });

  test("it reads no note to learn a version — only privacy.md", async () => {
    const store = await bucket();
    const gets = countingGets(store);
    await syncManifest(store, { clearance: OWNER });
    expect(gets).toEqual([PRIVACY_KEY]);
  });

  test("a team reader gets only what is shared, and nothing of a private note — not its path, etag or size", async () => {
    const store = await bucket();
    const manifest = await syncManifest(store, { clearance: TEAM });

    expect(manifest.entries.map((entry) => entry.path).sort()).toEqual([
      "1-projects/README.md",
      "1-projects/context-lc.md",
      "1-projects/deep/nested/plan.md",
    ]);
    const rendered = JSON.stringify(manifest);
    for (const hidden of HIDDEN) {
      expect(rendered).not.toContain(hidden);
      // The etag is the other half of "exists": a manifest that dropped the
      // path and kept the version would still say how many private notes
      // there are and when each changed.
      expect(rendered).not.toContain(`"${store.objects.get(hidden)!.etag}"`);
    }
    // Non-vacuity: the owner's manifest over the same bucket does carry them.
    const owners = JSON.stringify(await syncManifest(store, { clearance: OWNER }));
    for (const hidden of HIDDEN) expect(owners).toContain(hidden);
  });

  test("a note pointed at a group reaches a reader who answers to it, and nobody else at team", async () => {
    const store = await bucket();
    await setVisibility(store, {
      path: "1-projects/context-lc.md",
      visibility: "@supa-leads" as Visibility,
      clearance: OWNER,
    });
    const paths = async (clearance: ReturnType<typeof clearanceOf>) =>
      (await syncManifest(store, { clearance })).entries.map((entry) => entry.path);
    expect(await paths(clearanceOf("team", ["@supa-leads"]))).toContain("1-projects/context-lc.md");
    expect(await paths(TEAM)).not.toContain("1-projects/context-lc.md");
  });

  test("an unreadable privacy.md fails closed, and says so", async () => {
    const store = await bucket();
    store.seed(PRIVACY_KEY, "# somebody broke the block\n");
    const manifest = await syncManifest(store, { clearance: TEAM });
    expect(manifest.entries).toEqual([]);
    expect(manifest.manifestUsable).toBe(false);
  });

  describe("paging", () => {
    test("pages join into the whole manifest, and each cursor is the last path that page returned", async () => {
      const store = await bucket();
      const whole = await syncManifest(store, { clearance: OWNER });
      smallPages(store, 2);
      const pages = await everyPage(store, OWNER, 3);

      expect(pages.length).toBeGreaterThan(1);
      expect(pages.flatMap((page) => page.entries)).toEqual(whole.entries);
      for (const page of pages.slice(0, -1)) {
        expect(page.entries).toHaveLength(3);
        expect(page.cursor).toBe(page.entries.at(-1)!.path);
        expect(page.truncated).toBe(false);
      }
    });

    /**
     * The attack this shape exists for. The store's continuation token is the
     * last *backend* key of a page — the stub, like real S3, makes it exactly
     * that — and at `team` scope that key is often a private note. A manifest
     * that handed the token back would name one private path per page.
     */
    test("a team reader's cursor is always a path they were given, never a hidden one", async () => {
      const store = await bucket();
      // Three keys a page puts `2-areas/README.md` — private — at the end of
      // the page that also holds the last shared note.
      smallPages(store, 3);
      const pages = await everyPage(store, TEAM, 1);
      const given = new Set(pages.flatMap((page) => page.entries.map((entry) => entry.path)));

      expect(pages.flatMap((page) => page.entries.map((entry) => entry.path))).toEqual([
        "1-projects/README.md",
        "1-projects/context-lc.md",
        "1-projects/deep/nested/plan.md",
      ]);
      for (const page of pages) {
        if (page.cursor !== null) expect(given.has(page.cursor)).toBe(true);
        const rendered = JSON.stringify(page);
        for (const hidden of HIDDEN) expect(rendered).not.toContain(hidden);
      }
    });

    test("resuming asks the store for what comes after the cursor, not the whole bucket again", async () => {
      const store = await bucket();
      const lists: Array<Record<string, unknown>> = [];
      const list = store.list.bind(store);
      store.list = async (options) => {
        lists.push({ ...options });
        return list(options);
      };
      await syncManifest(store, { clearance: OWNER, cursor: "1-projects/pay.md" });
      expect(lists[0]).toMatchObject({ prefix: "", startAfter: "1-projects/pay.md" });
    });

    test("a store that ignores the resume point is reported short, never replayed as the rest", async () => {
      const store = await bucket({ ignoreStartAfter: true });
      const first = await syncManifest(store, { clearance: OWNER, pageEntries: 3 });
      expect(first.cursor).not.toBeNull();

      const second = await syncManifest(store, {
        clearance: OWNER,
        cursor: first.cursor!,
        pageEntries: 3,
      });
      // It started from the top again. Handing that back under a cursor that
      // promised "the rest" would loop the client forever — so it stops, says
      // the manifest is a floor, and offers no cursor to follow.
      expect(second.entries).toEqual([]);
      expect(second.cursor).toBeNull();
      expect(second.truncated).toBe(true);
    });

    test("a store that does not list in key order gets no cursor at all", async () => {
      const store = await bucket();
      const list = store.list.bind(store);
      // Dropbox's recursive `list_folder` promises no order, and a "last path"
      // is only a position in a listing that has one.
      store.list = async (options) => {
        const page = await list(options);
        return { ...page, objects: [...page.objects].reverse() };
      };
      const complete = await syncManifest(store, { clearance: OWNER });
      expect(complete.truncated).toBe(false);
      expect(complete.entries).toHaveLength(8);

      const short = await syncManifest(store, { clearance: OWNER, pageEntries: 3 });
      expect(short.cursor).toBeNull();
      expect(short.truncated).toBe(true);
    });

    test("a cursor is a path, and one that is not is refused", async () => {
      const store = await bucket();
      const refused = await capture(() =>
        syncManifest(store, { clearance: OWNER, cursor: "1-projects/../2-areas" }),
      );
      expect(refused.code).toBe("PATH_INVALID");
    });
  });
});

/* -------------------------------------------------------------------------- */
/*                         the folders in the manifest                        */
/* -------------------------------------------------------------------------- */

/**
 * Every folder row and folder default the tree would draw, by walking
 * `listFolder` down from the root — the answer the manifest's `folders` must
 * give without a listing per folder.
 */
async function foldersByListing(
  store: FileStore,
  clearance: ReturnType<typeof clearanceOf>,
): Promise<Map<string, Visibility>> {
  const found = new Map<string, Visibility>();
  const queue = [""];
  while (queue.length > 0) {
    const folder = queue.shift()!;
    const listing = await listFolder(store, { path: folder, clearance });
    found.set(folder, listing.folderDefault);
    for (const entry of listing.entries) {
      if (entry.kind !== "folder") continue;
      // The row's badge and the folder's own default are one word.
      expect(entry.visibility).toBe(
        (await listFolder(store, { path: entry.path, clearance })).folderDefault,
      );
      queue.push(entry.path);
    }
  }
  return found;
}

function foldersOf(pages: readonly SyncManifest[]): Map<string, Visibility> {
  const found = new Map<string, Visibility>();
  for (const page of pages) for (const folder of page.folders) found.set(folder.path, folder.visibility);
  return found;
}

describe("the manifest names the folders, so the tree needs no listing per folder", () => {
  const readers = {
    owner: OWNER,
    team: TEAM,
    "a group member": clearanceOf("team", ["@supa-leads"]),
  };

  for (const [who, clearance] of Object.entries(readers)) {
    test(`for ${who}, exactly the folders and defaults walking listFolder would draw`, async () => {
      const store = await bucket();
      // A folder shared only with a group, under a private parent: a team
      // reader must not see it, a group member must, and the private parent
      // must appear for the member only because something under it reaches
      // them.
      store.seed("2-areas/leads/brief.md", "# Brief\n");
      await setFolderVisibility(store, {
        path: "2-areas/leads",
        visibility: "@supa-leads" as Visibility,
        clearance: OWNER,
      });
      // An empty folder a tool made with a marker key.
      store.seed("1-projects/empty/", "");
      // A shared folder whose only note is held back: listFolder still draws
      // the folder, so the manifest has to, although no entry lives in it.
      store.seed("1-projects/held/secret.md", "# Secret\n");
      await setVisibility(store, { path: "1-projects/held/secret.md", visibility: "private", clearance: OWNER });

      const expected = await foldersByListing(store, clearance);
      expect(foldersOf([await syncManifest(store, { clearance })])).toEqual(expected);

      // And across pages, however small.
      smallPages(store, 2);
      expect(foldersOf(await everyPage(store, clearance, 2))).toEqual(expected);
    });
  }

  test("a team reader is named no private folder, not even through a page boundary", async () => {
    const store = await bucket();
    smallPages(store, 1);
    const pages = await everyPage(store, TEAM, 1);
    const rendered = JSON.stringify(pages.map((page) => page.folders));
    expect(rendered).not.toContain("2-areas");
    // Non-vacuity: the owner is.
    expect(JSON.stringify((await syncManifest(store, { clearance: OWNER })).folders)).toContain(
      "2-areas",
    );
  });

  test("an empty folder made with a marker key is named, although no note lives in it", async () => {
    const store = await bucket();
    store.seed("1-projects/empty/", "");
    const folders = (await syncManifest(store, { clearance: TEAM })).folders.map((folder) => folder.path);
    expect(folders).toContain("1-projects/empty");
  });
});

/* -------------------------------------------------------------------------- */
/*                               the batched read                             */
/* -------------------------------------------------------------------------- */

describe("reading a batch of notes", () => {
  test("a visible note comes back exactly as a single read returns it", async () => {
    const store = await bucket();
    const [result] = await readFiles(store, {
      paths: ["1-projects/context-lc.md"],
      clearance: TEAM,
    });
    expect(result).toEqual({
      path: "1-projects/context-lc.md",
      outcome: "read",
      note: await readFile(store, { path: "1-projects/context-lc.md", clearance: TEAM }),
    });
  });

  test("hidden and missing answer byte-identically, in a batch beside a note that reads", async () => {
    const store = await bucket();
    const results = await readFiles(store, {
      paths: ["1-projects/context-lc.md", "1-projects/pay.md", "1-projects/never-was.md", PRIVACY_KEY],
      clearance: TEAM,
    });

    expect(results.map((result) => result.outcome)).toEqual(["read", "error", "error", "error"]);
    const refusal = (index: number) => {
      const { path: _echoed, ...rest } = results[index] as { path: string };
      return JSON.stringify(rest);
    };
    expect(refusal(1)).toBe(refusal(2));
    expect(refusal(3)).toBe(refusal(2));
    expect(results[1]).toMatchObject({ code: "FILE_NOT_FOUND" });
    // And the refusal is the single read's refusal, word for word.
    const single = await capture(() =>
      readFile(store, { path: "1-projects/pay.md", clearance: TEAM }),
    );
    expect(results[1]).toMatchObject({ code: single.code, message: single.message });
    expect(JSON.stringify(results)).not.toContain("salaries");
  });

  test("a hidden note is never fetched from the bucket at all", async () => {
    const store = await bucket();
    const gets = countingGets(store);
    await readFiles(store, { paths: ["1-projects/pay.md", "2-areas/health.md"], clearance: TEAM });
    expect(gets).toEqual([PRIVACY_KEY]);
  });

  test("the owner reads the same private note the team reader was refused", async () => {
    const store = await bucket();
    const [result] = await readFiles(store, { paths: ["1-projects/pay.md"], clearance: OWNER });
    expect(result).toMatchObject({ outcome: "read", note: { text: "# Pay\n\nsalaries\n" } });
  });

  test("an unaddressable path is refused for itself and the rest of the batch still reads", async () => {
    const store = await bucket();
    const results = await readFiles(store, {
      paths: ["../escape.md", "1-projects/context-lc.md"],
      clearance: TEAM,
    });
    expect(results[0]).toMatchObject({ path: "../escape.md", outcome: "error", code: "PATH_INVALID" });
    expect(results[1]).toMatchObject({ outcome: "read" });
  });

  test(`more than ${READ_BATCH_PATHS} paths is refused before the bucket is asked anything`, async () => {
    const store = await bucket();
    const gets = countingGets(store);
    const paths = Array.from({ length: READ_BATCH_PATHS + 1 }, (_, index) => `1-projects/n${index}.md`);
    const refused = await capture(() => readFiles(store, { paths, clearance: TEAM }));
    expect(refused.code).toBe("BATCH_TOO_LARGE");
    expect(gets).toEqual([]);

    // The cap itself is allowed.
    const atCap = await readFiles(store, { paths: paths.slice(0, READ_BATCH_PATHS), clearance: TEAM });
    expect(atCap).toHaveLength(READ_BATCH_PATHS);
  });

  test("past the byte budget the rest is deferred, and the first note always reads", async () => {
    const store = await bucket();
    const big = "x".repeat(Math.ceil(READ_BATCH_BYTES / 2) + 1);
    store.seed("1-projects/big-a.md", big);
    store.seed("1-projects/big-b.md", big);
    store.seed("1-projects/big-c.md", big);
    const results = await readFiles(store, {
      paths: ["1-projects/big-a.md", "1-projects/big-b.md", "1-projects/pay.md", "1-projects/big-c.md"],
      clearance: TEAM,
    });
    expect(results.map((result) => result.outcome)).toEqual([
      "read",
      "deferred",
      // Deferred, not refused: once the budget is spent nothing further is
      // looked at, so a hidden path answers exactly as a missing one would.
      "deferred",
      "deferred",
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/*                        a create that must not clobber                      */
/* -------------------------------------------------------------------------- */

/**
 * Somebody else creates the same path between our existence read and our put
 * — an Obsidian sync, an AI client, a second device draining its own queue.
 */
function raceCreate(store: MemoryStore & FileStore, path: string, theirs: string): void {
  const get = store.get.bind(store);
  let raced = false;
  store.get = async (key: string) => {
    const result = await get(key);
    if (key === path && !raced) {
      raced = true;
      store.seed(path, theirs);
    }
    return result;
  };
}

describe("a create is atomic where the bucket can make it so", () => {
  test("on a bucket that honours onlyIf-absent, a create that lost the race is a conflict and theirs survives", async () => {
    const store = await bucket({ conditional: true });
    raceCreate(store, "1-projects/new.md", "# Theirs\n");

    const error = await capture(() =>
      writeFile(store, { path: "1-projects/new.md", text: "# Mine\n", clearance: TEAM, now: NOW }),
    );
    expect(error.code).toBe("CONFLICT");
    expect(error.currentEtag).toBe(store.objects.get("1-projects/new.md")!.etag);
    expect(store.snapshot()["1-projects/new.md"]).toBe("# Theirs\n");
  });

  test("and an uncontested create there says it was checked by the bucket", async () => {
    const store = await bucket({ conditional: true });
    const written = await writeFile(store, {
      path: "1-projects/new.md",
      text: "# Mine\n",
      clearance: TEAM,
      now: NOW,
    });
    expect(written.conflictCheck).toBe("conditional");
    expect(written.etag).toBe(store.objects.get("1-projects/new.md")!.etag);
  });

  test("an existing file is still a conflict with its etag, before any write is tried", async () => {
    const store = await bucket({ conditional: true });
    const error = await capture(() =>
      writeFile(store, { path: "1-projects/context-lc.md", text: "# Mine\n", clearance: TEAM, now: NOW }),
    );
    expect(error.code).toBe("CONFLICT");
    expect(error.currentEtag).toBe(store.objects.get("1-projects/context-lc.md")!.etag);
    expect(store.snapshot()["1-projects/context-lc.md"]).toBe("# Context.LC\n\nnotes\n");
  });

  /**
   * `conditionalWrite` is `If-Match`; `onlyIf: { absent }` is `If-None-Match`,
   * probed separately as `conditionalCreate`. A bucket proven for one and not
   * the other must not be trusted with the other: this stub accepts the
   * precondition and writes anyway, which is what an unproven bucket may do.
   */
  test("a bucket that has not proven onlyIf-absent gets a read-compare, and the write says so", async () => {
    const store = await bucket();
    expect(store.capabilities.conditionalWrite).toBe(true);
    expect(store.capabilities.conditionalCreate).toBeUndefined();

    const written = await writeFile(store, {
      path: "1-projects/new.md",
      text: "# Mine\n",
      clearance: TEAM,
      now: NOW,
    });
    expect(written.conflictCheck).toBe("read-compare");

    const error = await capture(() =>
      writeFile(store, { path: "1-projects/new.md", text: "# Again\n", clearance: TEAM, now: NOW }),
    );
    expect(error.code).toBe("CONFLICT");
    expect(error.currentEtag).toBe(written.etag);
  });
});
