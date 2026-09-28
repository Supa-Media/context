/**
 * A pass over the notes a writer just changed — `syncShardedIndex`'s `only`.
 *
 * The reason it exists: nothing else makes a written note searchable. A search
 * starts a full pass only once the index's last listing is a minute old, and a
 * search that finds anything never waits for it, so a note written a moment
 * ago was missing from every answer that had other hits. A writer names its
 * own note, and this pass indexes that note without listing the bucket.
 *
 * What is pinned is what separates it from a full pass: it lists nothing, it
 * removes only what it was told about or asked for by name and could not
 * find, it leaves the freshness record to the listing that owns it, it does
 * nothing without an index to add to, and it never rebuilds a shard it could
 * not read — the one move that would write away notes it knows nothing about.
 */

import {
  MANIFEST_KEY,
  R2Store,
  converge,
  createBucket,
  createSearchBudget,
  shardKey,
  shardOf,
  storedManifest,
  storedShard,
  syncShardedIndex,
} from "./fixtures.mjs";

function seeded() {
  const bucket = createBucket();
  bucket.seed("privacy.md", "---\nrole: privacy-manifest\n---\n");
  for (let n = 0; n < 6; n += 1) {
    bucket.seed(`1-projects/note-${n}.md`, `# Note ${n}\n\nA PANGOLIN sighting, number ${n}.\n`);
  }
  return { bucket, store: new R2Store(bucket) };
}

function written(bucket, path) {
  return new Map([[path, { version: bucket.etagOf(path), uploaded: new Date().toISOString() }]]);
}

function shardHolding(bucket, path) {
  const manifest = storedManifest(bucket);
  const id = shardOf(path, manifest.shardCount);
  return { manifest, id, shard: storedShard(bucket, id) };
}

export async function runSearchShardsWriteTargetedChecks(check) {
  {
    const { bucket, store } = seeded();
    await converge(store);
    const listedAt = storedManifest(bucket).freshness.listedAt;

    const path = "1-projects/okapi.md";
    bucket.seed(path, "# Okapi\n\nAn OKAPI crossed the road.\n");
    bucket.resetCounts();
    const pass = await syncShardedIndex(store, {
      budget: createSearchBudget(40),
      only: written(bucket, path),
    });
    const { manifest, shard } = shardHolding(bucket, path);
    check(
      "a written note is indexed by the write's own pass, without listing the bucket",
      bucket.counts.list === 0 &&
        bucket.counts.noteGets.join(",") === path &&
        shard.terms.has("okapi") &&
        manifest.docsByShard[shardOf(path, manifest.shardCount)].get(path) === bucket.etagOf(path) &&
        pass.committed === true &&
        pass.touched.join(",") === path
    );
    check(
      "and it leaves the freshness record to the listing that owns it",
      manifest.freshness.listedAt === listedAt
    );

    bucket.resetCounts();
    const full = await syncShardedIndex(store, { budget: createSearchBudget(60) });
    check(
      "and the next full pass finds nothing left to read for it",
      bucket.counts.noteGets.length === 0 && full.pending === 0
    );

    bucket.seed(path, "# Giraffe\n\nRenamed to a GIRAFFE cousin.\n");
    await syncShardedIndex(store, { budget: createSearchBudget(40), only: written(bucket, path) });
    const edited = shardHolding(bucket, path).shard;
    check(
      "an edit replaces the note's terms rather than adding to them",
      edited.terms.has("giraffe") && !edited.terms.has("okapi")
    );

    bucket.remove(path);
    await syncShardedIndex(store, {
      budget: createSearchBudget(40),
      only: new Map([[path, null]]),
    });
    const removed = shardHolding(bucket, path);
    check(
      "a path the writer removed leaves the index",
      !removed.shard.docs.has(path) &&
        !removed.manifest.docsByShard[removed.id].has(path)
    );
  }

  {
    const { bucket, store } = seeded();
    await converge(store);
    // Gone from the bucket, and not named by this writer: only a listing may
    // decide it is gone.
    bucket.remove("1-projects/note-0.md");
    const path = "1-projects/okapi.md";
    bucket.seed(path, "# Okapi\n\nAn OKAPI.\n");
    await syncShardedIndex(store, { budget: createSearchBudget(40), only: written(bucket, path) });
    const manifest = storedManifest(bucket);
    const id = shardOf("1-projects/note-0.md", manifest.shardCount);
    check(
      "a note the writer did not name is never removed by its pass",
      manifest.docsByShard[id].has("1-projects/note-0.md")
    );
  }

  {
    const { bucket, store } = seeded();
    await converge(store);
    // Named, but not there when the pass asks for it by name.
    const path = "1-projects/note-1.md";
    bucket.remove(path);
    await syncShardedIndex(store, {
      budget: createSearchBudget(40),
      only: new Map([[path, { version: "stale-etag" }]]),
    });
    const { manifest, id } = shardHolding(bucket, path);
    check(
      "a named note its read cannot find is removed, as a full pass removes it",
      !manifest.docsByShard[id].has(path)
    );
  }

  {
    const bucket = createBucket();
    bucket.seed("1-projects/okapi.md", "# Okapi\n");
    const store = new R2Store(bucket);
    const pass = await syncShardedIndex(store, {
      budget: createSearchBudget(40),
      only: written(bucket, "1-projects/okapi.md"),
    });
    check(
      "with no index to add to, a write's pass writes nothing and leaves the build to a listing",
      bucket.counts.put === 0 && !bucket.objects.has(MANIFEST_KEY) && pass.committed === false
    );
  }

  {
    const { bucket, store } = seeded();
    await converge(store);
    const path = "1-projects/note-2.md";
    const { id } = shardHolding(bucket, path);
    bucket.objects.set(shardKey(id), { body: "{not json", etag: "broken", uploaded: new Date() });
    bucket.seed(path, "# Note 2\n\nNow about an OKAPI.\n");
    bucket.resetCounts();
    const pass = await syncShardedIndex(store, {
      budget: createSearchBudget(40),
      only: written(bucket, path),
    });
    check(
      "a shard the pass cannot read is left for a listing to rebuild, never rebuilt from one note",
      !bucket.counts.puts.includes(shardKey(id)) &&
        bucket.objects.get(shardKey(id)).body === "{not json" &&
        pass.pending === 1
    );
  }
}
