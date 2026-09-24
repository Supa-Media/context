/**
 * The manifest's own cap, budget discipline, a shard that could not be
 * afforded, a truncated listing, and one unreadable note. See
 * searchShards.test.mjs for the module overview and the sabotage-testing
 * record.
 */

import {
  MANIFEST_KEY,
  R2Store,
  converge,
  createBucket,
  createSearchBudget,
  emptyManifest,
  parseShard,
  pathsForShard,
  serializeManifest,
  shardKey,
  storedManifest,
  storedShard,
  syncShardedIndex,
} from "./fixtures.mjs";

export async function runSearchShardsBudgetAndFailuresChecks(check) {
  // -- the manifest's own cap ---------------------------------------------

  {
    const bucket = createBucket();
    for (let n = 0; n < 4; n += 1) {
      bucket.seed(`1-projects/note-${n}.md`, `# Note ${n}\n\nbody ${n}\n`);
    }
    const store = new R2Store(bucket);
    const overflowed = await syncShardedIndex(store, {
      budget: createSearchBudget(60),
      manifestByteCap: 120,
    });
    check(
      "a manifest past its own cap is not written, and says so rather than reporting a clean pass",
      overflowed.manifestOverflow === true &&
        bucket.objects.has(MANIFEST_KEY) === false &&
        bucket.objects.has(shardKey(0)) === true
    );
    const recovered = await syncShardedIndex(store, { budget: createSearchBudget(60) });
    check(
      "and the next pass under the real cap writes it, so the overflow is a plateau and not a death",
      recovered.manifestOverflow === false && storedManifest(bucket)?.docsByShard[0].size === 4
    );
  }

  // -- budget discipline ---------------------------------------------------

  {
    const bucket = createBucket();
    for (let folder = 0; folder < 5; folder += 1) {
      for (let n = 0; n < 8; n += 1) {
        bucket.seed(`f${folder}/note-${n}.md`, `# F${folder}N${n}\n\nA CAPYBARA, ${folder}-${n}.\n`);
      }
    }
    const store = new R2Store(bucket);
    bucket.resetCounts();
    const short = await syncShardedIndex(store, { budget: createSearchBudget(10) });
    check(
      "a pass that runs out of budget reports what it did not reach and never spends past the budget",
      short.pending > 0 && bucket.ops <= 10 && short.spent === bucket.ops
    );
    const reserved = createSearchBudget(24);
    bucket.resetCounts();
    const withReserve = await syncShardedIndex(store, { budget: reserved, reserve: 6 });
    check(
      "and a reserve is store ops the pass may not touch, whatever it still has to do",
      bucket.ops <= 24 - 6 && reserved.remaining >= 6 && withReserve.spent === bucket.ops
    );
    const converged = await converge(store);
    check(
      "repeated bounded passes converge on a complete index rather than treadmilling",
      converged.pending === 0 &&
        storedManifest(bucket).docsByShard.reduce((sum, docs) => sum + docs.size, 0) === 40
    );
  }

  // -- a shard it could not afford to read is left out, never emptied ------

  {
    // The one place "empty" and "could not look" must not be confused: a
    // budget refusal inside the loader is a `null`, exactly like an absent
    // object, so a pass that read the shard's affordability from the loader's
    // answer would treat a shard it never opened as empty — hand it back to the
    // query as empty, count every doc in it as pending, and (with one more op
    // than this fixture leaves) write the emptiness back over it.
    //
    // Driven across a range of budgets rather than at one arithmetic point, so
    // the check survives a change in what a pass spends. The invariant is the
    // same at every budget: a shard in the answer is one this pass actually
    // read or built.
    const template = createBucket();
    template.seed(MANIFEST_KEY, serializeManifest(emptyManifest(2)));
    const seeded = [...pathsForShard(2, 0, 2), ...pathsForShard(2, 1, 2)];
    for (const path of seeded) template.seed(path, `# ${path}\n\nA SALAMANDER lives at ${path}.\n`);
    await converge(new R2Store(template));

    let handedBackEmpty = 0;
    let skipped = 0;
    let probed = 0;
    for (let allowance = 3; allowance <= 14; allowance += 1) {
      const probe = createBucket();
      for (const [key, entry] of template.objects) probe.objects.set(key, { ...entry });
      // One stale note in each shard, so both shards have work and the budget
      // decides how far down the id order the pass gets.
      for (const id of [0, 1]) {
        const path = pathsForShard(2, id, 1)[0];
        probe.objects.set(path, {
          body: `# Edited\n\nA NEWT replaced the salamander at ${path}.\n`,
          etag: `edited-${id}-${allowance}`,
          uploaded: new Date(),
        });
      }
      const before = new Map([...probe.objects].map(([key, entry]) => [key, entry.body]));
      const pass = await syncShardedIndex(new R2Store(probe), {
        budget: createSearchBudget(allowance),
      });
      probed += 1;
      if (pass.shards.size < 2) skipped += 1;
      for (const [id, shard] of pass.shards) {
        if (probe.counts.puts.includes(shardKey(id))) continue;
        const storedBefore = before.has(shardKey(id)) ? parseShard(before.get(shardKey(id))) : null;
        if (storedBefore && shard.docs.size !== storedBefore.docs.size) handedBackEmpty += 1;
      }
    }
    check(
      "a shard the budget could not afford to read is left out of the answer, never handed back empty",
      probed === 12 && handedBackEmpty === 0 && skipped > 0
    );
  }

  // -- a truncated listing removes nothing ---------------------------------

  {
    // The listing walk is delimited at the root and flat per folder, and a
    // budget that dies inside the folders leaves whole regions unlisted. A doc
    // in one of them is not evidence of anything: removing it would delete the
    // index for exactly the largest contexts, silently, since a removal costs
    // no store op and reports nothing.
    const bucket = createBucket();
    for (let folder = 0; folder < 8; folder += 1) {
      bucket.seed(`f${folder}/note.md`, `# F${folder}\n\nA MARMOT in folder ${folder}.\n`);
    }
    const store = new R2Store(bucket);
    await converge(store);
    const before = storedManifest(bucket);

    const cut = await syncShardedIndex(store, { budget: createSearchBudget(8) });
    const after = storedManifest(bucket);
    check(
      "a doc whose folder the listing never reached is not removed for being absent from it",
      cut.listingTruncated === true &&
        before.docsByShard[0].size === 8 &&
        after.docsByShard[0].size === 8 &&
        storedShard(bucket, 0).docs.size === 8
    );
  }

  // -- one unreadable note is a skip, not a dead pass ----------------------

  {
    const bucket = createBucket();
    for (let n = 0; n < 6; n += 1) {
      bucket.seed(`1-projects/note-${n}.md`, `# Note ${n}\n\nAn AXOLOTL, ${n}.\n`);
    }
    bucket.failGetKeys.add("1-projects/note-3.md");
    const store = new R2Store(bucket);
    const poisoned = await syncShardedIndex(store, { budget: createSearchBudget(60) });
    check(
      "a note the store refuses to read is skipped and stays pending, and the rest still land",
      poisoned.pending === 1 &&
        storedShard(bucket, 0)?.docs.size === 5 &&
        storedShard(bucket, 0).docs.has("1-projects/note-3.md") === false
    );
    bucket.failGetKeys.delete("1-projects/note-3.md");
    const healed = await converge(store);
    check(
      "and it is picked up on a later pass, so a transient storage error is not permanent",
      healed.pending === 0 && storedShard(bucket, 0).docs.size === 6
    );
  }

}
