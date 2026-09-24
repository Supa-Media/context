// Comms search index: adversarial review continued — a private day's
// existence is not inferable (no count, total, or timing tell), a
// sub-document key collision across workspaces never crosses, and an index
// or shard written before this change still answers correctly.
//
// Split out of commsSearchIndex.test.mjs; see fixtures.mjs for the shared
// bucket and message builders.

import { NOTE_INDEX_CHAR_CAP, createSearchBudget } from "../../src/search/maintain.js";
import { serializeShard, syncShardedIndex } from "../../src/search/shards.js";
import { searchIndexedNotes } from "../../src/search/visible.js";
import { addDoc, emptyIndex, readComms } from "../../src/search/indexer.js";
import { messageAnchor } from "../../../../packages/communications/src/anchors.js";
import { renderChannelDayNote } from "../../../../packages/communications/src/note.js";
import { converge, createBucket, msg, DAY_BASE } from "./fixtures.mjs";

/**
 * The claim: a private channel-day note's existence is not inferable — no
 * count, no total, no timing tell.
 *
 * A private day of **forty** messages that all carry the term, beside a team
 * day carrying it once. If any part of the answer scaled with the hidden
 * messages, forty is loud enough to see. The two answers compared are the
 * same query against two buckets that differ only by whether the private
 * note exists at all, and the comparison is on the **whole caller-visible
 * answer**, serialized — the same "assert on the bytes" reasoning
 * `docs/decisions/search.md` gives for the cross-tenant binding test.
 */
export async function runCommsExistenceOracleChecks(check) {
  const term = "existence-oracle-canary";
  const privatePath = "0-inbox/email/personal-at-example-com/2026-09-07.md";
  const teamPath = "0-inbox/email/work-at-example-com/2026-09-07.md";
  const uploaded = new Date("2026-09-07T18:00:00.000Z");

  const teamNote = renderChannelDayNote({
    ...DAY_BASE,
    account: "work-at-example-com",
    address: "work@example.com",
    events: [msg({ messageId: "<t1@mail.example.net>", subject: "Team", body: `team copy of ${term}` })],
  });
  const privateEvents = [];
  for (let i = 0; i < 40; i += 1) {
    privateEvents.push(
      msg({
        messageId: `<p${i}@mail.example.net>`,
        threadId: `p-${i}`,
        sentAt: new Date(Date.UTC(2026, 8, 7, 8, i)).toISOString(),
        subject: `Private ${i}`,
        body: `private copy ${i} of ${term}`,
      })
    );
  }
  const privateNote = renderChannelDayNote({
    ...DAY_BASE,
    account: "personal-at-example-com",
    address: "personal@example.com",
    events: privateEvents,
  });

  const withPrivate = createBucket();
  withPrivate.seed(teamPath, teamNote, uploaded);
  withPrivate.seed(privatePath, privateNote, uploaded);
  await converge(withPrivate);

  const withoutPrivate = createBucket();
  withoutPrivate.seed(teamPath, teamNote, uploaded);
  await converge(withoutPrivate);

  const ask = async (store) => {
    store.gets = 0;
    const found = await searchIndexedNotes(store, {
      isVisible: (path) => path === teamPath,
      isIndexable: (key) => key.endsWith(".md"),
      query: term,
      budget: createSearchBudget(200),
      // The refresh-on-miss listing is the one thing that legitimately
      // differs between two buckets holding different numbers of objects,
      // and it only runs on a miss. Off, so the comparison is of the answer
      // rather than of the bucket's size.
      refreshOnMiss: false,
    });
    return { found, gets: store.gets };
  };

  const hidden = await ask(withPrivate);
  const absent = await ask(withoutPrivate);

  const shown = (answer) => ({
    indexed: answer.indexed,
    hits: (answer.hits || []).map((hit) => ({ key: hit.key, title: hit.title, snippets: hit.snippets })),
    matchCount: answer.matchCount,
    matchCountIsFloor: answer.matchCountIsFloor,
    indexIncomplete: answer.indexIncomplete,
  });

  check(
    "a team caller's count is 1 whether or not forty private messages hold the same term",
    hidden.found.matchCount === 1 && absent.found.matchCount === 1
  );
  check(
    "...and it is not reported as a floor, which would itself say 'there is more'",
    hidden.found.matchCountIsFloor === false && absent.found.matchCountIsFloor === false
  );
  check(
    "...and the whole caller-visible answer is byte-identical to the one over a bucket with no private day at all",
    JSON.stringify(shown(hidden.found)) === JSON.stringify(shown(absent.found))
  );
  check(
    "...and answering it read the same number of objects, so there is no work (or timing) tell either",
    hidden.gets === absent.gets
  );
  const asOwner = await searchIndexedNotes(withPrivate, {
    isVisible: () => true,
    isIndexable: (key) => key.endsWith(".md"),
    query: term,
    budget: createSearchBudget(200),
    refreshOnMiss: false,
  });
  check(
    "the fixture is loud enough to have shown a leak: an owner sees all 41",
    asOwner.matchCount === 41
  );
}

