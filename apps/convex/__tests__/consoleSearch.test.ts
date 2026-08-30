/**
 * THE CONSOLE'S SEARCH.
 *
 * `lib/fileOps.ts`'s `searchNotes` is the console asking the same question an
 * AI client asks through `search_notes`, and the point of these tests is that
 * it is the *same question*: the gateway's `searchIndexedNotes`, imported, over
 * this runtime's own `canSee`.
 *
 * What is asserted, and why:
 *
 *  - **A `team` caller cannot find a `private` note by its contents.** This is
 *    the whole risk of putting an index in front of the console. The index
 *    holds text drawn from private notes — fine, inside the customer's own
 *    bucket — and a search that let a member match against it would be a
 *    disclosure with no read involved. Sabotage-tested: the same corpus at
 *    `private` scope must find the note, or "team cannot see it" is being
 *    proven by a search that finds nothing at all.
 *  - **Counts are computed over visible matches.** "14 matches" over four
 *    visible hits is an existence oracle for the other ten — the subtraction
 *    the console's note census is owner-only to prevent.
 *  - **An unindexed bucket says so rather than answering "no matches".** A
 *    console that reports absence for a bucket nothing has read yet is the
 *    original bug with an index attached.
 */

import { describe, expect, test } from "vitest";
import { memoryStore, type MemoryStore } from "./storeStub.helpers";
import { type FileStore, searchNotes, setFolderVisibility, setVisibility } from "../functions/lib/fileOps";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";

/**
 * A bucket whose private half is the only place a distinctive word appears.
 *
 * The words are nonsense on purpose: a term that also occurs in the scaffold's
 * own README text would make "team cannot find it" true for the wrong reason.
 */
function bucket(): MemoryStore & FileStore {
  const store = memoryStore() as MemoryStore & FileStore;
  store.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  store.seed("index.md", "# Context\n");
  store.seed("1-projects/README.md", "# Projects\n");
  store.seed("1-projects/shared-plan.md", "# Shared plan\n\nThe quokkaplan ships in March.\n");
  store.seed("1-projects/pay.md", "# Pay\n\nThe wallabyrate is confidential.\n");
  store.seed("2-areas/README.md", "# Areas\n");
  store.seed("2-areas/health.md", "# Health\n\nA quokkaplan review each spring.\n");
  return store;
}

/** Share `1-projects`, holding one note back as an exception. */
async function shareProjects(store: FileStore): Promise<void> {
  await setFolderVisibility(store, { path: "1-projects", visibility: "team", scope: "private" });
  await setVisibility(store, { path: "1-projects/pay.md", visibility: "private", scope: "private" });
}

/**
 * Run searches until the index has caught up, the way a real surface does —
 * each call syncs a further pass. Bounded so a genuinely stuck backfill fails
 * the test rather than hanging it.
 */
async function settled(
  store: FileStore,
  options: { query: string; prefix?: string; scope: "private" | "team" },
) {
  let result = await searchNotes(store, options);
  for (let pass = 0; pass < 10 && (result.indexMissing || result.indexIncomplete); pass += 1) {
    result = await searchNotes(store, options);
  }
  return result;
}

describe("the console's search", () => {
  test("finds a note by its contents, not by its filename", async () => {
    const store = bucket();
    const found = await settled(store, { query: "quokkaplan", scope: "private" });

    expect(found.indexMissing).toBe(false);
    // The word is in the body of both notes and in the name of neither, which
    // is the case the old palette could not answer at all.
    expect(found.hits.map((hit) => hit.path).sort()).toEqual([
      "1-projects/shared-plan.md",
      "2-areas/health.md",
    ]);
    expect(found.hits[0].snippets.join(" ")).toContain("quokkaplan");
  });

  test("a team caller cannot find a private note by its contents", async () => {
    const store = bucket();
    await shareProjects(store);

    // Non-vacuity first: the owner finds it, so the corpus really does contain
    // the word and really is indexed. Without this the assertion below passes
    // just as well against a search that is simply broken.
    const asOwner = await settled(store, { query: "wallabyrate", scope: "private" });
    expect(asOwner.hits.map((hit) => hit.path)).toEqual(["1-projects/pay.md"]);

    const asTeam = await settled(store, { query: "wallabyrate", scope: "team" });
    expect(asTeam.hits).toEqual([]);
    // Not one path, not one snippet, and not a count either.
    expect(asTeam.matchCount).toBe(0);
    expect(JSON.stringify(asTeam)).not.toContain("pay.md");
    expect(JSON.stringify(asTeam)).not.toContain("confidential");
  });

  test("counts what the caller can see, never what the index holds", async () => {
    const store = bucket();
    await shareProjects(store);
    // `2-areas` stays private, so one of the two `quokkaplan` notes is hidden.
    const asTeam = await settled(store, { query: "quokkaplan", scope: "team" });

    expect(asTeam.hits.map((hit) => hit.path)).toEqual(["1-projects/shared-plan.md"]);
    expect(asTeam.matchCount).toBe(1);
  });

  test("a prefix narrows the search and cannot open a folder the caller may not see", async () => {
    const store = bucket();
    await shareProjects(store);

    const narrowed = await settled(store, {
      query: "quokkaplan",
      prefix: "1-projects",
      scope: "private",
    });
    expect(narrowed.hits.map((hit) => hit.path)).toEqual(["1-projects/shared-plan.md"]);

    // `2-areas` is private, so to a team caller it is not a narrower search,
    // it is a folder that does not exist — the answer `listFolder` gives.
    await expect(
      searchNotes(store, { query: "quokkaplan", prefix: "2-areas", scope: "team" }),
    ).rejects.toThrow();
  });

  test("an empty query is not a search for everything", async () => {
    const store = bucket();
    const found = await searchNotes(store, { query: "   ", scope: "private" });

    expect(found.hits).toEqual([]);
    expect(found.matchCount).toBe(0);
    expect(found.indexMissing).toBe(false);
  });

  test("a bucket with no index says so rather than reporting no matches", async () => {
    const store = memoryStore() as MemoryStore & FileStore;
    store.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
    // No notes at all: nothing to index, so nothing to answer from. The
    // distinction the console renders differently from "(no matches)".
    const found = await searchNotes(store, { query: "quokkaplan", scope: "private" });

    expect(found.indexMissing).toBe(true);
    expect(found.hits).toEqual([]);
  });

  test("the index it maintains is the one the gateway reads", async () => {
    const store = bucket();
    await settled(store, { query: "quokkaplan", scope: "private" });

    // Not an implementation detail: a console search that built its own index
    // under its own key would be a second derivative to keep honest, and the
    // gateway would go on answering from a cold one.
    const keys = Object.keys(store.snapshot());
    expect(keys).toContain(".index/v2/manifest.json");
    expect(keys.some((key) => key.startsWith(".index/v2/shard-"))).toBe(true);
  });
});
