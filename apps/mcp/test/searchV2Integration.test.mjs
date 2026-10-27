/**
 * The sharded index (v2) wired into the gateway — `searchVisibleNotes` in
 * `src/index.js` answering from `.context/search/v2/` through a real worker request.
 *
 * `searchShards.test.mjs` and `searchShardQuery.test.mjs` hold the two halves
 * on their own: the storage half against an instrumented bucket, the query
 * half as pure functions over fixtures. Neither can see the thing this file is
 * for, which is what happens when the gateway wires them together — the
 * budget shared between a sync and a shard walk, the visibility predicate
 * handed to the collector, and the floor language a caller actually reads.
 *
 * Why v2 at all, in one measurement: v1 is a single object that must be parsed
 * whole, so `INDEX_PARSE_BYTE_CAP` bounds it, and a workspace whose capped index
 * crosses that bound plateaus at partial coverage **forever** — the write is
 * refused, the last readable object survives, and no number of passes ever
 * covers the rest. That is not an abstraction: block (c) below builds a bucket
 * whose v1 index genuinely cannot converge under a cap, then converges the
 * same bucket under v2 with the same cap per shard.
 *
 * Four properties here are not visible in any output text, so this file stands
 * up its own instrumented bucket and counts store calls by key:
 *
 * 1. **The first search creates the index and the last one re-uses it.** A
 *    manifest, its shard objects, and a second search that reads note bodies
 *    only for the hits it returns.
 * 2. **The privacy line survives the shard boundary.** The shards hold text
 *    drawn from private notes — fine inside the customer's own bucket, never
 *    fine in what leaves the gateway — so a team-scope search over a term
 *    appearing in both team notes and a private one surfaces the team paths,
 *    no private byte, and a count of exactly what it listed. Both tool dialects, because
 *    `search_notes` and the ChatGPT-dialect `search` share one path and a
 *    second path would be a second place for a visibility bug.
 * 3. **A shard the answer could not open is said out loud — in both the
 *    banner and the number.** `loadShard` answers `null` for a budget refusal
 *    and for an absent object alike, so the gateway checks the budget *before*
 *    asking. Treating a refusal as an empty shard is silently answering a
 *    query from part of the corpus. The banner and the count are two lines a
 *    reader believes separately, so `matchCount` carries the census's floor
 *    mark of its own: a walk that opened four shards of twenty printed
 *    `4 matching notes` over a bucket of twenty-four, which is a wrong total,
 *    not a cautious one.
 * 4. **v1's object is deleted, once, on the pass that first writes a
 *    manifest.** Dead weight in a customer's bucket is still their bucket.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits to `src/index.js` and reverted; counts are
 * across the whole suite, as measured against the final fixtures.
 *
 * 1. **The visibility predicate dropped from the collector call**
 *    (`collectShardCandidates(shard, queryTerms, () => true)`). 2 checks
 *    failed, both in `searchIntegration.test.mjs`, and both on the *inference*
 *    line: a private note appearing changed a team connection's own answer,
 *    and private notes reordered the visible ones. That is the finding, and it
 *    is the reverse of the v1 record's first entry — every *content* check
 *    stayed green, because `rankedVisibleTo` at the output caught every
 *    private path before it was printed or counted. The two guards are not one
 *    guard with a spare here: the collector is what keeps private docs out of
 *    `N`, `df` and `avglen`, which no output filter can undo, and the filter is
 *    what keeps a private path out of the answer when the collector is wrong.
 *    Neither of them alone is the privacy line.
 * 2. **A budget-refused shard read treated as an empty shard** (the
 *    `budget.remaining` pre-check deleted and a `null` read as "this shard
 *    holds nothing"). 1 check failed, the starved-budget floor below — which
 *    is the check written for it, because every other fixture here has budget
 *    to spare and cannot tell a refusal from an absence.
 * 3. **`rankedVisibleTo` skipped** on the v2 path. 1 check failed, and it is
 *    not a privacy check: it is `searchIntegration.test.mjs`'s prefix filter,
 *    because that function applies `prefix` as well as the predicate. The
 *    *visibility* half fails zero end to end, exactly as CONTRACT.md says it
 *    must ("redundant … by construction and kept anyway: it is the half that
 *    does not depend on `visibleIndex` being correct") — the collector has
 *    already narrowed every shard to visible docs by the time it runs. It is
 *    held where a redundant guard can be held: `searchQuery.test.mjs` drives
 *    `rankedVisibleTo` directly with a list nothing narrowed first, and
 *    `searchShardQuery.test.mjs` holds the collector's own predicate. Sabotage
 *    1 above is what it is *for*, and is why it is not deleted for being
 *    unreachable.
 * 4. **`shardsUnread` dropped from `matchCountIsFloor`** (leaving
 *    `visible.length >= MAX_RESULTS` alone, which is what the line was before
 *    the sharded walk existed). 1 check failed, alone: the starved count below.
 *    Nothing else in 947 catches it, and that is the point — every other
 *    fixture here has budget to spare, so `shardsUnread` is false and the two
 *    versions of the line are the same line. The starved answer renders
 *    `4 matching notes` under the mutation and `4+ matching notes` without it,
 *    over twenty-four matching notes the roomy run counts.
 * 5. **`matchCountIsFloor: true` hardcoded**, the direction a test that only
 *    pinned the floor would pass. 5 checks failed: the converse below, this
 *    file's exact-count check, and three in `searchIntegration.test.mjs`. So
 *    the mark is held from both sides, and by more than one file.
 */

