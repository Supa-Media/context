/**
 * A sync pass: a fresh bucket's first pass, incremental placement, removal,
 * and the per-shard write cap that plateaus one shard without stalling its
 * neighbours. See searchShards.test.mjs for the module overview and the
 * sabotage-testing record.
 */

import {
  LEGACY_V1_KEY,
  MANIFEST_KEY,
  NOTE_INDEX_CHAR_CAP,
  R2Store,
  bytesOf,
  chooseShardCount,
  converge,
  createBucket,
  createSearchBudget,
  emptyManifest,
  fnv1a32,
  pathsForShard,
  serializeManifest,
  shardKey,
  shardOf,
  storedManifest,
  storedShard,
  syncShardedIndex,
} from "./fixtures.mjs";

export async function runSearchShardsSyncBehaviorChecks(check) {
  // -- a first pass on a fresh bucket -------------------------------------

  {
    const bucket = createBucket();
    bucket.seed("privacy.md", "---\nrole: privacy-manifest\n---\n");
    bucket.seed(LEGACY_V1_KEY, JSON.stringify({ version: 1, generatedAt: "", docs: [], terms: [] }));
    bucket.seed("index.md", "# Front page\n\nThe map of everything.\n");
    for (let n = 0; n < 6; n += 1) {
      bucket.seed(`1-projects/note-${n}.md`, `# Note ${n}\n\nA PANGOLIN sighting, number ${n}.\n`);
    }
    bucket.seed(".history/index.md.2020-01-01.md", "# Front page\n\nold\n");
    const store = new R2Store(bucket);

    const first = await syncShardedIndex(store, { budget: createSearchBudget(60) });
    const manifest = storedManifest(bucket);
    check(
      "a first pass on a bucket with no manifest writes one, sized by the notes it listed",
      manifest !== null &&
        manifest.version === 3 &&
        manifest.shardCount === chooseShardCount(7) &&
        // The freshness record a search reads instead of listing for itself.
        typeof manifest.freshness.listedAt === "string" &&
        manifest.freshness.pending === 0 &&
        first.pending === 0 &&
        first.listingTruncated === false &&
        first.manifestOverflow === false
    );
    check(
      "and every indexable note is in the manifest, with no plumbing key beside them",
      [...manifest.docsByShard[0].keys()].sort().join(",") ===
        ["index.md", ...Array.from({ length: 6 }, (_, n) => `1-projects/note-${n}.md`)].sort().join(",")
    );
    check(
      "the shard object it wrote parses back and holds those docs and their postings",
      storedShard(bucket, 0)?.docs.size === 7 &&
        storedShard(bucket, 0).terms.get("pangolin")?.size === 6
    );
    check(
      "the manifest's stats count what the shard holds rather than a number of their own",
      manifest.stats[0].docCount === 7 &&
        manifest.stats[0].lenTotals.body ===
          [...storedShard(bucket, 0).docs.values()].reduce((sum, doc) => sum + doc.len.body, 0)
    );
    check(
      "v1's object is deleted on the pass that first creates a manifest",
      bucket.objects.has(LEGACY_V1_KEY) === false && bucket.counts.delete === 1
    );

    // The other half of that rule: the delete is tied to *creating* the
    // manifest, not spent on every pass. A delete per search is a subrequest
    // per search bought for nothing.
    bucket.seed(LEGACY_V1_KEY, "{}");
    bucket.seed("1-projects/note-0.md", "# Note 0\n\nAn OCELOT now, not a pangolin.\n");
    bucket.resetCounts();
    await syncShardedIndex(store, { budget: createSearchBudget(60) });
    check(
      "and a later pass spends no delete, so v1 is not probed on every search",
      bucket.counts.delete === 0 && bucket.objects.has(LEGACY_V1_KEY)
    );

    bucket.resetCounts();
    const idle = await syncShardedIndex(store, { budget: createSearchBudget(60) });
    check(
      "a converged index re-syncs without re-reading a single note body or rewriting a shard",
      idle.pending === 0 &&
        bucket.counts.noteGets.length === 0 &&
        // Nothing but the manifest, and at most once: what it writes is the
        // stamp saying when this listing happened, which is what a search reads
        // instead of listing the bucket itself. A converged pass that wrote
        // nothing at all would leave every search believing the index had never
        // been listed, and starting a pass to find out. `<= 1` rather than `=== 1`
        // because two passes inside one millisecond stamp the same instant and
        // the second has nothing to record. The shard and the diff are what must
        // not move: those are the megabytes.
        bucket.counts.put <= 1 &&
        bucket.counts.puts.every((key) => key === MANIFEST_KEY) &&
        // One shard read, and only one: the audit below, which opens a single
        // vouched-for shard per pass so an unreadable one is noticed rather
        // than vouched for until somebody edits a note in it. It finds this one
        // healthy, which is why nothing above it moves — no note body, no write.
        // The bound is what this half pins; the audit's own block pins the rest.
        bucket.counts.gets.filter((key) => key.startsWith(".context/search/v2/shard-")).length <= 1
    );
  }

  // -- placement, incremental work, and removal ---------------------------

  {
    // A manifest is seeded at shardCount 4 rather than grown to it: the sizing
    // rule needs 301 notes for a second shard, and what is under test here is
    // where a note lands and what one edit costs, not the arithmetic that was
    // pinned above.
    const bucket = createBucket();
    bucket.seed(MANIFEST_KEY, serializeManifest(emptyManifest(4)));
    const notes = [];
    for (let n = 0; n < 16; n += 1) {
      const path = `1-projects/note-${n}.md`;
      bucket.seed(path, `# Note ${n}\n\nA WOMBAT burrow, number ${n}.\n`);
      notes.push(path);
    }
    const store = new R2Store(bucket);
    await converge(store);

    const manifest = storedManifest(bucket);
    check(
      "a seeded shardCount survives the pass rather than being re-chosen under it",
      manifest?.shardCount === 4
    );
    check(
      "every note is in the shard fnv1a32 names, in the manifest and in the object",
      notes.every((path) => {
        const id = shardOf(path, 4);
        return manifest.docsByShard[id].has(path) && storedShard(bucket, id)?.docs.has(path);
      }) &&
        notes.every((path) =>
          manifest.docsByShard.every((docs, id) => (id === shardOf(path, 4)) === docs.has(path))
        )
    );

    // One edit. The diff is the manifest against the listing, so only the one
    // shard may be read, and only the one shard plus the manifest written.
    const edited = notes.find((path) => shardOf(path, 4) === 1) || notes[0];
    const editedShard = shardOf(edited, 4);
    bucket.seed(edited, "# Note edited\n\nA NUMBAT replaced the wombat.\n");
    bucket.resetCounts();
    const incremental = await syncShardedIndex(store, { budget: createSearchBudget(60) });
    const shardGets = bucket.counts.gets.filter((key) => key.startsWith(".context/search/v2/shard-"));
    const shardPuts = bucket.counts.puts.filter((key) => key.startsWith(".context/search/v2/shard-"));
    check(
      "editing one note re-reads and re-writes exactly the shard that note is in",
      incremental.pending === 0 &&
        // Read: the edited note's shard, plus at most the one shard a pass may
        // audit on spare budget — never a second shard of *work*. Written: the
        // edited shard alone, because an audit that finds its shard readable
        // writes nothing. And exactly one note body, whatever the audit read.
        shardGets.includes(shardKey(editedShard)) &&
        shardGets.length <= 2 &&
        shardPuts.length === 1 &&
        shardPuts[0] === shardKey(editedShard) &&
        bucket.counts.noteGets.length === 1 &&
        bucket.counts.noteGets[0] === edited
    );
    check(
      "and the manifest is written once, with the new version token for that note",
      bucket.counts.puts.filter((key) => key === MANIFEST_KEY).length === 1 &&
        storedManifest(bucket).docsByShard[editedShard].get(edited) === bucket.etagOf(edited) &&
        storedShard(bucket, editedShard).terms.has("numbat")
    );

    // A deletion. Free — no store op — so it always runs to completion, and it
    // has to leave both the shard and the bookkeeping without the doc.
    const removed = notes.find((path) => path !== edited);
    const removedShard = shardOf(removed, 4);
    bucket.remove(removed);
    await syncShardedIndex(store, { budget: createSearchBudget(60) });
    check(
      "a deleted note leaves its shard and its docsByShard entry, not just the listing",
      storedShard(bucket, removedShard)?.docs.has(removed) === false &&
        storedManifest(bucket).docsByShard[removedShard].has(removed) === false &&
        storedManifest(bucket).stats[removedShard].docCount ===
          storedShard(bucket, removedShard).docs.size
    );
  }

  // -- one shard past its cap plateaus; its neighbours do not -------------

  {
    // A shard with a large vocabulary and a shard with almost none, under a cap
    // measured between the two. The cap is injected rather than reached: two
    // real megabytes of shard would take a fixture nobody can read.
    const bigPath = pathsForShard(2, 0, 1)[0];
    const smallPath = pathsForShard(2, 1, 1)[0];
    // Distinct tokens, inside NOTE_INDEX_CHAR_CAP, so the vocabulary is the
    // whole difference between the two shards.
    const wide = Array.from({ length: 180 }, (_, i) => `tok${i.toString(36)}zq`).join(" ");

    const seedBoth = (bucket) => {
      bucket.seed(MANIFEST_KEY, serializeManifest(emptyManifest(2)));
      bucket.seed(bigPath, `# Wide\n\n${wide}\n`);
      bucket.seed(smallPath, "# Narrow\n\nthree short words\n");
    };

    const measured = createBucket();
    seedBoth(measured);
    await converge(new R2Store(measured));
    const bigBytes = bytesOf(measured.objects.get(shardKey(0)).body);
    const smallBytes = bytesOf(measured.objects.get(shardKey(1)).body);

    const capped = createBucket();
    seedBoth(capped);
    const cappedStore = new R2Store(capped);
    const shardByteCap = smallBytes + 100;
    const refused = await syncShardedIndex(cappedStore, {
      budget: createSearchBudget(60),
      shardByteCap,
    });
    // Which shard each note ended up in is read off the pass rather than
    // assumed: `shardByteCap` scales the sizing as well as the write (a small
    // shard really does hold fewer notes), so the index grows past the two
    // shards seeded above and the ids are a function of the final count. What
    // is on trial is the *containment* — one shard refused, its neighbour
    // written — and that is what these assert.
    const idOf = (path) => {
      for (const [id, shard] of refused.shards) if (shard.docs.has(path)) return id;
      return -1;
    };
    const bigId = idOf(bigPath);
    const smallId = idOf(smallPath);
    check(
      "the two notes are in different shards, so containment is what is being measured",
      bigId !== -1 && smallId !== -1 && bigId !== smallId
    );
    check(
      "a shard whose serialized form crosses the cap sheds the note that did it, and is written",
      shardByteCap < bigBytes &&
        capped.objects.has(shardKey(bigId)) === true &&
        capped.objects.has(shardKey(smallId)) === true &&
        bytesOf(capped.objects.get(shardKey(bigId)).body) <= shardByteCap
    );
    check(
      "...naming that note rather than reporting work still outstanding",
      refused.shed.length === 1 &&
        refused.shed[0] === bigPath &&
        refused.oversizedShards === 0 &&
        refused.pending === 0
    );
    check(
      "...and the note stays recorded at its version, so the diff converges rather than re-fetching it",
      storedManifest(capped)?.docsByShard[bigId].get(bigPath) === capped.etagOf(bigPath) &&
        storedManifest(capped)?.stats[bigId].shed === 1 &&
        storedManifest(capped)?.docsByShard[smallId].size === 1
    );
    const again = await syncShardedIndex(cappedStore, {
      budget: createSearchBudget(60),
      shardByteCap,
    });
    check(
      "and a second pass under the same cap has nothing to do rather than shedding it again",
      again.pending === 0 && again.shed.length === 0 && again.touched.length === 0
    );
  }

}
