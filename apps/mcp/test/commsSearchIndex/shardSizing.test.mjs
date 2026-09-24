// Comms search index: the shard budget against a real mailbox — the
// guardrail `docs/decisions/communications.md` named as unmeasured, then
// measured. Sizing by document volume rather than note count, a bundled note
// placed by load rather than hash, growth as a workspace connects a mailbox
// later, and shedding when a day is too big for any shard.
//
// Split out of commsSearchIndex.test.mjs; see fixtures.mjs for the shared
// bucket and message builders. `mailboxDays`, `plainNotes` and the local
// `search` helper are used only here, so they stay local rather than moving
// to the shared fixture module.

import { NOTE_INDEX_CHAR_CAP, createSearchBudget } from "../../src/search/maintain.js";
import {
  MANIFEST_KEY,
  chooseShardCount,
  loadIndexManifest,
  serializeManifest,
  syncShardedIndex,
} from "../../src/search/shards.js";
import { searchIndexedNotes } from "../../src/search/visible.js";
import { indexVolumeOf } from "../../src/search/commsIndex.js";
import { renderChannelDayNote } from "../../../../packages/communications/src/note.js";
import { DAY_BASE, converge, createBucket, encoder, msg } from "./fixtures.mjs";

/**
 * A synthetic mailbox: `days` channel-day notes of `perDay` small messages,
 * the last message of each day carrying a word unique to that day so recall
 * can be asked for at the far end of the corpus rather than at its start.
 *
 * The bodies are distinct tokens rather than repeated filler on purpose: a
 * shard's serialized size is mostly its postings, so a corpus of one repeated
 * word would be a shard an order of magnitude smaller than a real mailbox and
 * every size measured against it would be a fiction.
 */
function mailboxDays({ days, perDay, wordsPerMessage = 24 }) {
  const notes = [];
  for (let day = 0; day < days; day += 1) {
    const date = `2026-09-${String(day + 1).padStart(2, "0")}`;
    const events = [];
    for (let i = 0; i < perDay; i += 1) {
      const words = [];
      for (let w = 0; w < wordsPerMessage; w += 1) words.push(`w${(day * 31 + i * 7 + w) % 900}`);
      if (i === perDay - 1) words.push(`lastword${day}marker`);
      events.push(
        msg({
          messageId: `<d${day}m${i}@mail.example.net>`,
          threadId: `thread-${day}-${i % 5}`,
          sentAt: new Date(Date.UTC(2026, 8, 1 + day, 8, i % 60)).toISOString(),
          subject: `Message ${i} of day ${day}`,
          body: words.join(" "),
        })
      );
    }
    notes.push({
      path: `0-inbox/email/name-at-example-com/${date}.md`,
      text: renderChannelDayNote({ ...DAY_BASE, date, events }),
    });
  }
  return notes;
}

/** `count` ordinary notes, each carrying one shared word and one of its own. */
function plainNotes(count) {
  return Array.from({ length: count }, (_, i) => ({
    path: `1-projects/plan-${String(i).padStart(3, "0")}.md`,
    text: `# Plan ${i}\n\nordinary-note-word and plan${i}ownword, nothing to do with mail.\n`,
  }));
}

const search = (store, query, options = {}) =>
  searchIndexedNotes(store, {
    isVisible: () => true,
    isIndexable: (key) => key.endsWith(".md"),
    query,
    budget: createSearchBudget(600),
    refreshOnMiss: false,
    ...options,
  });

/**
 * The guardrail `docs/decisions/communications.md` named as unmeasured, then
 * measured: the shard budget against a real mailbox.
 *
 * Review's numbers, at 90 days x 200 messages beside 200 ordinary notes —
 * 18,200 sub-documents, **one** shard, that shard's body past
 * `SHARD_PARSE_BYTE_CAP`, its write refused on all 31 passes, `pending: 290`
 * forever, and every search over the whole context answering `indexed: false`.
 * `chooseShardCount` sized the index from the **note** count, so a mailbox
 * could not be spread across shards at all, and the ordinary notes that
 * happened to share the shard went down with it.
 *
 * The fix has three parts and each is driven here: the count follows the
 * volume the listing implies, a bundled note is placed by load rather than by
 * hash, and a shard that still will not fit sheds documents rather than
 * refusing its whole write. The full-size measurement is far too slow for this
 * suite — it is `apps/mcp/test/bench/shardSizing.mjs` — so `shardByteCap`
 * stands in for the corpus, and it stands in honestly: it scales the sizing
 * target and the placement ceiling along with the write cap, so shrinking the
 * shard shrinks the whole rule rather than only half of it.
 */
