import { indexableText } from "../../encryption.js";
import { buildTermFilter } from "../filter.js";
import { addDoc, removeDocsForNote } from "../indexer.js";
import { indexVolumeOf, subDocumentsFor } from "../commsIndex.js";
import { createSearchBudget, defaultIsIndexable, exceedsUtf8Bytes } from "../maintain.js";
import {
  MANIFEST_KEY,
  DOCMAP_KEY,
  LEGACY_V1_KEY,
  SHARD_PARSE_BYTE_CAP,
  MANIFEST_PARSE_BYTE_CAP,
  INDEX_VOLUME_PER_SHARD,
  SHARD_VOLUME_CAP,
  MANIFEST_WRITE_RESERVE,
  SHARD_WRITE_RESERVE,
  BACKFILL_CONCURRENCY,
  AUDIT_OPS,
  FILTER_BACKFILL_PER_SYNC,
  NEUTRAL_RANK,
} from "./constants.js";
import { emptyManifest, emptyShard } from "./shapes.js";
import { chooseShardCount, growManifest, placeUnclaimed, shardOf, shardKey } from "./placement.js";
import { serializeManifest, serializeDocmap, parseDocmap, parseManifest, serializeShard } from "./serialize.js";
import { loadShard } from "./io.js";
import { listNoteObjects } from "./listing.js";
import {
  statsOfShard,
  docVersionsOf,
  sameVersions,
  sameStats,
  shedToFit,
  pushInto,
  nowMsOf,
  auditCandidates,
} from "./maintenance.js";

