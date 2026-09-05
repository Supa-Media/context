/**
 * NOTHING STARTED THE COPY.
 *
 * Fast search provisions a database per opted-in context and the gateway fills
 * it — behind a search, on that search's own budget. Every trigger was a
 * search: `searchVisibleNotes` in the gateway, and `searchContext` scheduling
 * `maintainIndex` here. So an owner who turned the switch on and closed the
 * app sat at "0 notes indexed / Preparing" indefinitely, and three real
 * contexts were sitting there when this was written — schema applied,
 * `SELECT COUNT(*) FROM notes` zero, nothing due to run.
 *
 * The half that does not need anybody present has to live in the control
 * plane: it is the only component that can enumerate opted-in contexts, and it
 * already opens a bucket credential of its own and runs the gateway's
 * `syncShardedIndex` through `runFileOperation`. `projectSearchIndex` is the
 * same import, one function further along.
 *
 * ## What is asked here, and what is asked elsewhere
 *
 * **Not** what the projection stores. `apps/mcp/test/searchProjection.test.mjs`
 * drives the same `projectPass` against real SQL through `node:sqlite` and
 * proves the tier split, the visibility move, the chunking and the cursor's
 * resume there. Re-proving any of it against the stub in
 * `searchBackfill.helpers.ts` would be proving my model of SQLite.
 *
 * What is asked here is the part that did not exist:
 *
 *  1. **Does anything start without a person?** Turning the switch on must
 *     schedule the pass, and a context that was left `backfilling` before any
 *     of this existed must be picked up rather than waiting for a search.
 *  2. **Does the chain terminate?** A trigger that cannot stop is worse than no
 *     trigger — it is a bucket listing per link, billed to the customer,
 *     forever. It must stop on no progress, on a row that stopped being
 *     `backfilling`, and on an owner who opted out mid-chain.
 *  3. **Does what it learns reach the row?** The bug being closed is a person
 *     watching a counter that never moves. A pass that copies notes and reports
 *     nothing is the same bug with more infrastructure behind it.
 *  4. **Does a failure end up somewhere a person can see?** A projection that
 *     cannot reach its database leaves search working, so nothing else in the
 *     system notices. Silence there is how "Preparing forever" happened.
 *  5. **Can it fight the gateway?** Both write the same tables and both report.
 *     Concurrent passes must not double-count, corrupt the cursor, or bring a
 *     released row back into service.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted, counts **as measured** over this
 * file, one measured zero included — a record that lists only the satisfying
 * numbers is decoration.
 *
 *   `projectSearchIndex` not running the R2 sync in front of the copy      7
 *   the pass never reporting that it finished                              2
 *   every note projected at `team`                                     1 → 2
 *   `moved` ignoring a pass that only advanced the R2 index            0 → 1
 *   a failed pass reported as progress                                     1
 *   a `D1Error` code swallowed instead of returned                         1
 *   `indexPending` dropped, so `ready` may outrun the R2 index             0
 *
 * **`every note projected at team`** was one and is two. The tier test asserted
 * that a shared note reaches the team table and not the private one, which a
 * projection answering "team" for everything satisfies exactly. The assertion
 * that does the work is the other direction — nothing under an unshared folder
 * may reach the team table — because that is the one a default breaks.
 *
 * **`moved` ignoring a pass that only advanced the R2 index** measured zero
 * until "a pass that only moved the R2 index is still progress" was written.
 * On a fixture small enough to index and copy in one pass, the copy always
 * moves something too, so the clause that keeps a *cold* chain alive was
 * unchecked — and its failure mode is the exact bug this file exists to end,
 * one layer up: the chain stops on link one and nothing is ever copied.
 *
 * **`indexPending` dropped** is zero and stays zero here: this fixture's R2
 * index converges in the same pass that builds it, so `pending` is never
 * anything but zero and no assertion can tell the two apart. What would catch
 * it is a bucket wide enough to need several listings, which
 * `apps/mcp/test/searchProjection.test.mjs` has — it measures 1 for exactly
 * this mutant ("`state: ready` sent while the R2 index still had notes
 * pending"). Kept rather than dropped, because the clause is load-bearing and
 * a record that omits what it cannot check is a record that overstates itself.
 */

import { describe, expect, test } from "vitest";
import { memoryStore, type MemoryStore } from "./storeStub.helpers";
import { stubD1 } from "./searchBackfill.helpers";
import {
  type FileStore,
  projectSearchIndex,
  setFolderVisibility,
} from "../functions/lib/fileOps";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";

/** A bucket with a private half and a shared half, and no index over it yet. */
function bucket(noteCount = 6): MemoryStore & FileStore {
  const store = memoryStore() as MemoryStore & FileStore;
  store.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  store.seed("index.md", "# Context\n");
  store.seed("1-projects/README.md", "# Projects\n");
  store.seed("2-areas/README.md", "# Areas\n");
  for (let n = 0; n < noteCount; n += 1) {
    store.seed(
      `1-projects/note-${String(n).padStart(2, "0")}.md`,
      `# Note ${n}\n\nThe quokkaplan for ${n} ships in March.\n`,
    );
  }
  return store;
}