export async function runCommsShardSizingChecks(check) {
  /* -- 1. the formula ---------------------------------------------------- */

  check(
    "counting notes alone is unchanged, so no existing index is re-sharded by this",
    chooseShardCount(2) === 1 && chooseShardCount(300) === 1 && chooseShardCount(301) === 2
  );
  check(
    "...and an ordinary vault cannot be sized up by its volume either: the note term always wins",
    [1, 42, 300, 301, 4000].every(
      (n) => chooseShardCount(n, n * NOTE_INDEX_CHAR_CAP) === chooseShardCount(n)
    )
  );
  check(
    "two notes carrying eight shards' worth of documents buy eight shards, which counting them never could",
    chooseShardCount(2, 8 * 300 * NOTE_INDEX_CHAR_CAP) === 8
  );
  /*
    The calibration those two checks rest on, at the other end of it. The
    volume term can only be safe over ordinary notes because `indexVolumeOf`
    caps an ordinary note at one per-note window however large the file is —
    that is what the note rule was already assuming, and dropping the cap
    would re-shard every existing index of large notes on the day this
    deploys. A bundled note is the exception on purpose: its documents are a
    set, so it is worth its bytes.
  */
  check(
    "an ordinary note is worth one per-note window however large the file is; a bundled note is worth its bytes",
    indexVolumeOf("1-projects/plan.md", 5_000_000) === NOTE_INDEX_CHAR_CAP &&
      indexVolumeOf("1-projects/plan.md", 10) === 10 &&
      indexVolumeOf("0-inbox/email/name-at-example-com/2026-09-07.md", 1_000) === 1_250 &&
      // A backend that reports no size falls back to one per-note window of
      // bytes, which is exactly the assumption counting notes was already
      // making — never "this note is free".
      indexVolumeOf("1-projects/plan.md", null) === NOTE_INDEX_CHAR_CAP &&
      indexVolumeOf("0-inbox/email/name-at-example-com/2026-09-07.md", undefined) ===
        Math.ceil(NOTE_INDEX_CHAR_CAP * 1.25)
  );

  {
    // ...and the same thing end to end, because the unit above is only a
    // guard if something drives it: a vault of notes each far past the
    // per-note window is one shard, the count it already had.
    const bigPlain = createBucket();
    const filler = "prose ".repeat(6_000);
    for (let i = 0; i < 24; i += 1) {
      bigPlain.seed(`1-projects/long-${String(i).padStart(2, "0")}.md`, `# Long ${i}\n\n${filler}`);
    }
    const sized = await converge(bigPlain);
    check(
      "a vault of notes far larger than the per-note window is still one shard, so nothing existing is re-sharded",
      sized.manifest.shardCount === 1 && sized.pending === 0
    );
  }

  /* -- 2. the review's scenario, at suite speed -------------------------- */

  const cap = 60_000;
  const mailbox = createBucket();
  const days = mailboxDays({ days: 14, perDay: 20 });
  for (const note of days) mailbox.seed(note.path, note.text);
  for (const note of plainNotes(20)) mailbox.seed(note.path, note.text);

  const built = await converge(mailbox, 2000, { shardByteCap: cap });
  check(
    "a mailbox beside ordinary notes converges rather than plateauing: nothing is left pending",
    built.pending === 0
  );
  check(
    "...across several shards, because the sizing followed the documents rather than the objects",
    built.manifest.shardCount > 1
  );
  const shardObjects = [...mailbox.objects.keys()].filter((key) => key.startsWith(".context/search/v2/shard-"));
  check(
    "...and the shards were actually written, which under the note-count sizing none ever was",
    shardObjects.length > 1 &&
      shardObjects.every(
        (key) => encoder.encode(mailbox.objects.get(key).body).length <= cap
      )
  );
  check(
    "...with every shard the manifest vouches for holding no more than the cap allows",
    built.manifest.stats.filter((entry) => entry.docCount > 0).length === shardObjects.length
  );
  check(
    "nothing was shed and no shard was refused: the sizing alone was enough",
    built.shed.length === 0 && built.oversizedShards === 0
  );

  const lastDay = await search(mailbox, "lastword13marker");
  check(
    "a term in the last message of the last day is found — recall reaches the far end of the mailbox",
    lastDay.indexed === true && lastDay.hits.length === 1
  );
  check(
    "...as a deep link into the day that holds it",
    lastDay.hits[0].key.startsWith(days[13].path + "#")
  );
  check(
    "...and an index with nothing shed never claims reduced recall",
    lastDay.reducedRecall === false && lastDay.reducedRecallNotes.length === 0
  );

  /*
    -- reducedRecallNotes is isVisible-filtered, exactly like `hits` --------

    `shedNotePathsOf` deliberately returns every shed note in the manifest,
    private ones included — the same raw shape `manifest.filters` already has.
    The one thing standing between that and a caller is `isVisible`, run
    inside `answerFromIndex` rather than by this test, so what is on trial is
    that the filter actually runs rather than that a scoped fixture happens to
    agree with an unfiltered one. Every other check in this file passes
    `isVisible: () => true`, which cannot catch a dropped filter — this one
    uses a real predicate on purpose.
  */
  const scoped = createBucket();
  scoped.seed("team/shared.md", "# Shared\n\nteamword\n");
  scoped.seed("private/secret.md", "# Secret\n\nprivateword\n");
  await converge(scoped);
  const scopedManifestBefore = await loadIndexManifest(scoped, createSearchBudget(10), 0);
  check(
    "the visibility fixture converged to one shard, which the injection below assumes",
    scopedManifestBefore?.shardCount === 1
  );
  scopedManifestBefore.stats[0] = {
    ...scopedManifestBefore.stats[0],
    shed: 2,
    shedPaths: ["team/shared.md", "private/secret.md"],
  };
  await scoped.put(MANIFEST_KEY, serializeManifest(scopedManifestBefore));
  const teamOnly = (path) => path.startsWith("team/");
  const scopedAnswer = await searchIndexedNotes(scoped, {
    isVisible: teamOnly,
    isIndexable: (key) => key.endsWith(".md"),
    query: "teamword",
    budget: createSearchBudget(600),
    refreshOnMiss: false,
  });
  check(
    "a caller's own reduced-recall list carries only the notes their own isVisible accepts",
    scopedAnswer.reducedRecall === true &&
      scopedAnswer.reducedRecallNotes.length === 1 &&
      scopedAnswer.reducedRecallNotes[0] === "team/shared.md"
  );

  /* -- 2b. a bundled note is placed by load, never by hash --------------- */

  /*
    Sizing spreads a corpus evenly **on average**; hashing places it with the
    variance of a hash, and a channel-day note is indivisible. Eight days
    hashed into eight shards collide with probability 99.8%, and a collision
    is two indivisible days in one shard, which is past the cap however well
    the index was sized — the arithmetic fixed and the failure kept.

    So the fixture is built to make that the only thing on trial: the cap is
    chosen so one day's volume is more than half a shard and less than a whole
    one, which means the sizing buys a shard per day and only the *placement*
    decides whether each day gets one. Measured: replacing the load rule with
    `shardOf` for bundled notes reddens this and nothing else.
  */
  const spread = createBucket();
  const spreadDays = mailboxDays({ days: 8, perDay: 20 });
  for (const note of spreadDays) spread.seed(note.path, note.text);
  for (const note of plainNotes(4)) spread.seed(note.path, note.text);
  const placedRun = await converge(spread, 2000, { shardByteCap: 26_000 });
  const shardHolding = (path) => {
    for (let id = 0; id < placedRun.manifest.shardCount; id += 1) {
      if (placedRun.manifest.docsByShard[id].has(path)) return id;
    }
    return -1;
  };
  const dayShards = spreadDays.map((note) => shardHolding(note.path));
  check(
    "eight days that each need most of a shard get eight different shards, which hashing them would not",
    placedRun.manifest.shardCount >= spreadDays.length &&
      !dayShards.includes(-1) &&
      new Set(dayShards).size === spreadDays.length
  );
  check(
    "...so nothing has to be shed, and the ordinary notes beside them are indexed too",
    placedRun.manifest.stats.reduce((total, entry) => total + entry.shed, 0) === 0 &&
      placedRun.oversizedShards === 0 &&
      placedRun.pending === 0 &&
      plainNotes(4).every((note) => shardHolding(note.path) !== -1)
  );

  /* -- 3. the mixed case: the ordinary notes still answer ---------------- */

  const ordinary = await search(mailbox, "ordinary-note-word");
  check(
    "the ordinary notes beside the mailbox all answer — the failure was never theirs to take",
    ordinary.indexed === true && ordinary.matchCount === 20
  );
  check("...with no reduced-recall claim, since nothing here was shed", ordinary.reducedRecall === false);
  const one = await search(mailbox, "plan7ownword");
  check("...and each of them individually", one.indexed === true && one.hits.length === 1);

  /* -- 4. a rebuild reproduces it --------------------------------------- */

  const rebuilt = createBucket();
  for (const note of days) rebuilt.seed(note.path, note.text);
  for (const note of plainNotes(20)) rebuilt.seed(note.path, note.text);
  const fresh = await converge(rebuilt, 2000, { shardByteCap: cap });
  const docsOf = (result) =>
    JSON.stringify(
      result.manifest.docsByShard.map((docs) => [...docs.keys()].sort())
    );
  check(
    "an index built from the files reproduces the one built incrementally, shard for shard",
    fresh.manifest.shardCount === built.manifest.shardCount && docsOf(fresh) === docsOf(built)
  );

  /* -- 5. growth: a converged workspace that later connects a mailbox -------- */

  const grown = createBucket();
  for (const note of plainNotes(20)) grown.seed(note.path, note.text);
  const before = await converge(grown, 2000, { shardByteCap: cap });
  check("a workspace of ordinary notes sizes itself at one shard", before.manifest.shardCount === 1);
  const wasFindable = await search(grown, "ordinary-note-word");
  check("...and answers", wasFindable.indexed === true && wasFindable.matchCount === 20);

  const homeBefore = new Map();
  for (let id = 0; id < before.manifest.shardCount; id += 1) {
    for (const path of before.manifest.docsByShard[id].keys()) homeBefore.set(path, id);
  }

  for (const note of days) grown.seed(note.path, note.text);
  const after = await converge(grown, 2000, { shardByteCap: cap });
  check(
    "connecting a mailbox grows the index rather than plateauing it",
    after.manifest.shardCount > before.manifest.shardCount && after.pending === 0
  );
  let moved = 0;
  for (let id = 0; id < after.manifest.shardCount; id += 1) {
    for (const path of after.manifest.docsByShard[id].keys()) {
      if (homeBefore.has(path) && homeBefore.get(path) !== id) moved += 1;
    }
  }
  check(
    "...and growth moves nothing that was already indexed, so it costs no re-fetch and no dark window",
    moved === 0
  );
  const stillFindable = await search(grown, "ordinary-note-word");
  check(
    "...with the ordinary notes answering the whole way through",
    stillFindable.indexed === true && stillFindable.matchCount === 20
  );
  const mailAfterGrowth = await search(grown, "lastword13marker");
  check("...and the mail now answering too", mailAfterGrowth.indexed === true && mailAfterGrowth.hits.length === 1);

  /* -- 5b. growth's own failure mode: a docmap left one count behind ----- */

  /*
    The manifest is written first and the docmap only if an op is left for it,
    so a pass that grows the index can store a manifest saying N+k shards over
    a docmap still saying N. That could not happen before growth existed — the
    count never moved — and refusing the mismatch (which is what `parseDocmap`
    did) is not a slow-and-correct fallback here: it empties the diff, so every
    note looks stale, every shard is rebuilt from empty, and an index that was
    answering goes dark for as many passes as the backfill needs.

    Driven by putting the old docmap back under the grown manifest, which is
    exactly the state a skipped write leaves. What is asserted is that the next
    pass has nothing to do — not merely that it survives.
  */
  const behind = createBucket();
  for (const note of plainNotes(20)) behind.seed(note.path, note.text);
  await converge(behind, 2000, { shardByteCap: cap });
  const docmapAtOneShard = behind.objects.get(".context/search/v2/docmap.json").body;
  for (const note of days) behind.seed(note.path, note.text);
  const behindAfter = await converge(behind, 2000, { shardByteCap: cap });
  behind.objects.set(".context/search/v2/docmap.json", { body: docmapAtOneShard, etag: "stale", uploaded: new Date() });
  const nextPass = await syncShardedIndex(behind, {
    budget: createSearchBudget(2000),
    shardByteCap: cap,
  });
  const plainPaths = new Set(plainNotes(20).map((note) => note.path));
  check(
    "a docmap left behind by a growth pass does not re-index the notes it still accounts for",
    behindAfter.manifest.shardCount > 1 &&
      nextPass.touched.every((path) => !plainPaths.has(path)) &&
      nextPass.pending === 0
  );
  /*
    And the notes it does NOT account for are re-placed, which must land them
    back where they already are. Placement is a pure function of the claimed
    set, the listing and the shard count, and all three are what they were on
    the pass that placed them — so it reproduces itself. If it did not, a note
    would exist in two shards at once: the one the stored object still holds it
    in, and the one this pass wrote it to.
  */
  const homes = new Map();
  let doubled = 0;
  for (let id = 0; id < nextPass.manifest.shardCount; id += 1) {
    for (const path of nextPass.manifest.docsByShard[id].keys()) {
      if (homes.has(path)) doubled += 1;
      homes.set(path, id);
    }
  }
  check("...and no note ends up claimed by two shards at once", doubled === 0);
  const survivedTheGap = await search(behind, "ordinary-note-word");
  const mailSurvived = await search(behind, "lastword13marker");
  check(
    "...with both halves of the context answering exactly, never twice",
    survivedTheGap.indexed === true &&
      survivedTheGap.matchCount === 20 &&
      mailSurvived.indexed === true &&
      mailSurvived.hits.length === 1
  );

  /* -- 6. shedding: a day too big for any shard ------------------------- */

  const tight = createBucket();
  const [huge] = mailboxDays({ days: 1, perDay: 60, wordsPerMessage: 40 });
  tight.seed(huge.path, huge.text);
  for (const note of plainNotes(8)) tight.seed(note.path, note.text);
  // Small enough that one day's sub-documents cannot fit a shard however many
  // shards there are — a note is atomic, so this is the case sizing cannot
  // reach and shedding exists for.
  const shedCap = 12_000;
  let shedPass = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    shedPass = await syncShardedIndex(tight, {
      budget: createSearchBudget(2000),
      shardByteCap: shedCap,
    });
    if (shedPass.pending === 0) break;
  }
  check(
    "a day whose documents no shard can hold is shed rather than refusing the shard's write",
    shedPass.shed.includes(huge.path)
  );
  const shedShards = [...tight.objects.keys()].filter((key) => key.startsWith(".context/search/v2/shard-"));
  check(
    "...so shards are still written, under the cap",
    shedShards.length > 0 &&
      shedShards.every((key) => encoder.encode(tight.objects.get(key).body).length <= shedCap)
  );
  const survivors = await search(tight, "ordinary-note-word", { budget: createSearchBudget(600) });
  check(
    "...and the ordinary notes sharing that index still answer — the whole point of shedding",
    survivors.indexed === true && survivors.matchCount === 8
  );
  const keptDocs = shedPass.manifest.docsByShard.reduce(
    (total, docs) => total + (docs.has(huge.path) ? 1 : 0),
    0
  );
  check(
    "...while the shed day keeps a document, so the diff records it and stops re-fetching it",
    keptDocs === 1 && shedPass.pending === 0
  );
  const idle = await syncShardedIndex(tight, {
    budget: createSearchBudget(2000),
    shardByteCap: shedCap,
  });
  check(
    "...proved by the next pass having nothing to do, rather than shedding the same note forever",
    idle.touched.length === 0 && idle.pending === 0 && idle.shed.length === 0
  );
  const shedCount = shedPass.manifest.stats.reduce(
    (total, entry) => total + (entry.shed || 0),
    0
  );
  check(
    "...and the manifest carries the count, so an answer can say the index is knowingly incomplete",
    shedCount === 1
  );
  const reported = await search(tight, "ordinary-note-word", { budget: createSearchBudget(600) });
  check("...which the search reports for the operator", reported.index.shed === 1);
  check(
    "...and, in the caller's own answer rather than only the operator trace, which note it was",
    reported.reducedRecall === true &&
      reported.reducedRecallNotes.length === 1 &&
      reported.reducedRecallNotes[0] === huge.path
  );

  /*
    A rebuild from the files reproduces not only the same shards
    (§ 4 above already proves that for the unshed case) but the SAME
    reduced-recall signal — because it is read off the manifest's own
    `stats[id].shedPaths`, which a rebuild must re-derive exactly the way it
    re-derives `stats[id].shed`, never off a listing that happened to run.
  */
  const rebuiltTight = createBucket();
  rebuiltTight.seed(huge.path, huge.text);
  for (const note of plainNotes(8)) rebuiltTight.seed(note.path, note.text);
  let rebuiltShedPass = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    rebuiltShedPass = await syncShardedIndex(rebuiltTight, {
      budget: createSearchBudget(2000),
      shardByteCap: shedCap,
    });
    if (rebuiltShedPass.pending === 0) break;
  }
  const rebuiltReported = await search(rebuiltTight, "ordinary-note-word", {
    budget: createSearchBudget(600),
  });
  check(
    "...surviving a rebuild from the files, not only an incremental update",
    rebuiltReported.reducedRecall === true &&
      JSON.stringify(rebuiltReported.reducedRecallNotes) ===
        JSON.stringify(reported.reducedRecallNotes)
  );

  /* -- 7. an ordinary note in an over-cap shard, and its neighbours ------ */

  const stuck = createBucket();
  // No bundled note at all: one ordinary note with a large enough vocabulary
  // to put its shard over the cap on its own, beside six ordinary notes that
  // did nothing wrong. Before shedding, the whole shard went unwritten and all
  // seven were unsearchable; the one on trial here is that the loss is the
  // note that caused it and not its neighbours.
  const dense = Array.from({ length: 200 }, (_, i) => `tok${i.toString(36)}zq`).join(" ");
  stuck.seed("1-projects/dense.md", `# Dense\n\n${dense}\n`);
  for (const note of plainNotes(6)) stuck.seed(note.path, note.text);
  let stuckPass = null;
  const everShed = new Set();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    stuckPass = await syncShardedIndex(stuck, {
      budget: createSearchBudget(2000),
      shardByteCap: 2_500,
    });
    for (const path of stuckPass.shed) everShed.add(path);
  }
  check(
    "the note that put its shard over the cap is the one that loses its body from the index",
    everShed.size === 1 && everShed.has("1-projects/dense.md")
  );
  const neighbours = await search(stuck, "ordinary-note-word", { budget: createSearchBudget(600) });
  check(
    "...and every ordinary note sharing that shard still answers, which is the whole rule",
    neighbours.indexed === true && neighbours.matchCount === 6
  );
  const denseGone = await search(stuck, "tok5rzq", { budget: createSearchBudget(600) });
  check(
    "...while the shed note's own body really is gone rather than merely reported as gone",
    denseGone.indexed === true && denseGone.hits.length === 0
  );
  /*
    THE FINDING FROM THE ADVERSARIAL REVIEW OF #347, REPRODUCED AND CLOSED.
    A term that WAS in the note returns zero hits — this shard converged, so
    `indexIncomplete` is entitled to say "run again finds more" and correctly
    does not — and before this change nothing else in the answer said
    anything different from an ordinary miss over a word never written down.
    `reducedRecall` is the fix: true on the exact same zero-hit answer,
    naming the note, so a caller can tell "not written down" from "written
    down, and this search cannot reach all of it".
  */
  check(
    "...and THE SAME zero-hit answer now says why: not 'run another pass', but 'this note lost recall'",
    denseGone.indexIncomplete === false &&
      denseGone.reducedRecall === true &&
      denseGone.reducedRecallNotes.includes("1-projects/dense.md")
  );
  check(
    "...the pass converges, so the shard is not rebuilt and refused forever",
    stuckPass.pending === 0 && stuckPass.oversizedShards === 0
  );

  /* -- 8. a shard that cannot be written at all is still contained ------- */

  const impossible = createBucket();
  for (const note of plainNotes(6)) impossible.seed(note.path, note.text);
  // Smaller than a shard holding one blank document, so there is nothing
  // shedding can do. The write is refused exactly as it always was, and what
  // is on trial is that the pass says which of the two things happened rather
  // than reporting it as work still outstanding.
  const refused = await syncShardedIndex(impossible, {
    budget: createSearchBudget(2000),
    shardByteCap: 120,
  });
  check(
    "a shard no amount of shedding can fit is refused, and named as refused rather than as pending alone",
    refused.oversizedShards > 0 &&
      refused.pending > 0 &&
      [...impossible.objects.keys()].every((key) => !key.startsWith(".context/search/v2/shard-"))
  );
}
