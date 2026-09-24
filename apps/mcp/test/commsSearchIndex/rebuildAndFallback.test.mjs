// Comms search index: adversarial review continued — sub-documents are
// disposable derivatives, so a rebuild from the files reproduces them
// byte-for-byte and a shrunk note leaves no orphans; and a channel-day path
// holding no message headings at all (an encrypted day, or one typed by
// hand) still converges and, if plaintext, is still searchable.
//
// Split out of commsSearchIndex.test.mjs; see fixtures.mjs for the shared
// bucket and message builders.

import { createSearchBudget } from "../../src/search/maintain.js";
import { syncShardedIndex } from "../../src/search/shards.js";
import { searchIndexedNotes } from "../../src/search/visible.js";
import { messageAnchor } from "../../../../packages/communications/src/anchors.js";
import { renderChannelDayNote } from "../../../../packages/communications/src/note.js";
import { isEncryptedNote } from "../../src/encryption.js";
import { converge, createBucket, msg, DAY_BASE } from "./fixtures.mjs";

/**
 * The claim: sub-documents are disposable derivatives — a rebuild from the
 * files reproduces them exactly, and a note that shrinks leaves no orphans.
 *
 * "Byte-for-byte" is taken literally: the incrementally-updated shard object
 * and one built from scratch over the same final files are compared as
 * stored bytes, which is the only comparison that would catch an orphan
 * posting that no longer scores but is still written down.
 */
export async function runCommsRebuildChecks(check) {
  const dayPath = "0-inbox/email/name-at-example-com/2026-09-07.md";
  const otherPath = "0-inbox/email/name-at-example-com/2026-09-06.md";
  const uploaded = new Date("2026-09-07T18:00:00.000Z");

  const events = [];
  for (let i = 0; i < 10; i += 1) {
    events.push(
      msg({
        messageId: `<r${i}@mail.example.net>`,
        threadId: `r-${i}`,
        sentAt: new Date(Date.UTC(2026, 8, 7, 9, i)).toISOString(),
        subject: `Round ${i}`,
        body: `round-${i}-word and shared-rebuild-word`,
      })
    );
  }
  const otherNote = renderChannelDayNote({
    ...DAY_BASE,
    date: "2026-09-06",
    events: [msg({ messageId: "<o1@mail.example.net>", subject: "Other", body: "other-day-word" })],
  });
  const tenMessages = renderChannelDayNote({ ...DAY_BASE, events });
  const twoMessages = renderChannelDayNote({ ...DAY_BASE, events: [events[0], events[9]] });

  const incremental = createBucket();
  incremental.seed(otherPath, otherNote, uploaded);
  incremental.seed(dayPath, tenMessages, uploaded);
  const built = await converge(incremental);
  const beforeShrink = [...built.shards.values()].reduce(
    (total, shard) => total + [...shard.docs.values()].filter((doc) => doc.notePath === dayPath).length,
    0
  );
  check("ten messages index as ten sub-documents", beforeShrink === 10);

  // The same note, rewritten with eight of its messages gone. The etag moves,
  // so this is a real resync rather than a re-render of the same bytes.
  incremental.seed(dayPath, twoMessages, uploaded);
  await converge(incremental);

  const fresh = createBucket();
  fresh.seed(otherPath, otherNote, uploaded);
  fresh.seed(dayPath, twoMessages, uploaded);
  await converge(fresh);

  const shardKeys = [...incremental.objects.keys()].filter((key) => key.startsWith(".context/search/v2/shard-")).sort();
  const freshKeys = [...fresh.objects.keys()].filter((key) => key.startsWith(".context/search/v2/shard-")).sort();
  check("both indexes hold the same shard objects", JSON.stringify(shardKeys) === JSON.stringify(freshKeys));

  /*
    Two things in a stored shard are legitimately not a function of the notes,
    and both are replaced rather than dropped, so that what remains really is
    compared byte for byte:

    - **the version token each store minted.** This stub's etags are a
      counter, so the same note is `e6` in the bucket that wrote it twice and
      `e2` in the one that wrote it once. Replacing it with a marker meaning
      "this is that note's live etag" asserts the second thing worth
      asserting — each index recorded the version its bucket currently holds
      — rather than merely ignoring the field.
    - **`generatedAt`**, the wall clock at the moment the shard was
      serialized. Measured: two shards written in the same millisecond
      compare equal and two written a millisecond apart do not, so an
      unnormalized comparison is a coin flip (18 differences in 40 rounds)
      rather than a property.
  */
  const normalize = (store, body) => {
    const parsed = JSON.parse(body);
    parsed.generatedAt = "<when>";
    for (const [, doc] of parsed.docs) {
      const live = store.objects.get(doc.notePath)?.etag;
      doc.etag = doc.etag === live ? "<live>" : `<stale:${doc.etag}>`;
    }
    return JSON.stringify(parsed);
  };
  let identical = shardKeys.length > 0;
  let liveVersions = true;
  for (const key of shardKeys) {
    const a = normalize(incremental, incremental.objects.get(key).body);
    const b = normalize(fresh, fresh.objects.get(key).body);
    if (a !== b) identical = false;
    if (a.includes("<stale:")) liveVersions = false;
  }
  check(
    "a note that shrank from ten messages to two leaves an index identical to one rebuilt from the files",
    identical
  );
  check("...and both record the version the bucket is currently holding", liveVersions);

  // Anchors are what a shard's own bytes carry (a doc key), so an orphan is
  // visible directly. The bodies are not stored — the postings are interned
  // token ids — so this is the check that can actually see one.
  const orphanAnchor = messageAnchor(events[4]);
  const survivingAnchor = messageAnchor(events[9]);
  check(
    "...and eight orphaned anchors is what that would otherwise have been",
    !shardKeys.some((key) => incremental.objects.get(key).body.includes(orphanAnchor))
  );
  check(
    "...while the two that survived, and the untouched day, are still named",
    shardKeys.some((key) => incremental.objects.get(key).body.includes(survivingAnchor)) &&
      shardKeys.some((key) => incremental.objects.get(key).body.includes(otherPath))
  );

  const docmapIncremental = JSON.parse(incremental.objects.get(".context/search/v2/docmap.json").body);
  const docmapFresh = JSON.parse(fresh.objects.get(".context/search/v2/docmap.json").body);
  check(
    "the diff surface names each note once, in both",
    JSON.stringify(docmapIncremental.docsByShard.map((s) => s.map(([p]) => p))) ===
      JSON.stringify(docmapFresh.docsByShard.map((s) => s.map(([p]) => p)))
  );
}

