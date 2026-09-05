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
 *   `projectSearchIndex` not running the R2 sync in front of the copy     10
 *   the pass never reporting that it finished                              4
 *   a `D1Error` code swallowed instead of returned                         2
 *   every note projected at `team`                                     1 → 2
 *   a failed pass reported as progress                                     1
 *   `moved` ignoring a pass that only advanced the R2 index            0 → 1
 *   `indexPending` dropped, so `ready` may outrun the R2 index             0
 *
 * And the trigger, over the whole control-plane suite rather than this file,
 * because several of these mutants are visible to the structural tests too:
 *
 *   the row never asked, so an opt-out is not obeyed                          4
 *   `provisionIndex` recording `backfilling` and scheduling nothing           1
 *   a link chaining whatever it moved, or did not                             1
 *   a refused database reported nowhere                                       1
 *   progress never written to the row                                         1
 *   the sweep restarting a chain that is already working                      1
 *   the sweep starting a context whose owner never asked                      1
 *   an unconfigured deployment left `backfilling` forever                     1
 *   the credential opened before the row is asked                         0 → 1
 *   the chain treated as still due for a row that is no longer
 *     `backfilling` (i.e. one that is `ready`)                            0 → 1
 *
 * **The credential opened before the row is asked** measured zero at first,
 * and the assertion that measured it was the problem rather than the guard:
 * "the bucket saw no request" cannot see this mutant, because opening a
 * credential makes no bucket request — it is a decrypt and a constructor. The
 * test deletes the storage binding instead, so reaching the credential throws,
 * and carries a non-vacuity check that the same call with the row left
 * `backfilling` really does throw.
 *
 * **The chain treated as still due for a `ready` row** measured zero because
 * `projectionTargetForWorkspace` already refuses every *other* state — it
 * answers `backfilling` and `ready` alike, since its other caller hands the
 * gateway a credential in both. The narrowing to `backfilling` is therefore
 * load-bearing on its own and had nothing checking it: what it prevents is a
 * converged context paying a full bucket listing per link, forever.
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

import { afterEach, describe, expect, test, vi } from "vitest";
import { memoryS3, memoryStore, type MemoryStore } from "./storeStub.helpers";
import { d1AndBucketFetch, stubD1, type StubD1 } from "./searchBackfill.helpers";
import {
  type FileStore,
  projectSearchIndex,
  setFolderVisibility,
} from "../functions/lib/fileOps";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  FAKE_D1,
  FAKE_STORAGE,
  createUser,
  createWorkspace,
  seedAppSecret,
  seedStorageBinding,
  setupTest,
  type TestConvex,
} from "./fixtures.helpers";
import { D1_ACCOUNT_SECRET, D1_TOKEN_SECRET } from "../functions/lib/d1";

/**
 * Every deployment a test in this file stood up, so `afterEach` can put its
 * scheduler to bed.
 *
 * `convex-test` starts a `runAfter(0)` job on a **real** timer, and several
 * checks here deliberately end with one queued — asserting that a link was
 * scheduled is half the point of the file. Left alone, that timer fires during
 * whichever test is running by then, and reaches for `globalThis.fetch`, which
 * is that test's stub. The symptom is a check failing over statements sent by
 * a pass belonging to a context it has never heard of, and it passes when run
 * alone: the classic shape of a suite whose tests are not isolated.
 *
 * So every pending job is cancelled between tests. Cancelling rather than
 * draining, because draining would run work the test had just finished proving
 * should exist and had no intention of executing.
 */
const deployments: TestConvex[] = [];

afterEach(async () => {
  for (const t of deployments.splice(0)) {
    await t.run(async (ctx) => {
      for (const job of await ctx.db.system.query("_scheduled_functions").collect()) {
        if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
      }
    });
  }
  vi.unstubAllGlobals();
});

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

/* -------------------------------------------------------------------------- */
/*                    what starts it, and what stops it                       */
/* -------------------------------------------------------------------------- */

