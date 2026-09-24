/**
 * A note indexed by its head at the v2 cap, and `loadShard`, the shared
 * per-shard loader every pass and every query call through. See
 * searchShards.test.mjs for the module overview and the sabotage-testing
 * record.
 */

import {
  R2Store,
  converge,
  createBucket,
  createSearchBudget,
  loadShard,
  shardKey,
  syncShardedIndex,
} from "./fixtures.mjs";

export async function runSearchShardsMiscChecks(check) {
  // -- a note is indexed by its head here too ------------------------------

  {
    // `NOTE_INDEX_CHAR_CAP` is v1's constant, imported rather than retyped, and
    // the slice is a second call site for it — an unsliced v2 would index 64KB
    // saved sessions whole, which is what bloated the v1 index past the memory
    // ceiling in the first place. Pinned by the token count the cap produces,
    // not by a search hit: a cut marker leaves a prefix in the vocabulary and
    // the expander finds it anyway, so a hit-based probe measures the expander.
    const bucket = createBucket();
    bucket.seed("1-projects/edge.md", "abc ".repeat(4000));
    const pass = await syncShardedIndex(new R2Store(bucket), { budget: createSearchBudget(20) });
    check(
      "a giant note is indexed by its head in a shard as well, at the same 2,048 characters",
      // 512 = 2,048 characters of "abc " groups. A literal, not a division of
      // the constant under test: an expected value derived from it moves with
      // it and pins nothing.
      pass.shards.get(0)?.docs.get("1-projects/edge.md")?.len.body === 512
    );
  }

  // -- the shared loader ---------------------------------------------------

  {
    const bucket = createBucket();
    bucket.seed("1-projects/note.md", "# Note\n\nA TAKAHE, once.\n");
    const store = new R2Store(bucket);
    await converge(store);

    const budget = createSearchBudget(3);
    const loaded = await loadShard(store, budget, 0, 0);
    const missing = await loadShard(store, budget, 0, 7);
    check(
      "loadShard reads one shard for one budget op, and answers null for one that is not there",
      loaded?.docs.has("1-projects/note.md") === true && missing === null && budget.spent === 2
    );
    const starved = createSearchBudget(1);
    const first = await loadShard(store, starved, 1, 0);
    check(
      "and it spends nothing it was told to reserve, answering null rather than dipping in",
      first === null && starved.spent === 0 && starved.remaining === 1
    );
    bucket.failGetKeys.add(shardKey(0));
    const refused = await loadShard(store, createSearchBudget(3), 0, 0);
    bucket.failGetKeys.delete(shardKey(0));
    check(
      "a shard the backend refuses is a null, not an exception out of the search",
      refused === null
    );
  }
}
