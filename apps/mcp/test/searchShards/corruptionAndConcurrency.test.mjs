/**
 * The manifest as the concurrency point, a corrupt shard rebuilt on the pass
 * that touches it, and the spare-budget audit that rebuilds a corrupt shard
 * nothing else edits. See searchShards.test.mjs for the module overview and
 * the sabotage-testing record.
 */

import {
  MANIFEST_KEY,
  R2Store,
  converge,
  createBucket,
  createSearchBudget,
  emptyManifest,
  fnv1a32,
  serializeManifest,
  shardKey,
  shardOf,
  storedManifest,
  storedShard,
  syncShardedIndex,
} from "./fixtures.mjs";

export async function runSearchShardsCorruptionAndConcurrencyChecks(check) {
  // -- the manifest is the concurrency point -------------------------------

  {
    const bucket = createBucket();
    for (let n = 0; n < 4; n += 1) {
      bucket.seed(`1-projects/note-${n}.md`, `# Note ${n}\n\nA QUOKKA, ${n}.\n`);
    }
    const store = new R2Store(bucket);
    await converge(store);

    bucket.seed("1-projects/note-1.md", "# Note 1\n\nA BILBY replaced the quokka.\n");
    bucket.resetCounts();
    bucket.setBeforePut((key, options) => {
      // Somebody else's sync landed between our read and our write. Changing
      // the stored etag makes the real precondition fail rather than simulating
      // a failure.
      if (key === MANIFEST_KEY && options?.onlyIf) {
        const stored = bucket.objects.get(key);
        if (stored) stored.etag = `${stored.etag}-raced`;
      }
    });
    const lost = await syncShardedIndex(store, { budget: createSearchBudget(60) });
    const manifestPuts = bucket.counts.puts.filter((key) => key === MANIFEST_KEY).length;
    bucket.setBeforePut(null);
    check(
      "a lost conditional manifest write is one attempt and no throw, not a retry loop",
      manifestPuts === 1 &&
        lost.manifest.docsByShard[0].get("1-projects/note-1.md") === bucket.etagOf("1-projects/note-1.md") &&
        storedManifest(bucket).docsByShard[0].get("1-projects/note-1.md") !==
          bucket.etagOf("1-projects/note-1.md")
    );
    const recovered = await converge(store);
    check(
      "and the next pass recovers, because the stale manifest is what the diff reads",
      recovered.pending === 0 &&
        storedManifest(bucket).docsByShard[0].get("1-projects/note-1.md") ===
          bucket.etagOf("1-projects/note-1.md") &&
        storedShard(bucket, 0).terms.has("bilby")
    );
  }

  // -- a corrupt shard is rebuilt, and the manifest never vouches for it ----

  {
    const bucket = createBucket();
    for (let n = 0; n < 5; n += 1) {
      bucket.seed(`1-projects/note-${n}.md`, `# Note ${n}\n\nA DUGONG, ${n}.\n`);
    }
    const store = new R2Store(bucket);
    await converge(store);
    // Corrupt the shard alone and edit one note in it. The manifest still
    // vouches for the other four, so a pass that took its staleness verdict as
    // the last word would re-fetch the edited note, write a shard holding only
    // that one, and leave four notes unsearchable until each was next edited —
    // silently, since the manifest would then agree with the shard.
    //
    // This is the half a stale note drives. The other half — a corrupt shard
    // that *nothing* touches, which no diff over the manifest can see — is the
    // block below: opening every shard per pass is the cost the manifest exists
    // to avoid, so one shard per pass is audited on spare budget instead.
    bucket.seed(shardKey(0), "{ this is not the shard you are looking for");
    bucket.seed("1-projects/note-2.md", "# Note 2\n\nA MANATEE now, not a dugong.\n");
    bucket.resetCounts();
    const rebuilt = await syncShardedIndex(store, { budget: createSearchBudget(60) });
    check(
      "a shard that will not parse is rebuilt from every note the listing names, not from the manifest's word",
      rebuilt.pending === 0 &&
        bucket.counts.noteGets.length === 5 &&
        storedShard(bucket, 0)?.docs.size === 5 &&
        storedShard(bucket, 0).terms.has("manatee") &&
        storedManifest(bucket).docsByShard[0].size === 5
    );
  }

  // -- a corrupt shard nothing edits is audited, on genuinely spare budget --

  {
    // The other half of the block above, and the case it used to call an
    // acceptable blind spot. A shard whose stored object is unreadable while
    // *no note in it changes* is in no worklist, so nothing ever opens it: the
    // manifest keeps vouching for its docs, `pending` reads 0 over them, and
    // the only cure is somebody happening to edit one of those notes. Since a
    // version-3 shard is refused by a gateway older than the interning change,
    // a rollback or a mixed deployment makes that every shard the newer one
    // rewrote — permanently unsearchable, silently.
    //
    // Fat budget and no edits anywhere, which is exactly the pass that used to
    // do nothing. The audit is one shard per pass and rotates on an injected
    // clock, so four passes over four shards reach the victim exactly once.
    const bucket = createBucket();
    bucket.seed(MANIFEST_KEY, serializeManifest(emptyManifest(4)));
    for (let n = 0; n < 24; n += 1) {
      bucket.seed(`1-projects/note-${n}.md`, `# Note ${n}\n\nA PANGOLIN, ${n}.\n`);
    }
    const store = new R2Store(bucket);
    await converge(store);
    const before = storedManifest(bucket);
    // The fullest shard, chosen from the manifest rather than assumed: which
    // ids `fnv1a32` fills is not this check's business.
    const victim = before.docsByShard.reduce(
      (best, docs, id) => (docs.size > before.docsByShard[best].size ? id : best),
      0
    );
    const vouched = [...before.docsByShard[victim].keys()];
    bucket.seed(shardKey(victim), "{ truncated by a writer this gateway refuses");
    bucket.resetCounts();

    // `base % 4 === 0`, so the four passes rotate over the four shards.
    const base = 4_000_000;
    let repairedOnPass = null;
    for (let pass = 0; pass < 4 && repairedOnPass === null; pass += 1) {
      await syncShardedIndex(store, { budget: createSearchBudget(400), now: base + pass });
      if (storedShard(bucket, victim)?.docs.size === vouched.length) repairedOnPass = pass;
    }
    check(
      "a corrupt shard no note of which was edited is audited and rebuilt, not vouched for forever",
      vouched.length > 0 &&
        repairedOnPass !== null &&
        vouched.every((path) => storedShard(bucket, victim).docs.has(path)) &&
        storedManifest(bucket).docsByShard[victim].size === vouched.length
    );
    check(
      "and the repair is the existing rebuild path: only the unreadable shard is rewritten",
      bucket.counts.puts.filter((key) => key.startsWith(".context/search/v2/shard-")).length === 1 &&
        bucket.counts.puts.includes(shardKey(victim)) &&
        bucket.counts.noteGets.length === vouched.length &&
        bucket.counts.noteGets.every((path) => vouched.includes(path))
    );

    // The bound itself, and the reason it is a bound: the sync does not own its
    // budget. `searchVisibleNotes` creates one budget, hands it here, and the
    // shard walk and snippet reads that answer the query spend what is left, so
    // an audit that grew into "open every shard the manifest names" would trade
    // a rare correctness bug for a permanent per-search cost — paid out of the
    // answer on exactly the widest buckets. One shard per pass, pinned as a
    // literal rather than read off the constant under test: an expectation
    // derived from that number moves with it and pins nothing.
    bucket.resetCounts();
    const healthy = await syncShardedIndex(store, {
      budget: createSearchBudget(400),
      now: base + 4,
    });
    check(
      "a healthy pass audits at most one shard, and never reads every shard the manifest names",
      healthy.pending === 0 &&
        before.shardCount === 4 &&
        bucket.counts.gets.filter((key) => key.startsWith(".context/search/v2/shard-")).length <= 1 &&
        // The manifest, stamping when this listing happened, and nothing else:
        // no shard rewritten, no diff rewritten, no note re-read.
        bucket.counts.puts.every((key) => key === MANIFEST_KEY) &&
        bucket.counts.noteGets.length === 0
    );

    // And "spare" is not "whatever is left after the manifest write". A budget
    // that covers the sync and little else is a budget the query walk still has
    // to come out of, so it buys no audit at all.
    //
    // Swept rather than sampled at one budget, because a single tight fixture
    // leaves the margin unpinned: `AUDIT_OPS` could be deleted from the
    // threshold and nothing would notice, which was measured — 0 failures
    // across 952. Measured boundary for this fixture: the audit first fires at
    // budget 11, so 8..10 is the band where those two ops are what is holding
    // it back, and the constant is held by its effect rather than by its own
    // doc comment.
    let auditedWhileTight = 0;
    for (let budget = 8; budget <= 10; budget += 1) {
      bucket.resetCounts();
      const tight = await syncShardedIndex(store, {
        budget: createSearchBudget(budget),
        now: base + 5 + budget,
      });
      if (tight.pending !== 0) auditedWhileTight = -1;
      auditedWhileTight += bucket.counts.gets.filter((key) =>
        key.startsWith(".context/search/v2/shard-")
      ).length;
    }
    check(
      "and a pass with no room to spare skips the audit rather than spending the query's ops on it",
      auditedWhileTight === 0
    );
  }

  {
    // An audit only opens a shard the manifest vouches for. A shard it says
    // holds nothing has no object to be unreadable, and the loop already
    // refuses to spend "a subrequest on a 404" to prove it — an audit that
    // rotated onto empty ids would buy that 404 back, on every small bucket
    // with a generous shard count, which is exactly where a search can least
    // afford it.
    const bucket = createBucket();
    bucket.seed(MANIFEST_KEY, serializeManifest(emptyManifest(4)));
    bucket.seed("1-projects/lonely.md", "# Lonely\n\nA SOLITARY OKAPI.\n");
    const store = new R2Store(bucket);
    await converge(store);
    const occupied = shardKey(shardOf("1-projects/lonely.md", 4));
    bucket.resetCounts();
    for (let pass = 0; pass < 4; pass += 1) {
      await syncShardedIndex(store, { budget: createSearchBudget(400), now: 4_000_000 + pass });
    }
    const audited = bucket.counts.gets.filter((key) => key.startsWith(".context/search/v2/shard-"));
    check(
      "the audit rotates only over shards the manifest vouches for, never onto an empty one",
      storedManifest(bucket).shardCount === 4 &&
        audited.length === 4 &&
        audited.every((key) => key === occupied) &&
        bucket.counts.puts.every((key) => key === MANIFEST_KEY)
    );
  }

}
