/**
 * The main fixture: a team note and a private note sharing one term. The
 * budget, the op count, and the two privacy channels a search must not leak
 * through. See searchIntegration.test.mjs for the module overview and the
 * sabotage-testing record.
 */

import {
  MANIFEST_KEY,
  OWNER_TOKEN,
  PRIVACY_MANIFEST,
  PRIVACY_MANIFEST_READ,
  R2Store,
  SEARCH_SUBREQUEST_BUDGET,
  TEAM_TOKEN,
  callTool,
  convergeV2,
  defaultIsIndexable,
  indexedPaths,
  searchIndex,
  searchText,
  storedManifest,
} from "./fixtures.mjs";

export async function runSearchIntegrationMainFixtureChecks(check, harness) {
  const { bucket, env } = harness;

    // -- the main fixture: a team note and a private note sharing one term ----
    bucket.seed("privacy.md", PRIVACY_MANIFEST);
    bucket.seed("index.md", "# Front page\n\nThe map of everything.");
    // The term is in the title so this note outranks any number of body-only
    // matches — the owner's floor check at the end of this block needs it to
    // stay inside `searchIndex`'s 50-result cap however much private noise is
    // added. That crowding is the owner's own now: since `visibleIndex`, a team
    // connection is scored against a corpus the private notes are not in, so
    // they cannot push a visible note out of its ranked list at all.
    bucket.seed(
      "1-projects/alpha/protocol.md",
      "# ZEBRAFISH protocol\n\nThe ZEBRAFISH protocol is how alpha ships.\n"
    );
    bucket.seed("1-projects/alpha/notes.md", "# Alpha notes\n\nOrdinary PANGOLIN husbandry.\n");
    bucket.seed("1-projects/beta/plan.md", "# Beta plan\n\nBeta is unrelated to alpha.\n");
    bucket.seed(
      "1-projects/vault/secret.md",
      "# Vault\n\nZEBRAFISH-PRIVATE-MARKER is filed here and must never leave.\n"
    );
    bucket.seed("2-areas/handbook.md", "# Handbook\n\nHouse rules for everyone.\n");
    // Plumbing that must never reach the index, seeded beside the notes rather
    // than assumed absent.
    bucket.seed("scopes.yml", "legacy: true\n");
    bucket.seed(".obsidian/app.json", "{}");
    bucket.seed(".history/index.md.2020-01-01.md", "# Front page\n\nZEBRAFISH once lived here.\n");

    // (a) the first search builds the index and answers from it
    bucket.resetCounts();
    const firstOwner = await searchText(env, OWNER_TOKEN, { query: "zebrafish" });
    const firstOps = bucket.ops;
    const builtManifest = storedManifest(bucket);
    const builtPaths = indexedPaths(bucket);
    check(
      "the first search builds a valid manifest and its shards, and answers from them",
      builtManifest !== null &&
        builtManifest.shardCount >= 1 &&
        builtPaths.length > 0 &&
        typeof firstOwner === "string" &&
        firstOwner.includes("1-projects/alpha/protocol.md")
    );
    check(
      "the index never holds a plumbing key, whatever is sitting beside the notes",
      builtPaths.every(
        (key) =>
          key.endsWith(".md") &&
          key !== "privacy.md" &&
          !key.split("/").some((segment) => segment.startsWith("."))
      )
    );
    check(
      "and the module's standalone note filter agrees with the gateway's plumbing rule",
      defaultIsIndexable("1-projects/alpha/protocol.md") &&
        !defaultIsIndexable("privacy.md") &&
        !defaultIsIndexable("scopes.yml") &&
        !defaultIsIndexable(".history/index.md.2020-01-01.md") &&
        !defaultIsIndexable("1-projects/.trash/old.md") &&
        !defaultIsIndexable("1-projects/alpha/diagram.png")
    );

    // (b) the second search re-uses the index: no O(N) body reads
    bucket.resetCounts();
    const secondOwner = await searchText(env, OWNER_TOKEN, { query: "zebrafish" });
    const ownerHitCount = (secondOwner.match(/^1-projects\//gm) || []).length;
    check(
      "a second search re-uses the index rather than re-reading the bucket",
      bucket.counts.noteGets.length <= ownerHitCount &&
        bucket.counts.noteGets.length < builtPaths.length &&
        bucket.counts.put === 0
    );
    check(
      "and it still answers, so the reuse is not an empty answer",
      secondOwner.includes("1-projects/alpha/protocol.md") &&
        secondOwner.includes("1-projects/vault/secret.md")
    );

    // (d) THE PRIVACY LINE. The index was built by an owner-scope search above,
    // so it holds the private note's path, title, terms and vocabulary. A
    // team-scope search over the shared term must disclose none of it — not the
    // path, not a snippet, and not a count that counts it.
    bucket.resetCounts();
    const teamSearch = await searchText(env, TEAM_TOKEN, { query: "zebrafish" });
    check(
      "a team search over an owner-built index surfaces only the team-visible note",
      typeof teamSearch === "string" &&
        teamSearch.includes("1-projects/alpha/protocol.md") &&
        !teamSearch.includes("1-projects/vault/secret.md") &&
        !teamSearch.includes("vault")
    );
    check(
      "no byte of the private note's text reaches a team connection",
      typeof teamSearch === "string" &&
        !teamSearch.includes("ZEBRAFISH-PRIVATE-MARKER") &&
        !teamSearch.includes("must never leave")
    );
    check(
      "the reported count is the count of visible matches, never of index matches",
      /^1 matching note$/m.test(teamSearch)
    );
    check(
      "and the same query at owner scope reports the larger count, so that is a filter and not a cap",
      /^2 matching notes$/m.test(secondOwner)
    );

    // (j) the prefix argument filters indexed results
    const prefixed = await searchText(env, OWNER_TOKEN, {
      query: "alpha",
      prefix: "1-projects/alpha",
    });
    check(
      "a prefix argument filters the indexed results to that subtree",
      prefixed.includes("1-projects/alpha/") &&
        !prefixed.includes("1-projects/beta/") &&
        !prefixed.includes("2-areas/")
    );

    // the ChatGPT dialect rides the same path and the same filter
    const teamDialect = JSON.parse(
      (await callTool(env, TEAM_TOKEN, "search", { query: "zebrafish" }))?.content?.[0]?.text
    );
    check(
      "the ChatGPT dialect shares the indexed path and its visibility filter",
      Array.isArray(teamDialect.results) &&
        teamDialect.results.length === 1 &&
        teamDialect.results[0].id === "1-projects/alpha/protocol.md" &&
        typeof teamDialect.results[0].title === "string" &&
        teamDialect.results[0].title.length > 0 &&
        !JSON.stringify(teamDialect).includes("ZEBRAFISH-PRIVATE-MARKER")
    );

    // (e) an edit is picked up by the etag diff; a deletion disappears
    bucket.seed(
      "1-projects/beta/plan.md",
      "# Beta plan\n\nBeta now mentions the OCTOPUS milestone.\n"
    );
    bucket.remove("1-projects/alpha/notes.md");
    const afterEdit = await searchText(env, OWNER_TOKEN, { query: "octopus" });
    check(
      "a note edited after indexing is re-indexed on the next search",
      afterEdit.includes("1-projects/beta/plan.md") && afterEdit.includes("OCTOPUS")
    );
    const afterDelete = await searchText(env, OWNER_TOKEN, { query: "pangolin" });
    check(
      "a deleted note disappears from results and from the index",
      afterDelete.includes("(no matches)") &&
        !indexedPaths(bucket).includes("1-projects/alpha/notes.md")
    );

    // (f) a corrupt manifest is a rebuild, never a throw and never a wrong
    // answer. The manifest is the diff surface, so garbage there is the whole
    // index gone as far as the next pass is concerned — v1's single object
    // wearing v2's shape.
    bucket.seed(MANIFEST_KEY, "{ this is not the manifest you are looking for");
    const afterCorrupt = await searchText(env, OWNER_TOKEN, { query: "zebrafish" });
    check(
      "a corrupt manifest still answers correctly",
      afterCorrupt.includes("1-projects/alpha/protocol.md") &&
        afterCorrupt.includes("1-projects/vault/secret.md")
    );
    check(
      "and is replaced with a valid one, with the notes back in its shards",
      storedManifest(bucket) !== null && indexedPaths(bucket).length > 0
    );

    // (g) a conditional-put conflict is a skipped write, not a retry loop. The
    // manifest is v2's concurrency point — shards are written unconditionally
    // under it — so the race is run on the manifest and counted there.
    bucket.seed("1-projects/beta/plan.md", "# Beta plan\n\nA CUTTLEFISH joins the milestone.\n");
    bucket.resetCounts();
    let manifestPuts = 0;
    bucket.setBeforePut((key, options) => {
      // Somebody else's sync landed between our read and our write. Changing the
      // stored etag makes the real precondition fail, rather than simulating it.
      if (key !== MANIFEST_KEY) return;
      manifestPuts += 1;
      if (options?.onlyIf) {
        const stored = bucket.objects.get(key);
        if (stored) stored.etag = `${stored.etag}-raced`;
      }
    });
    const afterConflict = await searchText(env, OWNER_TOKEN, { query: "cuttlefish" });
    bucket.setBeforePut(null);
    check(
      "a lost conditional write still answers the query it was serving",
      afterConflict.includes("1-projects/beta/plan.md")
    );
    check(
      "and does not retry: one attempt, then on with the query",
      manifestPuts === 1 && bucket.ops - PRIVACY_MANIFEST_READ <= SEARCH_SUBREQUEST_BUDGET
    );

    // The count's floor is read off what the caller can see, and this is the
    // channel that leaks by arithmetic rather than by content: a "+" on a team
    // connection's count over one visible hit would be one bit about every
    // private note that filled the list — the same subtraction the census is
    // owner-only to prevent.
    //
    // The fifty-five below no longer *can* fill a team connection's ranked
    // list: the shard collector gathers only the docs this caller can see, so
    // that list is scored over a corpus the private notes are not in — v1
    // narrowed the same corpus with `visibleIndex`, one whole index at a time,
    // and v2 does it one shard at a time, which is the only difference the
    // checks below can see. So this block now proves the arithmetic guard on
    // the owner's side and the emptiness of the channel on the team side,
    // which is why both checks stay. (An earlier version of this comment survived the fix that made it
    // false, in the same commit that corrected its twin ninety lines above —
    // caught by review, and the third time a retracted sentence has outlived
    // its own retraction here.)
    for (let n = 0; n < 55; n += 1) {
      bucket.seed(
        `1-projects/vault/bulk-${String(n).padStart(3, "0")}.md`,
        `# Vault bulk ${n}\n\nZEBRAFISH again, privately, number ${n}.\n`
      );
    }
    const bucketStore = new R2Store(bucket);
    await convergeV2(bucketStore);
    const teamAfterBulk = await searchText(env, TEAM_TOKEN, { query: "zebrafish" });
    const ownerAfterBulk = await searchText(env, OWNER_TOKEN, { query: "zebrafish" });
    check(
      "a bucket full of private matches puts no floor marker on a team connection's count",
      /^1 matching note$/m.test(teamAfterBulk) && !teamAfterBulk.includes("+ matching")
    );
    check(
      "while the connection that can see them is told its own count is a floor",
      /^50\+ matching notes/m.test(ownerAfterBulk)
    );

    // (d2) THE INFERENCE LINE. Everything above asks what index *data* reaches a
    // team connection. This asks the other question: does the SHAPE of a team
    // connection's own answer change when a note it cannot see changes? Both
    // channels below are the corpus statistics — `N`, `df`, `avglen` — which a
    // scorer reads over every doc it is handed, private ones included, unless
    // the step in front of it withholds them: `visibleIndex` in v1,
    // `collectShardCandidates` per shard in v2.
    //
    // CONTRACT.md § the index contains text drawn from private notes already
    // forbids this in its own words: "Nothing derived from a term's presence in
    // the vocabulary may reach a caller who could not read every note." It then
    // reasons that "fuzzy/prefix expansions are query rewrites, not output" —
    // which is the step that does not hold. A rewrite whose *trigger* is a
    // private note's contents is an output channel however it is spelled.

    // Channel one: whether an expansion fires at all. The scorer expands a
    // query term only when its df is zero, and df is counted over the whole
    // corpus it was given. So planting a word in a note the caller can see, and asking for a
    // prefix of it, turns the team connection's own answer into a test for
    // whether that exact prefix appears in some note it cannot see.
    bucket.seed(
      "1-projects/alpha/marsupials.md",
      "# Field notes\n\nThe QUOKKATRON survey ran all summer.\n"
    );
    await convergeV2(bucketStore);
    const teamBeforePlant = await searchText(env, TEAM_TOKEN, { query: "quokka" });
    bucket.seed(
      "1-projects/vault/expedition.md",
      "# Vault\n\nThe QUOKKA itself is filed privately and must never leave.\n"
    );
    await convergeV2(bucketStore);
    const teamAfterPlant = await searchText(env, TEAM_TOKEN, { query: "quokka" });
    check(
      "a private note appearing does not change what a team connection's own query answers",
      teamBeforePlant === teamAfterPlant
    );
    check(
      "and the answer it does not change is a real one, not two identical refusals",
      teamBeforePlant.includes("1-projects/alpha/marsupials.md")
    );
    check(
      "while the connection that can see the private note still finds it",
      (await searchText(env, OWNER_TOKEN, { query: "quokka" })).includes(
        "1-projects/vault/expedition.md"
      )
    );

    // Channel two: the order of results the caller *can* see. Two visible notes
    // match one query term each; their scores differ only by idf, which is a
    // function of N and of each term's df across the whole corpus. Private
    // notes carrying one of the two terms push that term's idf down and reorder
    // a list every path in which the caller may read.
    bucket.seed("2-areas/aa-wombat.md", "# Wombat census\n\nCounting burrows.\n");
    bucket.seed("2-areas/zz-numbat.md", "# Numbat census\n\nCounting termites.\n");
    await convergeV2(bucketStore);
    const orderOf = (text) =>
      (text.match(/^2-areas\/(?:aa-wombat|zz-numbat)\.md$/gm) || []).join(",");
    const teamOrderBefore = orderOf(await searchText(env, TEAM_TOKEN, { query: "wombat numbat" }));
    for (let n = 0; n < 8; n += 1) {
      bucket.seed(
        `1-projects/vault/wombat-${n}.md`,
        `# Vault wombat ${n}\n\nA private WOMBAT sighting, number ${n}.\n`
      );
    }
    await convergeV2(bucketStore);
    const teamOrderAfter = orderOf(await searchText(env, TEAM_TOKEN, { query: "wombat numbat" }));
    check(
      "and notes it cannot see do not reorder the ones it can",
      teamOrderBefore === teamOrderAfter
    );
    check(
      "with both of those visible notes actually in the ranking, so the order is an order",
      teamOrderBefore.split(",").length === 2
    );

    // Channel three: the same reordering through `rank` rather than `idf`. In
    // v1 this was the channel filtering could not close — PageRank is computed
    // once at index time over the whole link graph and stored on the doc — so it
    // had to be recomputed on the visible subgraph, and held by its own check.
    // v2 answers it by not having it: the link graph is global and a global
    // graph needs every shard in memory at maintenance time, which is the exact
    // blowup sharding exists to remove, so every doc carries a neutral rank
    // (CONTRACT.md § v2 "Query"). The check stays and is now about the property
    // rather than about the recomputation: whatever the ranking is built from,
    // a private note citing a visible one must not move it. The two notes below
    // carry one term between them, so idf is a common factor and nothing but the
    // link graph could separate them.
    bucket.seed("2-areas/aa-bilby.md", "# Bilby east\n\nEastern BILBY survey.\n");
    bucket.seed("2-areas/zz-bilby.md", "# Bilby west\n\nWestern BILBY survey.\n");
    await convergeV2(bucketStore);
    const bilbyOrder = (text) =>
      (text.match(/^2-areas\/(?:aa|zz)-bilby\.md$/gm) || []).join(",");
    const teamBilbyBefore = bilbyOrder(await searchText(env, TEAM_TOKEN, { query: "bilby" }));
    // Private notes carrying no query term at all, so the only thing they can
    // move is the graph.
    for (let n = 0; n < 6; n += 1) {
      bucket.seed(
        `1-projects/vault/citation-${n}.md`,
        `# Citation ${n}\n\nSee [the west](../../2-areas/zz-bilby.md) for the private workup.\n`
      );
    }
    await convergeV2(bucketStore);
    const teamBilbyAfter = bilbyOrder(await searchText(env, TEAM_TOKEN, { query: "bilby" }));
    check(
      "and private notes citing a visible one do not promote it for a team connection",
      teamBilbyBefore === teamBilbyAfter && teamBilbyBefore.split(",").length === 2
    );

}