/**
 * A file at a channel-day path that holds **no message headings at all** —
 * an encrypted day, or one somebody typed by hand in Obsidian.
 *
 * Measured on this branch before `subDocumentsFor` grew its fallback: such a
 * file contributed zero documents, so `docsByShard` recorded no version for
 * it, so every later pass found it stale again — `touched` named that note
 * on pass after pass, forever, each one a note read plus a shard, manifest
 * and docmap write. A hand-written note at such a path was also unsearchable
 * outright. Both are checked here.
 */
export async function runCommsNoMessageFallbackChecks(check) {
  /* -- a day encrypted AFTER it was indexed ------------------------------ */
  const bucket = createBucket();
  const dayPath = "0-inbox/email/name-at-example-com/2026-09-07.md";
  bucket.seed(
    dayPath,
    renderChannelDayNote({
      ...DAY_BASE,
      events: [
        msg({ subject: "One", body: "plaintext-canary-alpha" }),
        msg({ messageId: "<enc2@mail.example.net>", subject: "Two", body: "plaintext-canary-beta" }),
      ],
    })
  );
  await converge(bucket);
  const before = await searchIndexedNotes(bucket, {
    isVisible: () => true,
    isIndexable: (key) => key.endsWith(".md"),
    query: "plaintext-canary-beta",
    budget: createSearchBudget(200),
    refreshOnMiss: false,
  });
  check("the day's messages are indexed while it is plaintext", before.hits.length > 0);

  const encrypted = [
    "---",
    "context_encryption: v1",
    "---",
    "",
    "```context-encrypted",
    '{"ciphertext":"opaque-and-holds-no-message-headings"}',
    "```",
    "",
  ].join("\n");
  check("the fixture reads as an encrypted note", isEncryptedNote(encrypted));
  bucket.seed(dayPath, encrypted);
  await converge(bucket);

  const after = await searchIndexedNotes(bucket, {
    isVisible: () => true,
    isIndexable: (key) => key.endsWith(".md"),
    query: "plaintext-canary-beta",
    budget: createSearchBudget(200),
    refreshOnMiss: false,
  });
  check(
    "encrypting a day that was already indexed removes its sub-documents from the answer",
    after.indexed && (after.hits || []).length === 0 && after.matchCount === 0
  );
  check(
    "...and from the stored shard's bytes, so nothing is merely being filtered on the way out",
    ![...bucket.objects.entries()].some(
      ([key, stored]) => key.startsWith(".context/search/v2/shard-") && stored.body.includes("plaintext-canary-beta")
    )
  );
  const idle = await syncShardedIndex(bucket, { budget: createSearchBudget(2000) });
  check(
    "...and the pass after that has nothing to do: an encrypted day converges rather than being re-fetched forever",
    idle.touched.length === 0 && idle.pending === 0
  );

  /* -- a note somebody wrote by hand at a channel-day path ---------------- */
  const byHand = createBucket();
  const handPath = "0-inbox/imessage/2026-09-07.md";
  byHand.seed(handPath, "# Notes to self\n\nhandwritten-canary-word, typed straight into Obsidian.\n");
  await converge(byHand);
  const handFound = await searchIndexedNotes(byHand, {
    isVisible: () => true,
    isIndexable: (key) => key.endsWith(".md"),
    query: "handwritten-canary-word",
    budget: createSearchBudget(200),
    refreshOnMiss: false,
  });
  check(
    "a hand-written note at a channel-day path is still indexed, as the ordinary note it is",
    handFound.indexed && handFound.hits.length === 1 && handFound.hits[0].key === handPath
  );
  const handIdle = await syncShardedIndex(byHand, { budget: createSearchBudget(2000) });
  check("...and it converges too", handIdle.touched.length === 0 && handIdle.pending === 0);
}