/**
 * Drive the chain the way `runFileOperation` does: another link only while the
 * last one moved something, and a hard bound so a stuck backfill fails the
 * test rather than hanging it.
 */
async function chain(
  store: FileStore,
  client: ReturnType<typeof stubD1>["client"],
  limit = 12,
): Promise<{ links: number; last: Awaited<ReturnType<typeof projectSearchIndex>> }> {
  let links = 0;
  let last = await projectSearchIndex(store, client);
  links += 1;
  while (last.moved && !last.ready && links < limit) {
    last = await projectSearchIndex(store, client);
    links += 1;
  }
  return { links, last };
}

describe("a projection pass the control plane runs itself", () => {
  test("copies a bucket nothing has ever searched", async () => {
    const store = bucket();
    const d1 = stubD1();

    const { last, links } = await chain(store, d1.client);

    // The whole point: no search happened, and the notes are in the database.
    expect(d1.paths()).toEqual([
      "1-projects/README.md",
      "1-projects/note-00.md",
      "1-projects/note-01.md",
      "1-projects/note-02.md",
      "1-projects/note-03.md",
      "1-projects/note-04.md",
      "1-projects/note-05.md",
      "2-areas/README.md",
      "index.md",
    ]);
    // A folder's README is a note somebody can write in and search for. The
    // access map is not: `privacy.md` is plumbing, and a copy of it in a
    // corpus every member is scored against would be the rules themselves
    // becoming searchable text.
    expect(d1.paths()).not.toContain(PRIVACY_KEY);
    expect(last.notesIndexed).toBe(9);
    expect(last.notesPending).toBe(0);
    expect(last.ready).toBe(true);
    expect(links).toBeLessThan(12);
  });

  test("builds the R2 index it needs rather than waiting for one", async () => {
    // The three stuck contexts are the case: provisioned before any of this
    // existed, and there is no guarantee anybody ever searched them into
    // having an index. The projection's census is that index's own docmap, so
    // a pass that only projected would have nothing to walk, forever.
    const store = bucket();
    expect(store.snapshot()[".index/v2/manifest.json"]).toBeUndefined();

    await chain(store, stubD1().client);

    expect(Object.keys(store.snapshot()).some((key) => key.startsWith(".index/"))).toBe(
      true,
    );
  });

  test("projects a note at the tier its privacy manifest says, not a guess", async () => {
    const store = bucket(2);
    await setFolderVisibility(store, {
      path: "1-projects",
      visibility: "team",
      scope: "private",
    });
    const d1 = stubD1();

    await chain(store, d1.client);

    expect(d1.visibilityOf("1-projects/note-00.md")).toBe("team");
    expect(d1.chunksIn("team", "1-projects/note-00.md")).toBeGreaterThan(0);
    // The corpus a team caller is scored against must not carry it twice.
    expect(d1.chunksIn("private", "1-projects/note-00.md")).toBe(0);

    // And the other direction, which is the one that matters: `2-areas` was
    // never shared, so nothing under it may reach the team table at all. A
    // projection that answered "team" for everything would satisfy the three
    // assertions above and put a private note's whole vocabulary into the
    // corpus every member of the context is scored against — the inference
    // channel the tier split exists to close, arrived at by a default.
    expect(d1.visibilityOf("2-areas/README.md")).toBe("private");
    expect(d1.chunksIn("team", "2-areas/README.md")).toBe(0);
    expect(d1.chunksIn("private", "2-areas/README.md")).toBeGreaterThan(0);
  });

  test("a pass that only moved the R2 index is still progress", async () => {
    /*
     * The link a cold brain lives on. A bucket wide enough that the listing,
     * the diff and the note re-reads spend the whole budget leaves the copy
     * nothing to do that pass — and if that counts as "moved nothing", the
     * chain stops on link one and the projection never starts. Which is the
     * bug this whole file exists to end, reintroduced one layer up.
     *
     * `noteCap: 0` is how a test reaches that state deterministically: the
     * sync runs and commits, the projection is allowed to copy nothing.
     */
    const store = bucket(4);
    const d1 = stubD1();

    const pass = await projectSearchIndex(store, d1.client, { noteCap: 0 });

    expect(pass.projected).toBe(0);
    expect(pass.deleted).toBe(0);
    expect(pass.moved).toBe(true);
    expect(pass.failure).toBe(null);
    // Non-vacuity: the index really did advance, so "moved" is describing
    // something rather than being hardcoded true.
    expect(Object.keys(store.snapshot()).some((key) => key.startsWith(".index/"))).toBe(
      true,
    );
  });

  test("stops the moment a pass moves nothing", async () => {
    const store = bucket(2);
    const d1 = stubD1();
    await chain(store, d1.client);
    const before = d1.statements.length;

    // A converged projection over a converged index. This is the link the
    // chain must not schedule another behind: `moved` false is the whole of
    // what ends it, and a pass that reported itself as progress would be a
    // bucket listing per link, billed to the customer, forever.
    const idle = await projectSearchIndex(store, d1.client);
    expect(idle.moved).toBe(false);
    expect(idle.projected).toBe(0);
    expect(idle.deleted).toBe(0);
    // It still costs something to find that out — which is why "cheap" is not
    // an argument for chaining anyway.
    expect(d1.statements.length).toBeGreaterThan(before);
  });

  test("a refused database is reported, never thrown", async () => {
    const store = bucket(2);
    const d1 = stubD1();
    d1.fail = "UNAUTHORIZED";

    const pass = await projectSearchIndex(store, d1.client);

    // Not a rejection: the caller is a scheduled job whose whole purpose is to
    // record this. A throw here leaves the row at `backfilling` forever, which
    // is the bug.
    expect(pass.failure).toBe("UNAUTHORIZED");
    expect(pass.projected).toBe(0);
    // And nothing is reported as progress on a pass that failed — counters of
    // zero written onto the row would read as a backfill that found no notes.
    expect(pass.report).toBe(false);
  });

  test("two passes at once do not double-count a note or lose the cursor", async () => {
    const store = bucket(8);
    const d1 = stubD1();
    // One database, two passes — the gateway projecting behind somebody's
    // search while the scheduled chain runs. Both walk from the same cursor
    // and both write one.
    await Promise.all([
      projectSearchIndex(store, d1.client),
      projectSearchIndex(store, d1.client),
    ]);
    const { last } = await chain(store, d1.client);

    const paths = d1.paths();
    // `notes.path` is a PRIMARY KEY, so the census an owner reads cannot be
    // doubled by an overlap however the two passes interleave. This is the
    // count the settings card divides, and it is the one that must be right.
    expect(paths).toHaveLength(new Set(paths).size);
    // Eight notes, plus `index.md` and the two folder READMEs.
    expect(paths).toHaveLength(11);
    expect(last.notesIndexed).toBe(11);
    // The cursor is a path from the census or the start of a sweep — never a
    // value one pass invented while the other was mid-window. A pass that lost
    // the race re-walks; it does not skip.
    expect(d1.cursor() === "" || paths.includes(d1.cursor())).toBe(true);
    // And the projection converges rather than wedging: whatever order the two
    // landed in, a later pass still reaches `ready`.
    expect(last.ready).toBe(true);
  });

  test("an overlap can leave a note with duplicate chunks, and that is the bound", async () => {
    /*
     * THE RESIDUAL, ASSERTED RATHER THAN CLAIMED AWAY.
     *
     * `upsertStatements` opens with three deletes and then inserts, and D1's
     * `/query` endpoint runs one statement per request — there is no
     * transaction around the group, which `d1/client.js` says out loud. Two
     * passes projecting the *same* note at the same time can therefore
     * interleave as delete, delete, insert, insert, and the FTS tables have no
     * key to collapse the second copy onto the first.
     *
     * What that costs is bounded and is not a disclosure: the chunk is a copy
     * of a note already in that same table at that same tier, so nothing
     * crosses the private/team split, `notes` is still one row per path, and
     * `d1/query.js` merges chunk hits per path — "a note is its best chunk" —
     * so a search returns the note once. What is actually lost is a slot of
     * the query's `LIMIT` and a small shift in the corpus statistics, until
     * the note is next re-projected, which rewrites both tables for it.
     *
     * Closing it properly means an atomic multi-statement batch, which is a
     * change to `apps/mcp`'s D1 client and to the reasoning `lib/d1.ts` sets
     * out for refusing multi-statement requests. Pinned here so that it is a
     * known cost with a test naming it, rather than something a later reader
     * discovers as a surprise — and so that a fix flips this assertion instead
     * of finding nothing to update.
     */
    const store = bucket(1);
    const d1 = stubD1();
    await Promise.all([
      projectSearchIndex(store, d1.client),
      projectSearchIndex(store, d1.client),
    ]);

    const doubled = d1
      .paths()
      .filter((path) => d1.chunksIn("private", path) > 1);
    expect(doubled.length).toBeGreaterThan(0);
    // Still one row per note, and still only in the tier its manifest names.
    for (const path of doubled) {
      expect(d1.chunksIn("team", path)).toBe(0);
    }

    // And it heals the next time that note is projected, which is what makes
    // it a cost rather than a corruption.
    store.seed("index.md", "# Context\n\nEdited, so the version moves.\n");
    await chain(store, d1.client);
    expect(d1.chunksIn("private", "index.md")).toBe(1);
  });
});
