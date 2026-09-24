// Comms search index: one sync pass converging on a channel-day note end to
// end, `canSee` running on the containing note rather than per message
// (including tenant isolation), regeneration replacing exactly the
// sub-documents that changed, and the two visibility guards driven
// independently of one another (the adversarial review's first section).
//
// Split out of commsSearchIndex.test.mjs; see fixtures.mjs for the shared
// bucket and message builders.

import { createSearchBudget } from "../../src/search/maintain.js";
import { syncShardedIndex } from "../../src/search/shards.js";
import { searchIndexedNotes } from "../../src/search/visible.js";
import { parseQuery, rankedVisibleTo } from "../../src/search/query.js";
import { collectShardCandidates, scoreCollected } from "../../src/search/shardQuery.js";
import { messageAnchor } from "../../../../packages/communications/src/anchors.js";
import { renderChannelDayNote } from "../../../../packages/communications/src/note.js";
import { NOTE_PATH, bigDayNote, converge, createBucket, msg, DAY_BASE } from "./fixtures.mjs";

export async function runCommsSyncLoopChecks(check) {
  const bucket = createBucket();
  const { text } = bigDayNote(NOTE_PATH, { count: 6 });
  bucket.seed(NOTE_PATH, text);

  const first = await converge(bucket);
  check("the sync converges over a channel-day note", first.pending === 0);

  const [shard] = [...first.shards.values()];
  check("the shard the pass built holds one doc per message", shard.docs.size === 6);
  for (const [key, doc] of shard.docs) {
    check(`${key}'s doc entry names the containing note`, doc.notePath === NOTE_PATH);
    check(`${key}'s doc entry carries a real anchor`, typeof doc.anchor === "string" && doc.anchor.startsWith("msg-"));
  }
  check(
    "none of the shard's docs are keyed by the note's own path",
    !shard.docs.has(NOTE_PATH)
  );

  // A second pass over an unchanged bucket does no work — the diff converged
  // on the note's real path, not on a key nothing in the listing ever names.
  const second = await syncShardedIndex(bucket, { budget: createSearchBudget(2000) });
  check("a second pass over an unchanged note re-indexes nothing", second.touched.length === 0);

  // End to end: a term in the last message is findable through the real
  // query path, with a deep-linked key and a snippet cut from that message.
  const found = await searchIndexedNotes(bucket, {
    isVisible: () => true,
    isIndexable: (key) => key.endsWith(".md"),
    query: "findme05uniquemarker",
    budget: createSearchBudget(200),
  });
  check("the end-to-end search finds the term", found.indexed && found.hits.length === 1);
  const hit = found.hits[0];
  check("...with a path#anchor deep link", hit.key === `${NOTE_PATH}#${messageAnchor({
    channel: "email",
    account: "name-at-example-com",
    messageId: "<msg-5@mail.example.net>",
  })}`);
  check("...and a snippet from that message", hit.snippets.some((line) => line.includes("findme05uniquemarker")));
}

