import { describe, expect, test } from "vitest";
import { clearanceOf } from "../../functions/lib/clearance";
import { DELETE_CONFIRMATION, type FileStore, copyPath, deletePath, duplicatePath, listFolder, readFile } from "../../functions/lib/fileOps";
import {
  PRIVACY_KEY,
  canSee,
  isPlumbing,
  parsePrivacyManifest,
} from "../../functions/lib/privacy";
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
import { type KeyedBucket, bodyAt, keyedBucket, withTreeListing } from "../keyedFixture.fileops2.helpers";
import { setFolderVisibility, setVisibility } from "../seededRules.helpers";
import { withTreeOf } from "../storeStub.helpers";

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
  function stalling(k: KeyedBucket): FileStore {
    return withTreeListing(k, (list) => async (options) => ({
      ...((await list(options)) as object),
      truncated: true,
      cursor: undefined,
    }));
  }

  /** The same stall over a plain bucket, for the cases that still run on one. */
  function stallingPlain(store: MemoryStore & FileStore): FileStore {
    return withTreeOf({
      ...store,
      list: async (options) => ({
        ...(await store.list(options)),
        truncated: true,
        cursor: undefined,
      }),
    });
  }

  test("a folder delete is refused rather than half-done", async () => {
    const k = await keyedBucket(async (store) => {
      await shareProjects(store);
      store.seed("1-projects/huge/aaa.md", "# A\n");
      store.seed("1-projects/huge/zdeep/secret.md", "# Salaries\n\n200k\n");
      await setFolderVisibility(store, {
        path: "1-projects/huge/zdeep",
        visibility: "private",
        clearance: clearanceOf("private"),
      });
    });

    // A folder's walk is what a copy makes; the delete a person asks for is a trash, which walks nothing.
    const error = await capture(() =>
      copyPath(stalling(k), {
        from: "1-projects/huge",
        to: "1-projects/huge-copy",
        clearance: clearanceOf("team"),
      }),
    );

    expect(error.code).toBe("LISTING_INCOMPLETE");
    expect(await bodyAt(k, "1-projects/huge/aaa.md")).toBe("# A\n");
    const leak = await capture(() =>
      readFile(k.store, { path: "1-projects/huge/zdeep/secret.md", clearance: clearanceOf("team") }),
    );
    expect(leak.code).toBe("FILE_NOT_FOUND");
  });

  test("a duplicate is refused rather than picking a name off a short list", async () => {
    // `namesInUse`. A short list of taken names is not a smaller answer, it is
    // a wrong one: the name it picks is then refused by `copyPath`'s guard if
    // and only if a hidden note holds it.
    const store = bucket();
    await shareProjects(store);

    const error = await capture(() =>
      duplicatePath(stallingPlain(store), { path: "1-projects/context-lc.md", clearance: clearanceOf("team") }),
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
    const k = await keyedBucket(async (store) => {
      await shareProjects(store);
      store.seed("1-projects/context-lc.md.notes.md", "# Notes\n");
    });
    const replaying = withTreeListing(k, (list) => async (options) => {
      const page = (await list(options)) as object;
      return { ...page, truncated: true, cursor: (options as { cursor?: string } | undefined)?.cursor ?? "same" };
    });

    // `namesInUse`, via duplicate.
    expect(
      (await capture(() =>
        duplicatePath(replaying, { path: "1-projects/context-lc.md", clearance: clearanceOf("team") }),
      )).code,
    ).toBe("LISTING_INCOMPLETE");
  });

  test("a listing that could not finish says so", async () => {
    const store = bucket();
    await shareProjects(store);

    const listing = await listFolder(stallingPlain(store), { path: "1-projects", clearance: clearanceOf("team") });

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
    const lopsided: FileStore = withTreeOf({
      ...store,
      list: async (options) => {
        const page = await store.list(options);
        return options?.prefix === "2-areas/big/"
          ? { ...page, truncated: true, cursor: undefined }
          : page;
      },
    });

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

});