/**
 * The claim: a sub-document written by one workspace is never returned to
 * another, **including when the note path and the anchor collide exactly**.
 *
 * The collision is made real rather than assumed: the same message id in the
 * same account hashes to the same anchor (`anchors.js`), so both workspaces
 * hold a document under a byte-identical key.
 */
export async function runCommsTenantCollisionChecks(check) {
  const path = "0-inbox/email/name-at-example-com/2026-09-07.md";
  const shared = msg({ messageId: "<collide@mail.example.net>", subject: "Same subject" });
  const anchor = messageAnchor(shared);

  const a = createBucket();
  const b = createBucket();
  a.seed(path, renderChannelDayNote({ ...DAY_BASE, events: [{ ...shared, body: "zuluoscarquebec" }] }));
  b.seed(path, renderChannelDayNote({ ...DAY_BASE, events: [{ ...shared, body: "yankeemikebravo" }] }));
  await converge(a);
  await converge(b);

  const search = (store, query) =>
    searchIndexedNotes(store, {
      isVisible: () => true,
      isIndexable: (key) => key.endsWith(".md"),
      query,
      budget: createSearchBudget(200),
      refreshOnMiss: false,
    });

  const inA = await search(a, "zuluoscarquebec");
  const inB = await search(b, "yankeemikebravo");
  check(
    "the two workspaces really do hold the same sub-document key",
    inA.hits[0]?.key === `${path}#${anchor}` && inB.hits[0]?.key === `${path}#${anchor}`
  );
  check(
    "...and each answer is its own workspace's message",
    inA.hits[0].snippets.join(" ").includes("zuluoscarquebec") &&
      inB.hits[0].snippets.join(" ").includes("yankeemikebravo")
  );
  const crossed = await search(a, "yankeemikebravo");
  check(
    "a term only the other workspace's message carries returns nothing here",
    (crossed.hits || []).length === 0 && crossed.matchCount === 0
  );
  check(
    "...and A's stored index bytes never contain B's text",
    ![...a.objects.entries()].some(
      ([key, stored]) => key.startsWith(".context/search/") && stored.body.includes("yankeemikebravo")
    )
  );
  // Non-negotiable 2: tenancy is bucket-level, so a sub-document key is a
  // note path and an anchor and nothing else — no workspace segment anywhere
  // in it, which is also why a collision across buckets is the normal case
  // rather than an exotic one.
  check(
    "a sub-document key is the note's own path plus its anchor, with no tenant namespace in it",
    inA.hits[0].key === `${path}#${anchor}` && !inA.hits[0].key.includes("workspaces/")
  );
}

/**
 * The claim: an index and a shard written **before** this change — with no
 * `notePath`, `anchor` or `comms` on any doc entry — still query correctly,
 * and a mixed index does not mis-attribute visibility.
 *
 * The old shape is constructed explicitly rather than by trusting a default:
 * `legacyShardBytes` builds the doc entries the previous code wrote and then
 * deletes the three fields from the serialized JSON, so what is stored is
 * bytes this build has never produced.
 */
function legacyShardBytes(docs) {
  const shard = emptyIndex();
  for (const { path, etag, uploaded, content } of docs) {
    addDoc(shard, path, { etag, uploaded, content });
    shard.docs.get(path).rank = 0;
  }
  const parsed = JSON.parse(serializeShard(shard));
  for (const entry of parsed.docs) {
    delete entry[1].notePath;
    delete entry[1].anchor;
    delete entry[1].comms;
  }
  return { bytes: JSON.stringify(parsed), shard };
}