export async function runCommsVisibilityChecks(check) {
  /* -- canSee runs on the containing note, never per message ------------ */
  const bucket = createBucket();
  const privatePath = "0-inbox/email/personal-at-example-com/2026-09-07.md";
  const teamPath = "0-inbox/email/work-at-example-com/2026-09-07.md";
  const sharedTerm = "shared-secret-phrase-xyz";

  const privateNote = renderChannelDayNote({
    ...DAY_BASE,
    account: "personal-at-example-com",
    address: "personal@example.com",
    events: [msg({ subject: "Private", body: `contains ${sharedTerm} here` })],
  });
  const teamNote = renderChannelDayNote({
    ...DAY_BASE,
    account: "work-at-example-com",
    address: "work@example.com",
    events: [msg({ messageId: "<team1@mail.example.net>", subject: "Team", body: `also has ${sharedTerm} here` })],
  });
  bucket.seed(privatePath, privateNote);
  bucket.seed(teamNote ? teamPath : teamPath, teamNote);

  await converge(bucket);

  // Exact equality against the note's own path — never a prefix — so this
  // predicate is exactly `privacy.md`'s exact-note override shape and would
  // reject a sub-document's own key (`<notePath>#<anchor>`) outright if
  // `isVisible` were ever called with it instead of `notePath`. A
  // folder-prefix predicate would pass even the sabotage this guards
  // against, since a `#anchor` suffix does not change whether a string
  // starts with a folder prefix — which is exactly why this is exact.
  const isTeamVisible = (path) => path === teamPath;
  const teamOnly = await searchIndexedNotes(bucket, {
    isVisible: isTeamVisible,
    isIndexable: (key) => key.endsWith(".md"),
    query: sharedTerm,
    budget: createSearchBudget(200),
  });
  check(
    "the same message text in a private and a team note: only the team hit returns",
    teamOnly.indexed && teamOnly.hits.length === 1 && teamOnly.hits[0].key.startsWith(teamPath)
  );
  check("...and the private note's path never appears", !teamOnly.hits.some((h) => h.key.startsWith(privatePath)));
  check("...and the reported count matches exactly what is visible", teamOnly.matchCount === 1);

  const everything = await searchIndexedNotes(bucket, {
    isVisible: () => true,
    isIndexable: (key) => key.endsWith(".md"),
    query: sharedTerm,
    budget: createSearchBudget(200),
  });
  check(
    "an owner-tier caller sees both",
    everything.indexed && everything.hits.length === 2
  );

  /* -- tenant isolation: two workspaces, the identical message text ------ */
  const workspaceA = createBucket();
  const workspaceB = createBucket();
  const tenantTerm = "cross-tenant-canary-phrase";
  const notePathA = "0-inbox/email/name-at-example-com/2026-09-07.md";
  const notePathB = "0-inbox/email/name-at-example-com/2026-09-07.md";
  workspaceA.seed(
    notePathA,
    renderChannelDayNote({ ...DAY_BASE, events: [msg({ subject: "A", body: `A holds ${tenantTerm}` })] })
  );
  workspaceB.seed(
    notePathB,
    renderChannelDayNote({ ...DAY_BASE, events: [msg({ subject: "B", body: `B holds ${tenantTerm}` })] })
  );
  await converge(workspaceA);
  await converge(workspaceB);

  const foundInA = await searchIndexedNotes(workspaceA, {
    isVisible: () => true,
    isIndexable: (key) => key.endsWith(".md"),
    query: tenantTerm,
    budget: createSearchBudget(200),
  });
  check("workspace A finds its own message", foundInA.indexed && foundInA.hits.length === 1);
  const snippetA = foundInA.hits[0].snippets.join(" ");
  check(
    "...and the snippet is A's own message, never B's",
    snippetA.includes("A holds") && !snippetA.includes("B holds")
  );

  // The direct proof: A's own stored shard object never contains a doc whose
  // content came from B's note — two entirely separate stores, so nothing in
  // A's bytes was ever computed from B's bucket at all.
  const shardKeysA = [...workspaceA.objects.keys()].filter((k) => k.startsWith(".context/search/v2/shard-"));
  let sawB = false;
  for (const key of shardKeysA) {
    if (workspaceA.objects.get(key).body.includes("B holds")) sawB = true;
  }
  check("a sub-document from one workspace is never returned to another (proved on the stored bytes)", !sawB);
}

export async function runCommsRegenerationChecks(check) {
  const bucket = createBucket();
  const dayAPath = "0-inbox/email/name-at-example-com/2026-09-06.md";
  const dayBPath = "0-inbox/email/name-at-example-com/2026-09-07.md";

  const dayAEventsFull = [
    msg({ messageId: "<a-1@mail.example.net>", threadId: "t-a1", subject: "A one", body: "alpha body one" }),
    msg({ messageId: "<a-2@mail.example.net>", threadId: "t-a2", subject: "A two", body: "alpha body two" }),
    msg({ messageId: "<a-3@mail.example.net>", threadId: "t-a3", subject: "A three", body: "alpha body three" }),
  ];
  const dayBEvents = [
    msg({ messageId: "<b-1@mail.example.net>", threadId: "t-b1", subject: "B one", body: "beta body one" }),
    msg({ messageId: "<b-2@mail.example.net>", threadId: "t-b2", subject: "B two", body: "beta body two" }),
  ];

  bucket.seed(
    dayAPath,
    renderChannelDayNote({ ...DAY_BASE, date: "2026-09-06", events: dayAEventsFull })
  );
  bucket.seed(dayBPath, renderChannelDayNote({ ...DAY_BASE, date: "2026-09-07", events: dayBEvents }));

  const before = await converge(bucket);
  check("the initial pass converges in one go (small fixture, roomy budget)", before.pending === 0);
  const countFor = (notePath, shards) =>
    shards.reduce(
      (total, shard) =>
        total + [...shard.docs.values()].filter((doc) => doc.notePath === notePath).length,
      0
    );
  check(
    "day A starts with three sub-documents",
    countFor(dayAPath, [...before.shards.values()]) === 3
  );

  // Regenerate day A with the middle message removed — a message edited out
  // of a resync, exactly the case the decision names.
  const dayAEventsEdited = [dayAEventsFull[0], dayAEventsFull[2]];
  bucket.seed(dayAPath, renderChannelDayNote({ ...DAY_BASE, date: "2026-09-06", events: dayAEventsEdited }));

  const after = await converge(bucket);
  check("the regeneration pass converges", after.pending === 0);
  const shards = [...after.shards.values()];

  const removedAnchor = messageAnchor(dayAEventsFull[1]);
  let removedAnchorSurvives = false;
  let dayADocCount = 0;
  let dayBDocCount = 0;
  for (const shard of shards) {
    for (const [key, doc] of shard.docs) {
      if (doc.notePath === dayAPath) {
        dayADocCount += 1;
        if (doc.anchor === removedAnchor) removedAnchorSurvives = true;
      }
      if (doc.notePath === dayBPath) dayBDocCount += 1;
      void key;
    }
  }
  check("regenerating day A replaces exactly its sub-documents: two remain", dayADocCount === 2);
  check("...the removed message's sub-document is gone", !removedAnchorSurvives);
  check("...and day B's sub-documents are untouched", dayBDocCount === 2);

  // And no posting anywhere still points at the removed anchor's key.
  let stalePosting = false;
  for (const shard of shards) {
    for (const postings of shard.terms.values()) {
      if (postings.has(`${dayAPath}#${removedAnchor}`)) stalePosting = true;
    }
  }
  check("...and no posting still names the removed sub-document's key", !stalePosting);
}