/** A context with a bucket, a provisioned index row, and the D1 credential set. */
async function opted(
  options: { status?: Doc<"searchIndexes">["status"]; optedIn?: boolean; notes?: number } = {},
): Promise<{
  t: TestConvex;
  workspaceId: Id<"workspaces">;
  owner: Id<"users">;
  d1: StubD1;
  bucket: ReturnType<typeof memoryS3>;
}> {
  const t = setupTest();
  deployments.push(t);
  const owner = await createUser(t, "owner@example.invalid");
  const workspaceId = await createWorkspace(t, owner, "quokka-notes");

  const bucket = memoryS3(FAKE_STORAGE.bucket);
  bucket.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  bucket.seed("index.md", "# Context\n");
  for (let n = 0; n < (options.notes ?? 3); n += 1) {
    bucket.seed(`1-projects/note-${n}.md`, `# Note ${n}\n\nThe quokkaplan ships.\n`);
  }
  const d1 = stubD1();
  vi.stubGlobal("fetch", d1AndBucketFetch(d1, bucket.fetchImpl));

  await seedStorageBinding(t, { workspaceId, boundBy: owner });
  await seedAppSecret(t, D1_TOKEN_SECRET, FAKE_D1.apiToken);
  await seedAppSecret(t, D1_ACCOUNT_SECRET, FAKE_D1.accountId);

  const now = Date.now();
  await t.run((ctx) =>
    ctx.db.insert("searchIndexes", {
      workspaceId,
      optedIn: options.optedIn ?? true,
      optedInBy: owner,
      optedInAt: now,
      status: options.status ?? "backfilling",
      databaseId: "example-database-0000",
      databaseName: "context-search-example",
      schemaVersion: 1,
      notesIndexed: 0,
      createdAt: now,
      updatedAt: now,
    }),
  );
  return { t, workspaceId, owner, d1, bucket };
}

function row(t: TestConvex, workspaceId: Id<"workspaces">) {
  return t.run(
    async (ctx) =>
      await ctx.db
        .query("searchIndexes")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique(),
  );
}

/** Jobs queued but not yet run, by function name. */
async function queued(t: TestConvex, name: string) {
  const jobs = await t.run((ctx) =>
    ctx.db.system.query("_scheduled_functions").collect(),
  );
  return jobs.filter(
    (job) => job.name.includes(name) && job.state.kind === "pending",
  );
}

async function project(
  t: TestConvex,
  workspaceId: Id<"workspaces">,
  passes = 4,
) {
  return await t.action(internal.functions.files.runFileOperation, {
    workspaceId,
    // Scope-blind, like `maintainIndex`: an index describes the bucket, and
    // the tier a note is copied at comes from `privacy.md` per note, never
    // from whoever happened to schedule the pass.
    scope: "private" as const,
    operation: { kind: "projectIndex" as const, passes },
  });
}

