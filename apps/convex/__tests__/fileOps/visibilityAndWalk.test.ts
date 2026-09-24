import { describe, expect, test } from "vitest";
import { clearanceOf } from "../../functions/lib/clearance";
import {
  DELETE_CONFIRMATION,
  type FileStore,
  copyPath,
  deletePath,
  duplicatePath,
  listFolder,
  readFile,
  resetPrivacyManifest,
  setFolderVisibility,
  setVisibility,
} from "../../functions/lib/fileOps";
import {
  PRIVACY_KEY,
  canSee,
  isPlumbing,
  parsePrivacyManifest,
} from "../../functions/lib/privacy";
import { renderPrivacyManifest } from "../../functions/lib/scaffold";
import { gatewayInternals } from "../gatewayFormat.helpers";
import {
  type MemoryStore,
  memoryStore,
} from "../storeStub.helpers";
import {
  NOW,
  bucket,
  historyKeys,
  shareProjects,
  capture,
  errorShape,
  names,
} from "./fixtures.helpers";

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
      clearance: clearanceOf("private"),
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
      clearance: clearanceOf("private"),
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
      setVisibility(store, { path: "1-projects", visibility: "team", clearance: clearanceOf("private") }),
    );
    expect(error.code).toBe("PATH_INVALID");
    expect(error.message).toMatch(/folder's default/);
  });

  test("privacy.md cannot be given a visibility of its own", async () => {
    const store = bucket();
    const error = await capture(() =>
      setVisibility(store, { path: PRIVACY_KEY, visibility: "team", clearance: clearanceOf("private") }),
    );
    expect(error.code).toBe("PRIVACY_MANIFEST_READ_ONLY");
  });

  test("a bucket with no manifest says so instead of inventing one", async () => {
    const store = memoryStore() as MemoryStore & FileStore;
    store.seed("1-projects/a.md", "# A\n");
    const error = await capture(() =>
      setVisibility(store, { path: "1-projects/a.md", visibility: "team", clearance: clearanceOf("private") }),
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
        clearance: clearanceOf("private"),
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
      clearance: clearanceOf("private"),
    });
    const listing = await listFolder(store, { path: "2-areas", clearance: clearanceOf("private") });
    expect(listing.folderDefault).toBe("team");
    expect(listing.entries.every((entry) => entry.exception === false)).toBe(true);
    expect(names(await listFolder(store, { path: "2-areas", clearance: clearanceOf("team") }).then((l) => l.entries))).toContain(
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
          clearance: clearanceOf("private"),
        });
      }
      return object;
    };

    await setFolderVisibility(store, {
      path: "1-projects",
      visibility: "team",
      clearance: clearanceOf("private"),
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
    expect((await listFolder(store, { path: "", clearance: clearanceOf("private") })).manifestUsable).toBe(false);

    await resetPrivacyManifest(store, { clearance: clearanceOf("private"), now: NOW });

    expect((await listFolder(store, { path: "", clearance: clearanceOf("private") })).manifestUsable).toBe(true);
  });

  test("what it writes parses, and the gateway agrees that it does", async () => {
    const store = brokenBucket();
    await resetPrivacyManifest(store, { clearance: clearanceOf("private"), now: NOW });

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

    const result = await resetPrivacyManifest(store, { clearance: clearanceOf("private"), now: NOW });

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
    await resetPrivacyManifest(store, { clearance: clearanceOf("private"), now: NOW });

    const parsed = parsePrivacyManifest(store.snapshot()[PRIVACY_KEY]);
    expect(parsed.rules.every((rule) => rule.vis === "private")).toBe(true);
    expect(parsed.overrides.size).toBe(0);
    // The observable consequence, which is the assertion that matters: a
    // team-scoped caller could see nothing before the repair and can see
    // nothing after it.
    expect((await listFolder(store, { path: "", clearance: clearanceOf("team") })).entries).toEqual([]);
  });

  test("plumbing folders never reach the manifest, which would make it unparseable", async () => {
    const store = brokenBucket();
    store.seed(".obsidian/workspace.json", "{}\n");

    const result = await resetPrivacyManifest(store, { clearance: clearanceOf("private"), now: NOW });

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

    const result = await resetPrivacyManifest(store, { clearance: clearanceOf("private"), now: NOW });

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

    await resetPrivacyManifest(store, { clearance: clearanceOf("private"), now: NOW });

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
    expect((await listFolder(store, { path: "", clearance: clearanceOf("team") })).entries).toEqual([]);
  });

  test("a complete walk of ordinary folders is not reported as partial", async () => {
    const store = brokenBucket();
    const result = await resetPrivacyManifest(store, { clearance: clearanceOf("private"), now: NOW });
    expect(result.partial).toBe(false);
  });

  test("the unreadable file is kept, so a typo does not cost forty rules", async () => {
    const store = brokenBucket();
    const original = store.snapshot()[PRIVACY_KEY];

    const result = await resetPrivacyManifest(store, { clearance: clearanceOf("private"), now: NOW });

    expect(result.backedUpTo).not.toBeNull();
    // `.context/recover/`, not `.history/`: this is the one copy the product
    // still keeps for somebody, and it is deliberately not filed with the
    // snapshot system that no longer exists.
    expect(result.backedUpTo!.startsWith(".context/recover/")).toBe(true);
    expect(store.snapshot()[result.backedUpTo!]).toBe(original);
    // And it is plumbing by the same rule everything else is: a dot-prefixed
    // segment, so both privacy engines refuse it without being told about it.
    expect(isPlumbing(result.backedUpTo!)).toBe(true);
  });

  test("a bucket with no manifest at all is repaired, and has nothing to keep", async () => {
    const store = memoryStore() as MemoryStore & FileStore;
    store.seed("1-projects/a.md", "# A\n");

    const result = await resetPrivacyManifest(store, { clearance: clearanceOf("private"), now: NOW });

    expect(result.backedUpTo).toBeNull();
    expect(historyKeys(store)).toEqual([]);
    // And the thing that was impossible a moment ago now works.
    await setFolderVisibility(store, { path: "1-projects", visibility: "team", clearance: clearanceOf("private") });
    expect(parsePrivacyManifest(store.snapshot()[PRIVACY_KEY]).rules).toContainEqual({
      prefix: "1-projects",
      vis: "team",
    });
  });

  test("a missing manifest repair loses to a concurrent conditional create", async () => {
    const store = memoryStore({ conditional: true }) as MemoryStore & FileStore;
    store.seed("1-projects/a.md", "# A\n");
    const winner = renderPrivacyManifest("para");
    const realPut = store.put.bind(store);
    let raced = false;
    store.put = async (key, body, options) => {
      if (key === PRIVACY_KEY && options?.onlyIf?.absent === true && !raced) {
        raced = true;
        // A second repair (or a direct provider writer) wins the one absent
        // slot before this invocation's create reaches the backend. The first
        // writer must surface a conflict and leave the winner byte-for-byte.
        expect(await realPut(key, winner, { onlyIf: { absent: true } })).not.toBeNull();
      }
      return realPut(key, body, options);
    };

    const error = await capture(() =>
      resetPrivacyManifest(store, { clearance: clearanceOf("private"), now: NOW }),
    );

    expect(error.code).toBe("CONFLICT");
    expect(store.snapshot()[PRIVACY_KEY]).toBe(winner);
  });

  test("a manifest that parses is refused — this is not a way to flatten one", async () => {
    const store = bucket();
    await shareProjects(store);
    const before = store.snapshot()[PRIVACY_KEY];

    const error = await capture(() => resetPrivacyManifest(store, { clearance: clearanceOf("private"), now: NOW }));

    expect(error.code).toBe("PRIVACY_MANIFEST_USABLE");
    expect(store.snapshot()[PRIVACY_KEY]).toBe(before);
    expect(historyKeys(store).some((key) => key.includes(PRIVACY_KEY))).toBe(false);
  });

  test("a team-scoped caller cannot rewrite the access map that governs them", async () => {
    const store = brokenBucket();
    const before = store.snapshot()[PRIVACY_KEY];

    const error = await capture(() => resetPrivacyManifest(store, { clearance: clearanceOf("team"), now: NOW }));

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

    const error = await capture(() => resetPrivacyManifest(store, { clearance: clearanceOf("private"), now: NOW }));

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
      clearance: clearanceOf("private"),
    });

    const error = await capture(() =>
      deletePath(stalling(store), {
        path: "1-projects/huge",
        clearance: clearanceOf("team"),
        confirmation: DELETE_CONFIRMATION,
      }),
    );

    expect(error.code).toBe("LISTING_INCOMPLETE");
    expect(store.snapshot()["1-projects/huge/aaa.md"]).toBeDefined();
    const leak = await capture(() =>
      readFile(store, { path: "1-projects/huge/zdeep/secret.md", clearance: clearanceOf("team") }),
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
        clearance: clearanceOf("team"),
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
      duplicatePath(stalling(store), { path: "1-projects/context-lc.md", clearance: clearanceOf("team") }),
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
        duplicatePath(replaying, { path: "1-projects/context-lc.md", clearance: clearanceOf("team") }),
      )).code,
    ).toBe("LISTING_INCOMPLETE");

    // `namesExtending`, via a single-file delete.
    expect(
      (await capture(() =>
        deletePath(replaying, {
          path: "1-projects/context-lc.md",
          clearance: clearanceOf("team"),
          confirmation: DELETE_CONFIRMATION,
        }),
      )).code,
    ).toBe("LISTING_INCOMPLETE");
  });

  test("a listing that could not finish says so", async () => {
    const store = bucket();
    await shareProjects(store);

    const listing = await listFolder(stalling(store), { path: "1-projects", clearance: clearanceOf("team") });

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
      duplicatePath(lopsided, { path: "2-areas/big/x.md", clearance: clearanceOf("team") }),
    );
    const small = await capture(() =>
      duplicatePath(lopsided, { path: "2-areas/small/x.md", clearance: clearanceOf("team") }),
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
      const viaDuplicate = await capture(() => duplicatePath(store, { path, clearance: clearanceOf(scope) }));
      const viaCopy = await capture(() =>
        copyPath(store, { from: path, to: "1-projects/anywhere.md", clearance: clearanceOf(scope) }),
      );
      expect(errorShape(viaDuplicate)).toBe(errorShape(viaCopy));
    }
  });

  test("a manifest repair that could not see every folder is partial", async () => {
    const store = bucket();
    store.seed(PRIVACY_KEY, "# broken\n");

    const result = await resetPrivacyManifest(stalling(store), { clearance: clearanceOf("private"), now: NOW });

    // The folders it did see still get their `private` line — a folder it
    // missed inherits `default_visibility: private`, so the repair still fails
    // closed. What must not happen is the short list being reported complete.
    expect(result.partial).toBe(true);
  });
});