import { withServedTree } from "./servedTree.mjs";
import worker from "../src/index.js";
import { R2Store } from "../src/store/r2.js";
import { isLogicalDeleteMarker } from "../src/store/logicalDelete.js";
import { createSearchBudget } from "../src/search/maintain.js";
import { LEGACY_V1_KEY, MANIFEST_KEY, shardKey, syncShardedIndex } from "../src/search/shards.js";
import { createControlPlaneStub } from "./controlPlaneStub.mjs";
import {
  SEARCH_SUBREQUEST_BUDGET,
  SEARCH_RESULT_LIMIT,
  PRIVACY_MANIFEST_READ,
  SUBREQUEST_LIMIT,
  MAIN_OWNER_TOKEN,
  MAIN_TEAM_TOKEN,
  MAIN_TEAM_CHATGPT_TOKEN,
  WIDE_TOKEN,
  PRIVACY_MANIFEST,
  callTool,
  searchText,
  storedManifest,
  indexedPaths,
  pathsIn,
  seedV2World,
} from "./searchV2IntegrationFixtures.mjs";

export async function runSearchV2IntegrationChecks(check) {
  const controlPlane = createControlPlaneStub();
  const restore = controlPlane.install();
  try {
    const { main, wide, env } = await seedV2World(controlPlane);
    // The census is the tree's names, never the bucket's listing (`search/shards/listing.js`), so the tree serves these buckets.
    controlPlane.serveTreesFrom(env);

    // -- (a) the first search builds `.context/search/v2/` and answers from it --------
    //
    // A multi-folder bucket, because the listing walk is delimited at the root
    // and flat inside each real folder: a fixture with one folder cannot tell
    // that walk from a flat one.
    main.seed("privacy.md", PRIVACY_MANIFEST);
    main.seed("index.md", "# Front page\n\nThe map of everything.\n");
    main.seed(
      "1-projects/atlas/protocol.md",
      "# NARWHAL protocol\n\nThe NARWHAL protocol is how atlas ships.\n"
    );
    main.seed("1-projects/atlas/notes.md", "# Atlas notes\n\nA passing NARWHAL is mentioned here.\n");
    main.seed("1-projects/beta/plan.md", "# Beta plan\n\nBeta is unrelated to atlas.\n");
    main.seed(
      "1-projects/vault/secret.md",
      "# Vault\n\nNARWHAL-PRIVATE-MARKER is filed here and must never leave.\n"
    );
    main.seed("2-areas/handbook.md", "# Handbook\n\nHouse rules for everyone.\n");
    for (const name of ["list", "shelf", "loans"]) main.seed(`3-resources/reading/${name}.md`, `# Reading\n\nBooks about the sea: ${name}.\n`);
    // Plumbing seeded beside the notes rather than assumed absent.
    main.seed("scopes.yml", "legacy: true\n");
    main.seed(".obsidian/app.json", "{}");
    main.seed(".history/index.md.2020-01-01.md", "# Front page\n\nNARWHAL once lived here.\n");
    // (d) v1's object, left behind by a deployment that ran the old index.
    main.seed(
      LEGACY_V1_KEY,
      JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), docs: [], terms: [] })
    );

    main.resetCounts();
    // The first search over a bucket with no index answers from the bounded
    // literal scan and builds `.context/search/v2/` **behind the response**. A search no
    // longer indexes on its way in — that is the 40-to-60-second search this
    // whole shape removed — so the ranked answer is the *second* one, and the
    // index it reads was built by the first one's deferred pass.
    const firstOwner = await searchText(env, MAIN_OWNER_TOKEN, { query: "narwhal" });
    const firstManifest = storedManifest(main);
    const firstPaths = indexedPaths(main);
    check(
      "the first search through the worker writes a v2 manifest and the shard objects under it",
      firstManifest !== null &&
        firstManifest.shardCount >= 1 &&
        main.counts.puts.includes(MANIFEST_KEY) &&
        main.counts.puts.includes(shardKey(0)) &&
        firstPaths.length > 0
    );
    check(
      "and the scan that answered while it was building still found the note",
      firstOwner.includes("1-projects/atlas/protocol.md")
    );
    const indexedOwner = await searchText(env, MAIN_OWNER_TOKEN, { query: "narwhal" });
    check(
      "and answers from them, best match first, with no plumbing key anywhere in the index",
      pathsIn(indexedOwner)[0] === "1-projects/atlas/protocol.md" &&
        indexedOwner.includes("1-projects/vault/secret.md") &&
        firstPaths.every(
          (key) =>
            key.endsWith(".md") &&
            key !== "privacy.md" &&
            !key.split("/").some((segment) => segment.startsWith("."))
        )
    );

    // (d) v1's object is dead weight once a manifest exists: retired (a marker) by the pass
    // with room for it, the second here, as the reading notes keep the first pass short.
    // (Without them it finished the index and spent its last op first: v1 was left.)
    check(
      "v1's object is deleted on the pass that first creates a manifest, and not probed again",
      isLogicalDeleteMarker(main.objects.get(LEGACY_V1_KEY)?.body) &&
        main.counts.puts.filter((key) => key === LEGACY_V1_KEY).length === 1 &&
        (await (async () => {
          main.resetCounts();
          await searchText(env, MAIN_OWNER_TOKEN, { query: "narwhal" });
          return main.counts.delete === 0;
        })())
    );

    // -- (e) the second search re-uses the shards: no O(N) body reads --------
    main.resetCounts();
    const secondOwner = await searchText(env, MAIN_OWNER_TOKEN, { query: "narwhal" });
    const ownerHits = pathsIn(secondOwner);
    check(
      "a second search reads note bodies only for the hits it returns, and writes nothing",
      main.counts.noteGets.length === ownerHits.length &&
        main.counts.noteGets.every((key) => ownerHits.includes(key)) &&
        main.counts.noteGets.length < firstPaths.length &&
        main.counts.put === 0
    );

    // -- (b) THE PRIVACY LINE, across the shard boundary ---------------------
    //
    // The index was built by an owner-scope search, so a shard holds the
    // private note's path, title, terms and vocabulary. A team-scope search
    // over the shared term must disclose none of it — not the path, not a
    // snippet, and not a count that counts it.
    const teamSearch = await searchText(env, MAIN_TEAM_TOKEN, { query: "narwhal" });
    check(
      "a team search over an owner-built shard surfaces only the team-visible notes",
      typeof teamSearch === "string" &&
        teamSearch.includes("1-projects/atlas/protocol.md") &&
        !teamSearch.includes("1-projects/vault/secret.md") &&
        !teamSearch.includes("vault")
    );
    check(
      "no byte of the private note's text reaches a team connection",
      !teamSearch.includes("NARWHAL-PRIVATE-MARKER") && !teamSearch.includes("must never leave")
    );
    check(
      "and the reported count is the visible count exactly, never the shard's count",
      /^2 matching notes$/m.test(teamSearch) &&
        pathsIn(teamSearch).length === 2 &&
        /^3 matching notes$/m.test(secondOwner)
    );
    // One search path: `search_notes` and the ChatGPT-dialect `search` share
    // `searchVisibleNotes`, so a second path cannot disagree about what a query
    // matches or about who may see it.
    const teamDialect = JSON.parse(
      (await callTool(env, MAIN_TEAM_CHATGPT_TOKEN, "search", { query: "narwhal" }))?.content?.[0]?.text
    );
    check(
      "the ChatGPT dialect rides the same v2 path and the same filter",
      Array.isArray(teamDialect.results) &&
        teamDialect.results.map((result) => result.id).sort().join(",") ===
          pathsIn(teamSearch).sort().join(",") &&
        !JSON.stringify(teamDialect).includes("NARWHAL-PRIVATE-MARKER")
    );

    // -- (f) an unprefixed search on a wide-ish context stays inside the budget
    wide.seed("privacy.md", PRIVACY_MANIFEST);
    for (let n = 0; n < 60; n += 1) {
      wide.seed(
        `1-projects/bulk/note-${String(n).padStart(3, "0")}.md`,
        `# Bulk note ${n}\n\nEvery bulk note mentions the widget, this one is number ${n}.\n`
      );
    }
    wide.resetCounts();
    const wideFirst = await searchText(env, WIDE_TOKEN, { query: "widget" });
    const wideFirstOps = wide.ops;
    const wideStore = withServedTree(new R2Store(wide));
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const pass = await syncShardedIndex(wideStore, { budget: createSearchBudget(300) });
      if (pass.pending === 0) break;
    }
    wide.resetCounts();
    const wideSteady = await searchText(env, WIDE_TOKEN, { query: "widget" });
    check(
      "an unprefixed search on a 60-note context stays inside the budget, cold and converged alike",
      wideFirstOps - PRIVACY_MANIFEST_READ <= SEARCH_SUBREQUEST_BUDGET &&
        wideFirstOps < SUBREQUEST_LIMIT &&
        wide.ops - PRIVACY_MANIFEST_READ <= SEARCH_SUBREQUEST_BUDGET &&
        typeof wideFirst === "string" &&
        wideFirst.includes("1-projects/bulk/note-")
    );
    check(
      "and a converged one answers at the result limit without re-reading the bucket",
      pathsIn(wideSteady).length === SEARCH_RESULT_LIMIT &&
        wide.counts.noteGets.length === SEARCH_RESULT_LIMIT &&
        wide.counts.put === 0 &&
        !wideSteady.includes("still catching up")
    );

  } finally {
    restore?.();
  }
}