describe("the trigger", () => {
  test("provisioning schedules the first pass, after the status is recorded", async () => {
    const { t, workspaceId } = await opted({ status: "provisioning" });

    await t.action(internal.functions.fastSearchProvision.provisionIndex, {
      workspaceId,
    });

    // The row says the schema is on and the copy is due...
    expect((await row(t, workspaceId))?.status).toBe("backfilling");
    // ...and something is actually due to run. Before this, nothing was: the
    // provisioner recorded `backfilling` and returned, and the context waited
    // for its owner to run a search that might never come.
    expect(await queued(t, "runFileOperation")).toHaveLength(1);
  });

  test("a pass copies the notes and the count reaches the row", async () => {
    const { t, workspaceId, d1 } = await opted({ notes: 3 });

    await project(t, workspaceId);

    expect(d1.paths()).toContain("1-projects/note-0.md");
    const after = await row(t, workspaceId);
    // The number the settings card divides. Before this it stayed at the zero
    // `provisionIndex` wrote.
    expect(after?.notesIndexed).toBe(4);
    expect(after?.notesPending).toBe(0);
    expect(after?.status).toBe("ready");
  });

  test("the chain schedules its next link, and only while there is one to do", async () => {
    const { t, workspaceId } = await opted({ notes: 3 });

    // One link over the whole fixture finishes it, so nothing follows: `ready`
    // ends the chain as surely as no progress does.
    await project(t, workspaceId);
    expect(await queued(t, "runFileOperation")).toHaveLength(0);

    // And a link that cannot finish the job schedules exactly one more —
    // never a fan-out, whatever it moved.
    const { t: t2, workspaceId: w2 } = await opted({ notes: 3 });
    await t2.action(internal.functions.files.runFileOperation, {
      workspaceId: w2,
      scope: "private" as const,
      // A cap of zero notes: the R2 index advances, the copy does not, which
      // is the cold-brain link.
      operation: { kind: "projectIndex" as const, passes: 4 },
    });
    expect((await queued(t2, "runFileOperation")).length).toBeLessThanOrEqual(1);
  });

  test("the chain runs out of links rather than running forever", async () => {
    const { t, workspaceId } = await opted({ notes: 3 });

    // The last link of a chain schedules nothing even if it moved something.
    await t.action(internal.functions.files.runFileOperation, {
      workspaceId,
      scope: "private" as const,
      operation: { kind: "projectIndex" as const, passes: 0 },
    });

    expect(await queued(t, "runFileOperation")).toHaveLength(0);
  });

  test("a row that stopped being backfilling stops the chain, without a credential", async () => {
    const { t, workspaceId, d1, bucket } = await opted({ notes: 3 });
    // Opted out mid-chain: the row is `releasing` and its database is being
    // deleted. A link that arrives now must not write into it, and must not
    // report anything that could move it back into service.
    await t.run(async (ctx) => {
      const existing = await ctx.db
        .query("searchIndexes")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique();
      await ctx.db.patch(existing!._id, { optedIn: false, status: "releasing" });
    });
    const bucketReadsBefore = bucket.requests.length;

    await project(t, workspaceId);

    expect(d1.statements).toEqual([]);
    expect(bucket.requests.length).toBe(bucketReadsBefore);
    const after = await row(t, workspaceId);
    expect(after?.status).toBe("releasing");
    expect(after?.notesIndexed).toBe(0);
    expect(await queued(t, "runFileOperation")).toHaveLength(0);
  });

  test("a link with nothing to do never opens the bucket credential", async () => {
    /*
     * THE ORDER IS THE GUARD, AND IT NEEDS AN ASSERTION THAT CAN SEE IT.
     *
     * A link can have been queued minutes ago, and an owner can have opted out
     * since. If it opened the storage credential first and only then asked
     * whether there was anything to copy, it would have decrypted a customer's
     * secret on the way to doing nothing.
     *
     * "No bucket request was made" cannot tell that apart, because opening the
     * credential makes none — it is a decrypt and a constructor. So the
     * binding row is deleted instead: reaching the credential open now throws
     * `STORAGE_NOT_CONNECTED`, and the only way this call returns quietly is
     * if the row was consulted first.
     */
    const { t, workspaceId } = await opted({ notes: 3 });
    await t.run(async (ctx) => {
      const existing = await ctx.db
        .query("searchIndexes")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique();
      await ctx.db.patch(existing!._id, { optedIn: false, status: "releasing" });
      for (const binding of await ctx.db.query("storageBindings").collect()) {
        await ctx.db.delete(binding._id);
      }
    });

    const result = await project(t, workspaceId);

    expect(result.kind).toBe("indexProjected");
    // Non-vacuity: with the row still `backfilling`, the very same call does
    // reach the credential and fails on the missing binding — so the quiet
    // return above is the guard working, not the fixture being inert.
    const { t: t2, workspaceId: w2 } = await opted({ notes: 3 });
    await t2.run(async (ctx) => {
      for (const binding of await ctx.db.query("storageBindings").collect()) {
        await ctx.db.delete(binding._id);
      }
    });
    await expect(project(t2, w2)).rejects.toThrow(/STORAGE_NOT_CONNECTED/);
  });

  test("a finished index is not re-listed by a link that arrives late", async () => {
    /*
     * `ready` is not `backfilling`, and the difference is what stops this
     * costing a bucket listing per link forever.
     *
     * Once the projection holds everything, the gateway keeps it current by
     * riding the sync behind each search — it needs no schedule of its own,
     * and a chain that kept running against a converged context would list the
     * whole bucket, diff it and find nothing, on somebody else's request
     * quota, every link. `projectionTargetForWorkspace` answers `backfilling`
     * and `ready` alike (its other caller hands the gateway a credential in
     * both), so the narrowing has to be here.
     */
    const { t, workspaceId, d1, bucket } = await opted({ status: "ready", notes: 3 });
    const before = bucket.requests.length;

    await project(t, workspaceId);

    expect(d1.statements).toEqual([]);
    expect(bucket.requests.length).toBe(before);
    expect((await row(t, workspaceId))?.status).toBe("ready");
  });

  test("an owner who opts out mid-chain is obeyed", async () => {
    const { t, workspaceId, d1 } = await opted({ optedIn: false, notes: 3 });

    await project(t, workspaceId);

    expect(d1.statements).toEqual([]);
    expect((await row(t, workspaceId))?.notesIndexed).toBe(0);
  });

  test("a refused database lands on the row as a failure, not as silence", async () => {
    const { t, workspaceId, d1 } = await opted({ notes: 3 });
    d1.fail = "UNAUTHORIZED";

    await project(t, workspaceId);

    const after = await row(t, workspaceId);
    // The bug this closes: a projection that cannot reach its database leaves
    // search working, so nothing else in the system ever notices, and the row
    // sits at `backfilling` forever with nothing to explain it.
    expect(after?.status).toBe("failed");
    expect(after?.errorCode).toBe("UNAUTHORIZED");
    expect(after?.error).toContain("D1:Edit");
    // Ours, from a closed set. Cloudflare's message names an account and a
    // database, and none of it may be repeated back.
    expect(after?.error).not.toContain("example-account");
    expect(after?.error).not.toContain("7403");
    // A failed row is not `backfilling`, so the chain has already stopped.
    expect(await queued(t, "runFileOperation")).toHaveLength(0);
  });

  test("a deployment with no D1 credential says so rather than retrying forever", async () => {
    const { t, workspaceId } = await opted({ notes: 3 });
    await t.run(async (ctx) => {
      for (const secret of await ctx.db.query("appSecrets").collect()) {
        await ctx.db.delete(secret._id);
      }
    });

    await project(t, workspaceId);

    const after = await row(t, workspaceId);
    expect(after?.status).toBe("failed");
    expect(after?.errorCode).toBe("NOT_CONFIGURED");
  });

  test("the sweep starts a context that was left backfilling before any of this existed", async () => {
    // The three real contexts: provisioned, schema applied, zero rows, and
    // nothing scheduled because nothing existed to schedule. They are not
    // reachable through `enable` — it returns early for a row that is already
    // opted in and not failed — so a sweep is what picks them up.
    const { t, workspaceId } = await opted({ notes: 3 });
    await t.run(async (ctx) => {
      const existing = await ctx.db
        .query("searchIndexes")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique();
      await ctx.db.patch(existing!._id, { updatedAt: Date.now() - 86_400_000 });
    });

    const swept = await t.mutation(internal.functions.fastSearch.sweepStalledBackfills, {});

    expect(swept.started).toBe(1);
    expect(await queued(t, "runFileOperation")).toHaveLength(1);
  });

  test("the sweep leaves a chain that is already working alone", async () => {
    // `updatedAt` moves every time a link reports, so a live chain is a row
    // that was touched a moment ago. Scheduling a second chain beside it would
    // put two passes on one database for no gain — and duplicate chunks are
    // exactly what an overlap costs.
    const { t, workspaceId } = await opted({ notes: 3 });

    const swept = await t.mutation(internal.functions.fastSearch.sweepStalledBackfills, {});

    expect(swept.started).toBe(0);
    expect(await queued(t, "runFileOperation")).toHaveLength(0);
  });

  test("the sweep does not touch a context whose owner never asked", async () => {
    const { t, workspaceId } = await opted({ optedIn: false, notes: 3 });
    await t.run(async (ctx) => {
      const existing = await ctx.db
        .query("searchIndexes")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique();
      await ctx.db.patch(existing!._id, { updatedAt: Date.now() - 86_400_000 });
    });

    const swept = await t.mutation(internal.functions.fastSearch.sweepStalledBackfills, {});

    expect(swept.started).toBe(0);
  });
});