/* ====================================================================== */
/*  ADVERSARIAL REVIEW                                                     */
/*                                                                         */
/*  Everything below was added by the review of the change above rather    */
/*  than by the change itself, on the rule that a guard nobody has checked */
/*  is not a guard (docs/decisions/testing.md). Each section says which    */
/*  claim it attacks and what the attack measured.                         */
/* ====================================================================== */

/**
 * The claim: `canSee`/`isVisible` runs on `doc.notePath` at **both**
 * independent guards — `shardQuery.js`'s collector and `query.js`'s
 * `rankedVisibleTo` — and neither leans on the other having already narrowed
 * the corpus.
 *
 * The end-to-end check above cannot tell those apart: with both guards
 * correct, one of them being a no-op is invisible. So each is driven here
 * with the *other one absent from the call* — the collector followed
 * straight by `scoreCollected` and no `rankedVisibleTo` at all, and then
 * `rankedVisibleTo` over a collection gathered with `isVisible = () => true`.
 */
export async function runCommsGuardIndependenceChecks(check) {
  const bucket = createBucket();
  const privatePath = "0-inbox/email/personal-at-example-com/2026-09-07.md";
  const teamPath = "0-inbox/email/work-at-example-com/2026-09-07.md";
  const term = "guard-independence-canary";

  bucket.seed(
    privatePath,
    renderChannelDayNote({
      ...DAY_BASE,
      account: "personal-at-example-com",
      address: "personal@example.com",
      events: [msg({ subject: "Private", body: `private copy of ${term}` })],
    })
  );
  bucket.seed(
    teamPath,
    renderChannelDayNote({
      ...DAY_BASE,
      account: "work-at-example-com",
      address: "work@example.com",
      events: [msg({ messageId: "<t1@mail.example.net>", subject: "Team", body: `team copy of ${term}` })],
    })
  );
  const synced = await converge(bucket);
  const shards = [...synced.shards.values()];

  // Exact-path equality, never a prefix: a `#anchor` suffix does not change
  // whether a string starts with a folder path, so a prefix predicate cannot
  // fail the sabotage this is here to catch.
  const isTeamVisible = (path) => path === teamPath;
  const queryTerms = [...new Set(parseQuery(term).terms)];

  /* -- guard 1 alone: the collector, with no ranked filter after it ------ */
  const collectedStrict = shards.map((shard) => collectShardCandidates(shard, queryTerms, isTeamVisible));
  const scoredStrict = scoreCollected(collectedStrict, term);
  check(
    "guard 1 alone (the shard collector, no rankedVisibleTo after it): the private day contributes nothing",
    scoredStrict.length > 0 && scoredStrict.every((r) => r.notePath === teamPath)
  );
  check(
    "...and its key never appears among the candidates either",
    !scoredStrict.some((r) => r.path.startsWith(privatePath))
  );
  check(
    "...while the team day's message is still there to be found",
    scoredStrict.some((r) => r.path.startsWith(`${teamPath}#msg-`))
  );

  /* -- guard 2 alone: rankedVisibleTo over an unfiltered collection ------ */
  const collectedOpen = shards.map((shard) => collectShardCandidates(shard, queryTerms, () => true));
  const scoredOpen = scoreCollected(collectedOpen, term);
  check(
    "with guard 1 disabled the private day IS in the ranked list — the sabotage is observable",
    scoredOpen.some((r) => r.path.startsWith(privatePath))
  );
  const filtered = rankedVisibleTo(scoredOpen, isTeamVisible);
  check(
    "guard 2 alone (rankedVisibleTo over a collection gathered with isVisible = () => true) still removes it",
    filtered.length > 0 && !filtered.some((r) => r.path.startsWith(privatePath))
  );
  check(
    "...and keeps the team day's message, so it is filtering rather than emptying",
    filtered.some((r) => r.path.startsWith(`${teamPath}#msg-`))
  );

  /* -- and the reason it must be notePath: an exact override ------------- */
  // `rankedVisibleTo` is handed results carrying `notePath` explicitly here,
  // so this fails the moment the filter is pointed back at `entry.path`.
  const handMade = [
    { path: `${privatePath}#msg-0123456789abcdef`, notePath: privatePath, score: 9 },
    { path: `${teamPath}#msg-fedcba9876543210`, notePath: teamPath, score: 1 },
  ];
  const handFiltered = rankedVisibleTo(handMade, isTeamVisible);
  check(
    "an exact-note predicate, asked directly, keeps exactly the sub-document whose containing note it names",
    handFiltered.length === 1 && handFiltered[0].notePath === teamPath
  );
  check(
    "a prefix scope still narrows on the key, so folder-scoped search is unchanged",
    rankedVisibleTo(handMade, () => true, "0-inbox/email/work-at-example-com/").length === 1
  );
}