export async function syncShardedIndex(
  store,
  {
    budget,
    reserve = 0,
    isIndexable = defaultIsIndexable,
    /**
     * Injectable so a test can drive the whole loop against a small number
     * instead of building two real megabytes of JSON per shard. Nothing in
     * production passes them. Each is **one** parameter governing read and
     * write together, as v1's `byteCap` is: two numbers that can disagree is
     * the divergent loop the single parameter exists to remove — and each is
     * re-checked rather than trusted, because a default parameter only fires on
     * `undefined`, so an explicit `null` would refuse every write and a `NaN`
     * would allow every write while refusing every read.
     */
    shardByteCap: requestedShardCap = SHARD_PARSE_BYTE_CAP,
    manifestByteCap: requestedManifestCap = MANIFEST_PARSE_BYTE_CAP,
    /**
     * Store ops to keep back **per shard the caller will have to open**, on top
     * of `reserve`.
     *
     * `reserve` alone was the snippet reads, and that was the whole of what a
     * caller was assumed to owe after this returns. It is not: the query walk
     * opens one shard per occupied shard before it can read a snippet at all,
     * and this loop spent every op down to `reserve` before that walk began. On
     * a bucket wide enough to need several passes the result was not a slow
     * answer, it was a **wrong** one — measured, on a 1,500-note fixture at a
     * budget of 120: passes 4 onward answered `0 matching notes` for a term
     * carried by every note in the bucket, because the sync had left the walk
     * nothing to open a shard with, and the same shape produced thirteen
     * consecutive false misses on a 7,961-note fixture at 600.
     *
     * A miss is the one answer this system must not get wrong — it is what
     * `toolSearchNotes`'s miss copy exists to argue against, and an agent that
     * reads it concludes the thing was never written down. So the caller's
     * later work is reserved *before* maintenance may spend anything, and the
     * cost is paid where it belongs: on a budget too small to do both, the
     * answer is served and the index simply does not grow that pass.
     *
     * Counted over shards the manifest says hold documents, because the walk
     * skips the empty ones on the same authority.
     */
    walkReserve = 0,
    /**
     * Note reads this pass may spend on the backfill, or `Infinity`.
     *
     * The budget bounds what a search may spend; it does not bound what a
     * person **waits for**, and on a paid-plan budget of 600 those are wildly
     * different numbers — ~580 note reads, which is 40-60 seconds against a
     * real bucket and was the reported failure this whole change is about. A
     * search is an interactive request; finishing somebody's index is not.
     *
     * So the gateway hands this a small number and continues the same sync
     * after the response has been sent (`searchVisibleNotes`, `store.defer`).
     * The default is `Infinity` because a caller with no such deadline —
     * the console, running in a Convex action with no subrequest cap — should
     * keep making real progress on a cold bucket rather than nibbling at it.
     *
     * It caps note reads rather than every op: the listing is what tells the
     * diff which notes are stale, and a pass that cannot finish listing reports
     * `listingTruncated` on a converged bucket, which is a banner that says the
     * index is catching up when it is not. Shard and manifest writes are not
     * capped either — they persist what was already fetched, and refusing them
     * would spend the reads and land nothing.
     */
    backfillOps = Infinity,
    /**
     * The clock the audit rotates on — a `Date`, a number of milliseconds, or
     * absent for the wall clock. Injectable for the same reason `searchIndex`'s
     * is: which shard a pass audits is otherwise a function of when the test
     * ran. Nothing in production passes it.
     */
    now,
  } = {}
) {
  const shardCap = Number.isFinite(requestedShardCap) ? requestedShardCap : SHARD_PARSE_BYTE_CAP;
  const manifestCap = Number.isFinite(requestedManifestCap)
    ? requestedManifestCap
    : MANIFEST_PARSE_BYTE_CAP;
  const ops = typeof budget === "object" && budget ? budget : createSearchBudget(budget);
  const shards = new Map();

  if (!ops.take(reserve)) {
    return {
      manifest: emptyManifest(1),
      shards,
      pending: 0,
      listingTruncated: true,
      manifestOverflow: false,
      touched: [],
      removed: [],
      changed: false,
      committed: false,
      shed: [],
      oversizedShards: 0,
      spent: ops.spent,
    };
  }
  // Not wrapped in a `try`: an unreadable manifest object is a storage failure
  // rather than a corrupt derivative — a revoked key or a 500 — and the caller
  // catches it and falls back to the bounded scan, exactly as it does for v1.
  const storedManifest = await store.get(MANIFEST_KEY);
  const manifestExisted = Boolean(storedManifest);
  const manifestEtag =
    typeof storedManifest?.etag === "string" && storedManifest.etag ? storedManifest.etag : null;
  let manifest = null;
  if (storedManifest) {
    const bytes = await storedManifest.arrayBuffer();
    manifest =
      (bytes.byteLength <= manifestCap &&
        parseManifest(new TextDecoder().decode(bytes), manifestCap)) ||
      null;
  }

  // A stored manifest that arrived with its diff inline is a v2 one, and this
  // pass is its migration: the diff has to be written out to `DOCMAP_KEY` even
  // if nothing about the index changes, or the v3 manifest this pass writes
  // would point at a docmap that does not exist and the next pass would
  // re-index the whole bucket.
  const migratingFromV2 = Boolean(manifest && manifest.docmapLoaded);

  // The diff, where the manifest is v3 and did not bring it. One op, spent
  // before the listing rather than after it, because everything the listing
  // decides — which notes are stale, which are gone — is decided *against* this
  // map. A docmap that cannot be read or does not match the shard count leaves
  // the maps empty, which makes every listed note look stale: the whole bucket
  // is re-indexed into the shards it already lives in. Slow and correct, and it
  // converges, which is the direction an unknown falls everywhere in this file.
  let externalDocmapExisted = false;
  if (manifest && !manifest.docmapLoaded && ops.take(reserve)) {
    const storedDocmap = await store.get(DOCMAP_KEY);
    externalDocmapExisted = Boolean(storedDocmap);
    if (storedDocmap) {
      const bytes = await storedDocmap.arrayBuffer();
      const docsByShard =
        (bytes.byteLength <= manifestCap &&
          parseDocmap(new TextDecoder().decode(bytes), manifest.shardCount, manifestCap)) ||
        null;
      if (docsByShard) manifest.docsByShard = docsByShard;
    }
    manifest.docmapLoaded = true;
  }

  // What the caller still owes after this returns, settled before this pass
  // spends anything on maintenance. `reserve` is its snippet reads;
  // `walkReserve` is one op per shard it will have to open, counted over the
  // shards the stored manifest says hold documents — the same set the walk
  // itself fetches, since an empty shard is never asked for. A bucket with no
  // manifest has no shards to walk, so it owes nothing extra.
  const occupiedShards = manifest
    ? manifest.stats.reduce((count, entry) => count + (entry.docCount > 0 ? 1 : 0), 0)
    : 0;
  const perShard = Number.isFinite(walkReserve) ? Math.max(0, Math.floor(walkReserve)) : 0;
  // If the first pass had no room to retire v1, it deliberately left the
  // recoverable docmap cache absent as the retry signal. A later pass holding
  // that signal keeps both physical marker operations through its writes.
  const legacyCleanupNeeded =
    !manifestExisted || Boolean(manifest && !migratingFromV2 && !externalDocmapExisted);
  const legacyCleanupReserve = manifestExisted && legacyCleanupNeeded ? 2 : 0;
  const postCleanupReserve = reserve + perShard * occupiedShards;
  const callerReserve = postCleanupReserve + legacyCleanupReserve;
  const backfillCap = Number.isFinite(backfillOps) ? Math.max(0, Math.floor(backfillOps)) : Infinity;
  let fetchedNotes = 0;

  // The listing comes before a fresh manifest is minted, because `shardCount`
  // is a function of how many notes there are. On a truncated first listing
  // that count is a floor and the shard count is therefore low — the honest
  // failure, since the alternative is refusing to index the largest workspaces at
  // all, and re-sharding is deleting the manifest.
  const { entries, regionComplete, truncated } = await listNoteObjects(
    store,
    ops,
    callerReserve,
    isIndexable
  );

  let manifestChanged = false;
  // Tracked apart from `manifestChanged` because the two objects change for
  // different reasons and at wildly different sizes. The manifest moves on
  // every pass (its freshness record carries the time of the listing); the
  // diff moves only when a shard's documents do, and rewriting a megabyte of
  // it to record that nothing happened is a standing cost on a converged
  // bucket.
  let docmapChanged = migratingFromV2;

  // What this bucket's notes will take up in the index, from the listing
  // alone — the number the sizing was missing. See `indexVolumeOf`: an
  // ordinary note is worth at most one per-note window however large the file
  // is, and a channel-day note is worth its bytes, because its documents are
  // a set rather than one.
  let listedVolume = 0;
  for (const [path, listed] of entries) listedVolume += indexVolumeOf(path, listed.size);
  // Both derived from the one injected cap, so a test that shrinks the shard
  // shrinks the sizing with it and the two cannot be driven apart — the same
  // argument `shardByteCap` itself makes about read and write.
  const capScale = shardCap / SHARD_PARSE_BYTE_CAP;
  const volumePerShard = Math.max(1, Math.floor(INDEX_VOLUME_PER_SHARD * capScale));
  const volumeCap = Math.max(1, Math.floor(SHARD_VOLUME_CAP * capScale));
  const needed = chooseShardCount(entries.size, listedVolume, volumePerShard);

  if (!manifest) {
    manifest = emptyManifest(needed);
    manifestChanged = true;
  } else if (growManifest(manifest, needed)) {
    // An index that outgrew its shard count, grown in place. Both objects have
    // to record it: the manifest because it is the query surface, and the
    // docmap because it carries the shard count too and a docmap for the old
    // count is refused by the next pass — which is safe (everything looks
    // stale) and would re-index the whole bucket to learn what it knew.
    manifestChanged = true;
    docmapChanged = true;
  }

  // Where the manifest claims each doc lives. A doc is re-indexed into the
  // shard that already holds it rather than into the one `shardOf` names today:
  // the two agree for every manifest this module wrote, and where a
  // hand-written one disagrees, honouring the claim keeps one copy of the doc
  // instead of creating a second that nothing ever removes. It is also what
  // makes growth free — an existing doc never moves.
  const claimedShard = new Map();
  for (let id = 0; id < manifest.shardCount; id += 1) {
    for (const path of manifest.docsByShard[id].keys()) claimedShard.set(path, id);
  }

  // ...and where everything else goes. `placeUnclaimed` may grow the manifest
  // again, one shard at a time, for a bundled note that fits in none of the
  // ones there are — so `shardCount` is read only after it has run.
  const countBeforePlacement = manifest.shardCount;
  const placement = placeUnclaimed(manifest, entries, claimedShard, volumeCap);
  if (manifest.shardCount > countBeforePlacement) {
    manifestChanged = true;
    docmapChanged = true;
  }
  const { shardCount } = manifest;

  /**
   * What this pass moved, for whoever else derives from the same notes.
   *
   * The D1 projection (`search/d1/backfill.js`) is the same event with a
   * second destination: it copies note text into a database the customer opted
   * into, and it must know which notes changed and which are gone. Deriving
   * that again — a second listing, a second diff — would be a second answer to
   * "what changed", which is the same objection this file makes to a second
   * maintenance path.
   *
   * Collected on the in-memory `addDoc`/`removeDoc` rather than on a
   * successful write, deliberately: a shard whose write was refused is
   * re-fetched next pass and reported again, and the projection's own upsert
   * is idempotent. Over-reporting costs a repeat; under-reporting loses an
   * edit.
   */
  const touchedPaths = new Set();
  const removedPaths = new Set();

  const staleByShard = new Map();
  const queued = new Set();
  for (const [path, listed] of entries) {
    const id = claimedShard.has(path) ? claimedShard.get(path) : placement.get(path);
    if (manifest.docsByShard[id].get(path) === listed.version) continue;
    pushInto(staleByShard, id, [path, listed]);
    queued.add(path);
  }

  const removalsByShard = new Map();
  for (const [path, id] of claimedShard) {
    if (entries.has(path)) continue;
    // The only ground for a removal: the region this path lives in was listed
    // to the end. An unfinished listing is not evidence that a key is gone.
    if (!regionComplete(path)) continue;
    pushInto(removalsByShard, id, path);
  }

  const ids = [...new Set([...staleByShard.keys(), ...removalsByShard.keys()])].sort((a, b) => a - b);
  // Appended rather than merged into the sorted order: the work the diff asked
  // for goes first and spends first, and an audit gets only what that leaves.
  // The shard-id order the contract states is the order of the real work.
  const auditing = new Set(auditCandidates(manifest, new Set(ids), nowMsOf(now)));

  /**
   * Shards that hold documents and have no routing filter.
   *
   * Every index that exists today is one: filters arrived after them, and a
   * converged bucket's sync touches no shard, so without this the migration
   * would complete only as each shard happened to be edited — which for a shard
   * nobody edits is never. A few per pass, appended behind the real work and
   * the audit, and each costs one read and no write of its own.
   */
  const filtering = new Set();
  for (let id = 0; id < shardCount && filtering.size < FILTER_BACKFILL_PER_SYNC; id += 1) {
    if (ids.includes(id) || auditing.has(id)) continue;
    if (manifest.filters[id] !== null) continue;
    if ((manifest.stats[id]?.docCount || 0) === 0) continue;
    filtering.add(id);
  }
  let pending = 0;
  /**
   * Notes this pass could not index in full, and shards it could not write at
   * all — the two ways the index is knowingly incomplete for a reason no
   * amount of further passes will resolve, as against `pending`, which is
   * "not reached yet".
   *
   * Reported rather than folded into `pending`, because the two ask for
   * opposite things from a caller: `pending` says run another pass, and these
   * say the corpus does not fit the index it has and somebody has to know.
   */
  const shedPaths = new Set();
  let oversizedShards = 0;

  for (const id of [...ids, ...auditing, ...filtering]) {
    const stale = staleByShard.get(id) || [];
    const removals = removalsByShard.get(id) || [];
    // An audit is spare-budget work, so "spare" is measured where it would be
    // spent rather than before the real work spent anything. The threshold is
    // the ordinary guard below **plus** what an audit can cost (a read and a
    // rebuild's write) plus one op per shard for the query walk that follows
    // this sync on the same budget — because ops taken here are snippet reads
    // the answer does not get, and a search that renders no snippet reads as
    // "the thing is not written down". A pass with only the ordinary guard's
    // slack left is a pass whose caller still has its whole answer to buy.
    //
    // In steady state the read is not even lost work: a shard this loop loaded
    // is handed back in `shards`, and the query walk in `searchVisibleNotes`
    // reuses what the sync already read rather than fetching it again.
    // A filter backfill is the same kind of spare-budget work as an audit and
    // is gated on the same line, for the same reason: it reads a shard the diff
    // asked nothing of, and an op taken here is an op the answer does not get.
    if (
      (auditing.has(id) || filtering.has(id)) &&
      ops.remaining <= callerReserve + MANIFEST_WRITE_RESERVE + AUDIT_OPS + shardCount
    ) {
      continue;
    }
    // Once the interactive share of the backfill is spent, a shard whose only
    // work is fetching is skipped rather than opened: the read would land
    // nothing. Removals are free and correcting, so a shard that has them still
    // runs. An audit reaches here with neither, so this is also where a capped
    // pass stops auditing — spare-budget work has no spare pass to be in.
    if (fetchedNotes >= backfillCap && removals.length === 0) {
      pending += stale.length;
      continue;
    }
    // Checked, not attempted. A budget refusal inside `loadShard` is
    // indistinguishable from an empty shard, and rebuilding a shard from
    // "empty" when we were never allowed to look at it would write away every
    // doc in it. One op for the read, one kept back for the manifest write.
    if (ops.remaining <= callerReserve + MANIFEST_WRITE_RESERVE) {
      pending += stale.length;
      continue;
    }

    // Skipped where the manifest says the shard holds nothing: there is no
    // object to read, and a GET to prove it is a subrequest spent on a 404.
    const hasStored = manifest.docsByShard[id].size > 0;
    const loaded = hasStored
      ? await loadShard(store, ops, callerReserve + MANIFEST_WRITE_RESERVE, id, shardCap)
      : null;
    const shard = loaded || emptyShard();
    shards.set(id, shard);

    // The work list is derived from the shard that actually arrived, not from
    // the manifest: a shard that failed to parse claims docs it does not hold,
    // and re-fetching only the manifest-stale ones would rebuild it missing
    // every other doc — silently, until each was next edited.
    //
    // Compared against `existingVersions` (by **note** path) rather than
    // `shard.docs.get(path)?.etag` (by doc key): a channel-day note's docs are
    // keyed `path#anchor`, so `shard.docs.get(path)` for the note's own path
    // finds nothing even when every one of its sub-documents is current.
    const existingVersions = docVersionsOf(shard);
    const work = [...stale];
    for (const path of manifest.docsByShard[id].keys()) {
      if (queued.has(path)) continue;
      const listed = entries.get(path);
      if (!listed) continue;
      if (existingVersions.get(path) !== listed.version) work.push([path, listed]);
    }

    let touched = false;
    for (const path of removals) {
      // Whether this shard holds anything of this note, by the same
      // note-path key `existingVersions` uses — never `shard.docs.has(path)`,
      // which is never true for a channel-day note's own path.
      if (!existingVersions.has(path)) continue;
      removeDocsForNote(shard, path);
      removedPaths.add(path);
      touched = true;
    }

    // Fetched in parallel waves, indexed in list order once a wave lands. One
    // awaited GET at a time is a wall-clock bug the subrequest budget cannot
    // see: a paid-plan budget authorizes hundreds of fetches, which
    // sequentially is 30-60 seconds — past what MCP clients wait — so the
    // client times out, the invocation dies with it, and the writes never run.
    let applied = 0;
    for (let start = 0; start < work.length; start += BACKFILL_CONCURRENCY) {
      const wave = [];
      for (const entry of work.slice(start, start + BACKFILL_CONCURRENCY)) {
        if (fetchedNotes >= backfillCap) break;
        if (!ops.take(callerReserve + MANIFEST_WRITE_RESERVE + SHARD_WRITE_RESERVE)) break;
        fetchedNotes += 1;
        wave.push(
          (async ([path, listed]) => {
            let object;
            try {
              object = await store.get(path);
            } catch {
              // One unreadable note must not cost the rest of the backfill. The
              // attempt already spent its op, so a bucket full of unreadable
              // notes still terminates, and the note stays in `pending`.
              return null;
            }
            if (!object) return { path, gone: true };
            /*
              `indexableText` first, and uncapped after it — both halves matter
              and they are independent.

              **`indexableText`**: an encrypted note becomes the empty string
              here, so its *version* is still recorded — the diff converges and
              the note stops looking stale forever — while nothing of it reaches
              the index. This index lives in the customer's own bucket under the
              same credential as the note, so tokenising an envelope would hand a
              leaked bucket key the note's terms back out of a second object; and
              for a passphrase-locked note nothing that can read the index is a
              reader of the note at all. See `docs/decisions/encryption.md`,
              "What search does". MEASURED: this pass is the one every search and
              every scheduled sweep runs, and it read the body raw. The
              `indexableText` call the decision file pointed at was in
              `maintain.js`'s `syncIndex`, which nothing has called since this
              index replaced it.

              **Uncapped**: `subDocumentsFor` applies `NOTE_INDEX_CHAR_CAP`
              itself, independently per message for a channel-day note
              (CONTRACT.md § "Channel-day notes: one sub-document per message")
              and once, whole, for an ordinary note — so the cap must not have
              already cut the text before either path sees it. An empty string
              is under every cap, so the two compose in this order and in no
              other: capping first would be wrong, and excluding after the split
              would mean excluding in two places.
            */
            const full = indexableText(await object.text());
            // Record the token the *next* listing will report, or the diff
            // never converges: where the listing carries a real etag that is
            // this read's etag, and where it does not, the object's real etag
            // would never equal the synthetic token and every note would look
            // stale forever.
            const version =
              listed.fromEtag && typeof object.etag === "string" && object.etag
                ? object.etag
                : listed.version;
            return { path, uploaded: listed.uploaded, full, version };
          })(entry)
        );
      }
      if (wave.length === 0) break;
      for (const result of await Promise.all(wave)) {
        if (!result) continue;
        applied += 1;
        if (result.gone) {
          // Deleted between the listing and the read. Dropping it is right in a
          // way the removal pass above cannot be: we asked for it by name and
          // it is not there. `removeDocsForNote` rather than `removeDoc`: a
          // channel-day note's own path is never a doc key in this shard.
          removeDocsForNote(shard, result.path);
          removedPaths.add(result.path);
          touched = true;
          continue;
        }
        touchedPaths.add(result.path);
        // Replace the note's sub-documents **exactly**: a message edited out
        // of a regenerated day (or a note that was a channel-day note and no
        // longer parses as one) must not leave a stale sub-document behind
        // under an anchor the fresh set does not name.
        removeDocsForNote(shard, result.path);
        for (const sub of subDocumentsFor(result.path, result.full)) {
          addDoc(shard, sub.key, {
            etag: result.version,
            uploaded: result.uploaded,
            content: sub.content,
            notePath: sub.notePath,
            anchor: sub.anchor,
            comms: sub.comms,
          });
          // No `computeRanks`: the link graph is global and v2 never holds
          // every shard at once. Neutral for every doc, as CONTRACT.md pins.
          shard.docs.get(sub.key).rank = NEUTRAL_RANK;
        }
        touched = true;
      }
      if (wave.length < Math.min(BACKFILL_CONCURRENCY, work.length - start)) break;
    }

    // A shard whose object could not be parsed differs from its bookkeeping
    // even when nothing was fetched, and that difference is what gets it
    // rewritten rather than left unreadable behind a manifest that vouches for
    // it.
    if (
      !sameVersions(manifest.docsByShard[id], docVersionsOf(shard)) ||
      !sameStats(manifest.stats[id], statsOfShard(shard))
    ) {
      touched = true;
    }

    let persisted = !touched;
    if (touched) {
      let body = serializeShard(shard);
      // **Never write an object this same module will refuse to read**, and
      // never let one shard's refusal be the whole context's. A body past the
      // cap sheds documents from the bundled notes that made it that big until
      // it fits — see `shedToFit`, which argues what that costs and why the
      // ordinary notes sharing the shard are what it is protecting. A shard
      // with nothing to shed is still not written at all: the last readable
      // one survives, the query in hand is answered from what was built, and
      // `pending` says the shard plateaued.
      if (exceedsUtf8Bytes(body, shardCap)) {
        const reduced = shedToFit(shard, body, shardCap);
        body = reduced.body;
        for (const path of reduced.shed) shedPaths.add(path);
      }
      if (body !== null) {
        // `remaining` is peeked before the op is charged, so a refused shard
        // does not take a subrequest from the caller's snippet reads.
        if (ops.take(callerReserve + MANIFEST_WRITE_RESERVE)) {
          // Unconditional: the manifest is the concurrency point, and a shard
          // written by a pass whose manifest write then loses the race is
          // re-derived by the pass that won.
          await store.put(shardKey(id), body);
          persisted = true;
        }
      } else {
        oversizedShards += 1;
      }
    }

    if (persisted && touched) {
      // Read **after** any shedding, so what the manifest records is what the
      // stored object holds rather than what this pass built before the cap
      // was applied to it.
      manifest.docsByShard[id] = docVersionsOf(shard);
      manifest.stats[id] = statsOfShard(shard);
      docmapChanged = true;
      // Rebuilt from the shard that was just stored, in the same step that
      // records its documents — never from the shard the manifest used to
      // describe. A filter is only allowed to be wrong in the direction that
      // costs a shard read (see `filter.js`), and the one way to make it wrong
      // in the other direction is to let it describe an older shard than the
      // object a query will open.
      manifest.filters[id] = buildTermFilter(shard.terms.keys());
      manifestChanged = true;
    }
    // A shard this pass loaded and left alone still gets a filter where it had
    // none: an index written before filters existed would otherwise be routed
    // by nothing until every one of its shards happened to be edited, and a
    // walk that reads every shard is the cost this whole field removes.
    if (!touched && loaded && manifest.filters[id] === null && shard.terms.size > 0) {
      manifest.filters[id] = buildTermFilter(shard.terms.keys());
      manifestChanged = true;
    }
    // What this shard did not land: the notes it never reached, plus — if the
    // shard itself was not stored — the ones it did.
    pending += work.length - applied + (persisted ? 0 : applied);
  }

  // What this pass learned about how far behind the index is, recorded so a
  // search that does no listing of its own can still say it honestly. Written
  // whenever the pass reached the point of having listed, which is every pass
  // that got past the budget floor at the top — including one that changed
  // nothing, because "nothing was stale" is exactly the fact a converged bucket
  // needs recorded to stop showing a catching-up banner.
  const freshness = {
    listedAt: new Date(nowMsOf(now)).toISOString(),
    pending,
    truncated,
  };
  if (
    manifest.freshness.listedAt !== freshness.listedAt ||
    manifest.freshness.pending !== freshness.pending ||
    manifest.freshness.truncated !== freshness.truncated
  ) {
    manifest.freshness = freshness;
    manifestChanged = true;
  }

  let manifestOverflow = false;
  // Whether this pass's work was *recorded*. A pass whose manifest write lost
  // the race wrote shards nothing vouches for, and the pass that won will
  // re-derive them — so as far as anything downstream is concerned it changed
  // nothing, and a caller deciding whether to run again or to re-ask a query
  // must be told that rather than "yes, and again next time".
  let committed = false;
  if (manifestChanged) {
    // The diff first, and unconditionally: it is the object whose staleness
    // costs work rather than correctness (see `DOCMAP_KEY`), and writing it
    // before the manifest is what makes that the only direction the two can
    // disagree in. It is skipped where there is no op for it, which leaves the
    // next pass re-fetching what this one indexed — expensive and correct.
    const body = serializeManifest(manifest);
    if (exceedsUtf8Bytes(body, manifestCap)) {
      // The same both-directions rule as a shard. Nothing is lost — the shards
      // were written — but the diff cannot record it, so the next pass re-does
      // the same work. That is a manifest-wide plateau, and it is reported
      // rather than inferred from a `pending` that would read as zero.
      manifestOverflow = true;
    } else if (ops.remaining > 0) {
      ops.take(0);
      // Conditional on the etag read at the top; unconditional where no
      // manifest existed, because the ContextStore surface offers
      // `onlyIf.etagMatches` and nothing else — there is no create-only
      // precondition to use. A `null` back means somebody else synced first:
      // serve the query from what was built and skip. A lost write is one extra
      // sync later; a retry loop is this query's budget spent on plumbing.
      const written = await (manifestEtag
        ? store.put(MANIFEST_KEY, body, { onlyIf: { etagMatches: manifestEtag } })
        : store.put(MANIFEST_KEY, body));
      // The diff, and only once the manifest that vouches for it has landed.
      //
      // The order is the whole safety argument and it is the opposite of the
      // obvious one. A docmap **ahead** of the manifest tells the next pass
      // that a note is already indexed while the manifest's stats and routing
      // filter still describe the shard before it — so the note is never
      // re-indexed, the filter never learns its terms, and the query that would
      // have found it skips its shard. Permanently. A docmap **behind** the
      // manifest costs the next pass a re-fetch of notes that were already
      // indexed: slow, self-correcting, and the direction every unknown in this
      // file falls.
      //
      // Never out of the caller's reserve, either. The manifest write above may
      // spend the last op there is — it is the pass's whole point — but this is
      // bookkeeping for the *next* pass, and a caller that lost a snippet read
      // to it would have paid for that pass out of its own answer.
      committed = written !== null;
      // Do the v1 retirement before the recoverable docmap cache. If
      // the first pass spends its final two physical operations on the docmap,
      // a missing docmap is the bounded retry signal for the next pass.
      // A logical delete reads the current object and then writes a
      // conditional tombstone. Reserve both physical operations so the v1
      // object is not left visible because the marker write exhausted budget.
      let legacyCleanupSettled = !legacyCleanupNeeded;
      if (written !== null && legacyCleanupNeeded && ops.take(postCleanupReserve + 1)) {
        // Deletion is idempotent, including an already-retired marker. Leave
        // the docmap absent on refusal so a later pass can retry cleanup.
        try {
          await store.delete(LEGACY_V1_KEY);
          legacyCleanupSettled = true;
        } catch {
          // Nothing depends on it being gone.
        }
      }
      // A logical put of a new docmap also needs its marker check plus the
      // provider write. Keep both outside the caller's snippet reserve; if
      // they do not fit, the manifest-ahead/docmap-behind state self-heals on
      // the next pass as described above.
      if (
        written !== null && legacyCleanupSettled && docmapChanged &&
        ops.remaining > postCleanupReserve + 1
      ) {
        const docmap = serializeDocmap(manifest);
        if (!exceedsUtf8Bytes(docmap, manifestCap) && ops.take(postCleanupReserve + 1)) {
          await store.put(DOCMAP_KEY, docmap);
        }
      }
    }
  }

  return {
    manifest,
    shards,
    pending,
    listingTruncated: truncated,
    manifestOverflow,
    // What moved, for the other derivative of these same notes. See
    // `touchedPaths` above; nothing in the R2 index reads either of these.
    touched: [...touchedPaths],
    removed: [...removedPaths],
    // Two answers to two questions that look like one, and conflating them
    // breaks one caller or the other.
    //
    // `changed` is "did a document move in an object a query will read", and
    // shards are written unconditionally, so a pass whose manifest write lost
    // the race still changed the index: the *re-ask* a miss buys must run,
    // because the note it was looking for is now in a shard object.
    //
    // `committed` is "was that recorded", and it is what decides whether
    // another pass is worth scheduling. A pass that lost the race did work the
    // winner is about to re-derive; reporting progress there would have every
    // one of a burst of concurrent passes chain itself twelve deep over the
    // same notes.
    changed: docmapChanged,
    committed: docmapChanged && committed,
    // Notes this pass stored only part of, and shards it could not store at
    // all. Both are `pending`'s opposite — work that finished badly rather
    // than work not yet done — and neither is ever printed to a caller: a
    // count over the whole bucket, private notes included, is the subtraction
    // the census is owner-only to prevent. They are for the operator's trace
    // and for a caller deciding whether this index can hold this bucket.
    shed: [...shedPaths],
    oversizedShards,
    spent: ops.spent,
  };
}