export async function runCommsLegacyIndexChecks(check) {
  const dayPath = "0-inbox/email/name-at-example-com/2026-09-07.md";
  const plainPath = "1-projects/plan.md";
  const plainText = "# Plan\n\nlegacy-era-term in an ordinary note";
  const uploaded = new Date("2026-09-07T18:00:00.000Z");
  const dayText = renderChannelDayNote({
    ...DAY_BASE,
    events: [msg({ subject: "Legacy", body: "legacy-era-term inside a day indexed the old way" })],
  });

  // Exactly what the previous build wrote: one document per FILE, the
  // channel-day note included, capped whole and keyed by its own path.
  const { bytes, shard } = legacyShardBytes([
    { path: dayPath, etag: "old-1", uploaded, content: dayText.slice(0, NOTE_INDEX_CHAR_CAP) },
    { path: plainPath, etag: "old-2", uploaded, content: plainText },
  ]);
  check(
    "the legacy fixture really carries none of the three new fields",
    !bytes.includes("notePath") && !bytes.includes('"anchor"') && !bytes.includes('"comms"')
  );

  const bucket = createBucket();
  bucket.seed(dayPath, dayText, uploaded);
  bucket.seed(plainPath, plainText, uploaded);
  bucket.seed(".context/search/v2/shard-000.json", bytes, uploaded);
  bucket.seed(
    ".context/search/v2/manifest.json",
    JSON.stringify({
      version: 3,
      shardCount: 1,
      generatedAt: "2026-09-06T00:00:00.000Z",
      stats: [
        {
          docCount: 2,
          lenTotals: [...shard.docs.values()].reduce(
            (totals, doc) => ({
              title: totals.title + doc.len.title,
              headings: totals.headings + doc.len.headings,
              tags: totals.tags + doc.len.tags,
              body: totals.body + doc.len.body,
            }),
            { title: 0, headings: 0, tags: 0, body: 0 }
          ),
        },
      ],
      // No filter at all — an index that predates them. "Absence always means
      // read the shard" (docs/decisions/search.md), which is exactly the
      // legacy case being exercised.
      filters: [null],
      freshness: { listedAt: "2026-09-06T00:00:00.000Z", pending: 0, truncated: false },
    }),
    uploaded
  );
  bucket.seed(
    ".context/search/v2/docmap.json",
    JSON.stringify({
      version: 3,
      shardCount: 1,
      docsByShard: [
        [
          [dayPath, "old-1"],
          [plainPath, "old-2"],
        ],
      ],
    }),
    uploaded
  );

  const asOwner = await searchIndexedNotes(bucket, {
    isVisible: () => true,
    isIndexable: (key) => key.endsWith(".md"),
    query: "legacy-era-term",
    budget: createSearchBudget(200),
    refreshOnMiss: false,
  });
  check(
    "a shard written before this change still answers, with both of its documents",
    asOwner.indexed && asOwner.hits.length === 2 && asOwner.matchCount === 2
  );
  check(
    "...keyed by the note's own path, with no anchor invented for it",
    asOwner.hits.every((hit) => !hit.key.includes("#"))
  );

  // A legacy doc's visibility is decided on its own path, because that is
  // what `notePath` defaults to when the field is absent.
  const asTeam = await searchIndexedNotes(bucket, {
    isVisible: (path) => path === plainPath,
    isIndexable: (key) => key.endsWith(".md"),
    query: "legacy-era-term",
    budget: createSearchBudget(200),
    refreshOnMiss: false,
  });
  check(
    "a legacy doc entry is judged on its own path: hiding the day hides the day and nothing else",
    asTeam.hits.length === 1 && asTeam.hits[0].key === plainPath && asTeam.matchCount === 1
  );

  /* -- mixed: the same index after one note was re-indexed by this build -- */
  const mixed = await syncShardedIndex(bucket, { budget: createSearchBudget(2000) });
  const mixedShard = [...mixed.shards.values()][0];
  const keys = [...mixedShard.docs.keys()];
  check(
    "re-indexing over a legacy shard splits the day into sub-documents and leaves the ordinary note alone",
    keys.includes(plainPath) && keys.some((key) => key.startsWith(`${dayPath}#msg-`)) && !keys.includes(dayPath)
  );
  const mixedTeam = await searchIndexedNotes(bucket, {
    isVisible: (path) => path === plainPath,
    isIndexable: (key) => key.endsWith(".md"),
    query: "legacy-era-term",
    budget: createSearchBudget(200),
    refreshOnMiss: false,
  });
  check(
    "a mixed index does not mis-attribute visibility: the hidden day's messages stay hidden",
    mixedTeam.hits.length === 1 && mixedTeam.hits[0].key === plainPath && mixedTeam.matchCount === 1
  );
  const mixedDay = await searchIndexedNotes(bucket, {
    isVisible: (path) => path === dayPath,
    isIndexable: (key) => key.endsWith(".md"),
    query: "legacy-era-term",
    budget: createSearchBudget(200),
    refreshOnMiss: false,
  });
  check(
    "...and naming the day exactly reaches its messages, which is the same rule from the other side",
    mixedDay.hits.length === 1 && mixedDay.hits[0].key.startsWith(`${dayPath}#msg-`)
  );

  /* -- a malformed comms record is refused rather than guessed at -------- */
  check("a doc entry carrying a malformed comms record is refused", readComms(5).ok === false);
  check("...an absent one is not", readComms(undefined).ok === true && readComms(undefined).comms === null);
}
