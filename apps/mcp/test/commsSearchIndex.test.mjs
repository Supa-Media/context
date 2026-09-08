/**
 * Phase 2 of `docs/decisions/communications.md`, "Search must index messages,
 * and today's index cannot": a channel-day note indexed as one sub-document
 * per message anchor (`src/search/commsIndex.js`), against
 * `src/search/CONTRACT.md`'s "Channel-day notes: one sub-document per
 * message".
 *
 * Four properties, each with its own section below:
 *
 * 1. **Recall reaches the last message of a large day** — the check
 *    `docs/decisions/communications.md` names as the one that will matter —
 *    proved by putting the interesting word in the LAST message of a day
 *    whose combined text is many times `NOTE_INDEX_CHAR_CAP`, and finding it.
 * 2. **`canSee` runs on the containing note, never per message**: the same
 *    message text in a private day and a team day, and only the team hit
 *    returns; two workspaces holding the identical message text, and a
 *    search in one never surfaces the other's shard.
 * 3. **Encrypted notes teach the index no plaintext term** (the phase-1
 *    rule), carried through to sub-documents rather than only to whole notes.
 * 4. **Regenerating one channel-day note replaces exactly its
 *    sub-documents** — proved with two days in the same shard, one of them
 *    edited down, the other untouched.
 *
 * The adversarial review's own sections are at the bottom of the file, each
 * naming the claim it attacks: the two visibility guards driven one at a
 * time, the existence oracle, a cross-workspace key collision, a shard
 * constructed in the pre-change shape, a rebuild compared against an
 * incremental update, the no-message fallback, and the shard budget.
 *
 * ## Sabotage record
 *
 * Each broken deliberately as a local edit and reverted; counts are whole-suite
 * (`pnpm test`) against the final fixtures in this file. The right-hand
 * column is the review's re-measurement; where it differs from the number
 * the change was written with, the difference is the checks added below.
 *
 *   `isVisible` in `collectShardCandidates` checked against the sub-document's
 *     own key instead of `doc.notePath`                          2 -> 6
 *   `rankedVisibleTo` filtering on `entry.path` instead of
 *     `entry.notePath ?? entry.path` (the second guard)          2 -> 7
 *     — and the two it reddened before were both "the answer went
 *     empty", not "the private note leaked": nothing distinguished
 *     the guard working from the guard being unnecessary until
 *     `runGuardIndependenceChecks` drove each guard alone.
 *   `docVersionsOf` keyed by the doc's own key instead of `notePath`
 *     (the diff never converges: every pass re-fetches every channel-day
 *     note it has already indexed)                               1 -> 1
 *   `removeDocsForNote` replaced with the old per-key `removeDoc` in the
 *     regeneration path (a removed message's sub-document survives) 1 -> 7
 *   the independent per-message cap replaced with the whole-file cap
 *     applied before splitting (the last message of a large day is
 *     dropped, reproducing the bug this file exists to fix)      1 -> 10
 *   `subDocumentsFor` answering `[]` again for a channel-day file with no
 *     message headings (an encrypted day, a hand-written note)        5
 *   the anchor split removed from `read_note` and the ChatGPT dialect's
 *     `fetch`, so a search hit's key is not a key either accepts        4
 *     (in `test.mjs`, where the round trip is asserted against the
 *     real worker)
 */

import {
  channelDaySubDocuments,
  indexVolumeOf,
  isChannelDayIndexPath,
  messageSegmentFor,
  subDocumentsFor,
} from "../src/search/commsIndex.js";
import { NOTE_INDEX_CHAR_CAP, createSearchBudget } from "../src/search/maintain.js";
import { searchIndexedNotes } from "../src/search/visible.js";
import { chooseShardCount, serializeShard, syncShardedIndex } from "../src/search/shards.js";
import { addDoc, emptyIndex, readComms } from "../src/search/indexer.js";
import { parseQuery, rankedVisibleTo } from "../src/search/query.js";
import { collectShardCandidates, scoreCollected } from "../src/search/shardQuery.js";
import { messageAnchor } from "../../../packages/communications/src/anchors.js";
import { renderChannelDayNote } from "../../../packages/communications/src/note.js";
import { isEncryptedNote } from "../src/encryption.js";

const encoder = new TextEncoder();

/** One message, with everything the renderer reads. Every value is fake. */
function msg(overrides = {}) {
  return {
    channel: "email",
    account: "name-at-example-com",
    messageId: "<a1@mail.example.net>",
    threadId: "thread-1",
    sentAt: "2026-09-07T09:14:00.000Z",
    subject: "Quarterly numbers",
    from: { name: "Adam Okonkwo", address: "adam@example.net" },
    to: [{ address: "name@example.com" }],
    body: "The numbers are attached.",
    attachments: [],
    ...overrides,
  };
}

const DAY_BASE = {
  channel: "email",
  account: "name-at-example-com",
  address: "name@example.com",
  date: "2026-09-07",
  nonce: "0123456789abcdef",
  now: "2026-09-07T18:04:11.221Z",
};

/**
 * A rendered channel-day note whose COMBINED text is well past
 * `NOTE_INDEX_CHAR_CAP`, built from many SMALL messages — each individually
 * far under the cap — so that a whole-file cap applied once would still miss
 * the later messages entirely, while a per-message cap applied to each one
 * independently never comes close to truncating any of them. That is the
 * exact shape `docs/decisions/communications.md` names: "index the first two
 * or three messages and silently drop the rest."
 */
function bigDayNote(path, options = {}) {
  const count = options.count ?? 16;
  const fillerChars = options.fillerChars ?? 80;
  const events = [];
  for (let i = 0; i < count; i += 1) {
    events.push(
      msg({
        messageId: `<msg-${i}@mail.example.net>`,
        threadId: `thread-${i}`,
        sentAt: new Date(Date.UTC(2026, 8, 7, 8, i)).toISOString(),
        subject: `Message ${i}`,
        body: `filler ${"x".repeat(fillerChars)} findme${String(i).padStart(2, "0")}uniquemarker`,
      })
    );
  }
  const day = { ...DAY_BASE, events, ...options };
  const text = renderChannelDayNote(day);
  return { text, events, path };
}

const NOTE_PATH = "0-inbox/email/name-at-example-com/2026-09-07.md";

export async function runCommsSearchIndexChecks(check) {
  /* ---------------------------------------------------------------------- */
  /* 1. Per-anchor sub-documents, capped independently, keyed path#anchor    */
  /* ---------------------------------------------------------------------- */

  {
    const { text, events } = bigDayNote(NOTE_PATH, { count: 40, fillerChars: 80 });
    const subs = channelDaySubDocuments(NOTE_PATH, text);
    const last = subs[subs.length - 1];

    // The property that matters, checked directly rather than inferred from a
    // total-length heuristic: the LAST message's own heading sits well past
    // character 2,048 of the raw file, so a single whole-file cap applied
    // before splitting — today's bug — would never have reached it at all.
    const lastHeadingOffset = text.indexOf(`{#${last.anchor}}`);
    check(
      "the last message's heading sits well past NOTE_INDEX_CHAR_CAP in the raw file",
      lastHeadingOffset > NOTE_INDEX_CHAR_CAP
    );
    // And every individual message is small — the cap is never the reason a
    // message's own content is short here; independence is what is on trial.
    check(
      "each individual message is far smaller than the cap on its own",
      subs.every((sub) => sub.content.length < NOTE_INDEX_CHAR_CAP / 4)
    );

    check("one sub-document per message", subs.length === events.length);

    const anchors = new Set(subs.map((s) => s.anchor));
    check("every sub-document has a distinct anchor", anchors.size === events.length);
    for (const event of events) {
      check(
        `the anchor for message ${event.subject} matches messageAnchor()`,
        subs.some((s) => s.anchor === messageAnchor(event))
      );
    }

    for (const sub of subs) {
      check(`${sub.key} is keyed path#anchor`, sub.key === `${NOTE_PATH}#${sub.anchor}`);
      check(`${sub.key} carries the containing note's path`, sub.notePath === NOTE_PATH);
      check(`${sub.key}'s own content is capped at NOTE_INDEX_CHAR_CAP`, sub.content.length <= NOTE_INDEX_CHAR_CAP);
    }

    // The check that matters: the LAST message's word is findable in ITS OWN
    // sub-document — recall the whole-file cap could never give, since the
    // last message's heading sits well past character 2,048 of the file.
    check(
      "a term in the last message of a large day is found — the one CONTRACT.md names",
      last.content.includes("findme39uniquemarker")
    );

    // And fields are disjoint: message 0's word is not smuggled into the last
    // message's sub-document, or every message would falsely match every word.
    check(
      "a message's sub-document does not carry another message's word",
      !last.content.includes("findme00uniquemarker")
    );

    // Filterable fields, per the decision: date, channel, thread id (the
    // rendered thread label — see the module comment on why it is not a
    // hashed provider id), participants.
    for (const sub of subs) {
      check(`${sub.key} carries the day's channel`, sub.comms.channel === "email");
      check(`${sub.key} carries the day's date`, sub.comms.date === "2026-09-07");
      check(`${sub.key} carries a thread label`, typeof sub.comms.threadId === "string" && sub.comms.threadId.length > 0);
      check(`${sub.key} carries at least one participant`, sub.comms.participants.length > 0);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* A single oversized message is capped on its own, without disturbing    */
  /* its neighbours — "each capped independently".                          */
  /* ---------------------------------------------------------------------- */

  {
    const marker = "giant-message-marker-at-start";
    const events = [
      msg({ messageId: "<small@mail.example.net>", threadId: "t-small", subject: "Small", body: "a short message" }),
      msg({
        messageId: "<giant@mail.example.net>",
        threadId: "t-giant",
        sentAt: "2026-09-07T10:00:00.000Z",
        subject: "Giant",
        // The marker sits at the very start, so it survives truncation to
        // NOTE_INDEX_CHAR_CAP even though the body itself is many times that.
        body: `${marker} ${"z".repeat(NOTE_INDEX_CHAR_CAP * 3)}`,
      }),
    ];
    const text = renderChannelDayNote({ ...DAY_BASE, events });
    const subs = channelDaySubDocuments(NOTE_PATH, text);
    const giant = subs.find((s) => s.content.includes(marker) || s.anchor === messageAnchor(events[1]));
    const small = subs.find((s) => s.anchor === messageAnchor(events[0]));

    check("the oversized message's sub-document is capped at NOTE_INDEX_CHAR_CAP", giant.content.length === NOTE_INDEX_CHAR_CAP);
    check("...but the marker at its own start still survives the cap", giant.content.includes(marker));
    check(
      "...and its oversized neighbour does not shrink the small message's own sub-document",
      small.content.includes("a short message") && small.content.length < NOTE_INDEX_CHAR_CAP
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Rebuilding from the files produces the same sub-documents               */
  /* ---------------------------------------------------------------------- */

  {
    const { text } = bigDayNote(NOTE_PATH, { count: 5 });
    const first = channelDaySubDocuments(NOTE_PATH, text);
    const second = channelDaySubDocuments(NOTE_PATH, text);
    check(
      "rebuilding the index from the same note produces the same sub-documents",
      JSON.stringify(first) === JSON.stringify(second)
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Non-channel notes are unchanged                                        */
  /* ---------------------------------------------------------------------- */

  {
    const path = "1-projects/plan.md";
    const content = `# Plan\n\n${"y".repeat(NOTE_INDEX_CHAR_CAP + 500)}tail-word`;
    check("an ordinary path is not recognised as a channel day", !isChannelDayIndexPath(path));
    const subs = subDocumentsFor(path, content);
    check("an ordinary note yields exactly one sub-document", subs.length === 1);
    check("that sub-document's key is the note's own path", subs[0].key === path && subs[0].anchor === null);
    check(
      "and it keeps the existing whole-note cap — no independent per-message split for a note with no messages",
      subs[0].content.length === NOTE_INDEX_CHAR_CAP && !subs[0].content.includes("tail-word")
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Encrypted notes still learn the index nothing (the phase-1 rule)        */
  /* ---------------------------------------------------------------------- */

  {
    const encryptedLooking = [
      "---",
      "context_encryption: v1",
      "---",
      "",
      "```context-encrypted",
      '{"ciphertext":"not-real-and-holds-no-message-headings"}',
      "```",
      "",
    ].join("\n");
    check("the fixture reads as an encrypted note", isEncryptedNote(encryptedLooking));
    const subs = subDocumentsFor(NOTE_PATH, encryptedLooking);
    check(
      "an encrypted channel-day note yields no MESSAGE sub-documents",
      subs.every((sub) => sub.anchor === null)
    );
    /*
      It contributes the one whole-note document an ordinary encrypted note
      already contributes, and not zero. Zero was what this branch did when
      it was written, and review measured what that costs: `docsByShard`
      records a note's version by `doc.notePath`, so a note with no documents
      has no version recorded, is stale on every later listing, and is
      re-fetched and re-written on every pass forever — see
      `runNoMessageFallbackChecks`. Nothing of the plaintext reaches the index
      either way, which is the property the phase-1 rule is actually about,
      and `visible.js` still drops the note at snippet time on
      `isEncryptedNote`.
    */
    check(
      "...it contributes exactly the one whole-note document an ordinary encrypted note does",
      subs.length === 1 && subs[0].key === NOTE_PATH && subs[0].notePath === NOTE_PATH
    );
    check(
      "...and no message anchor was invented out of ciphertext",
      channelDaySubDocuments(NOTE_PATH, encryptedLooking).length === 0
    );
  }

  /* ---------------------------------------------------------------------- */
  /* messageSegmentFor: the snippet source, re-read fresh                   */
  /* ---------------------------------------------------------------------- */

  {
    const { text, events } = bigDayNote(NOTE_PATH, { count: 3 });
    const anchor = messageAnchor(events[1]);
    const segment = messageSegmentFor(NOTE_PATH, text, anchor);
    check("messageSegmentFor finds the anchor it is given", segment !== null);
    check(
      "and its snippetText carries that message's own word",
      segment.snippetText.includes("findme01uniquemarker")
    );
    check(
      "an anchor that does not exist in the note answers null, not a guess",
      messageSegmentFor(NOTE_PATH, text, "msg-0000000000000000") === null
    );
  }

  await runSyncLoopChecks(check);
  await runVisibilityChecks(check);
  await runRegenerationChecks(check);
  await runGuardIndependenceChecks(check);
  await runExistenceOracleChecks(check);
  await runTenantCollisionChecks(check);
  await runLegacyIndexChecks(check);
  await runRebuildChecks(check);
  await runNoMessageFallbackChecks(check);
  await runShardSizingChecks(check);
}

/* ---------------------------------------------------------------------- */
/* An in-memory bucket, R2/S3-shaped: pages, delimits, reports an etag.    */
/* ---------------------------------------------------------------------- */

function createBucket() {
  const objects = new Map();
  let etags = 0;
  const api = {
    objects,
    // Every `get` this store served. Counted because a *timing* tell and a
    // *work* tell are the same channel measured two ways, and only one of
    // them is deterministic enough to assert on: two answers that read the
    // same number of objects cannot differ in latency for a reason the
    // hidden note caused. See `runExistenceOracleChecks`.
    gets: 0,
    seed(key, body, uploaded = new Date()) {
      objects.set(key, { body, etag: `e${++etags}`, uploaded });
    },
    async get(key) {
      api.gets += 1;
      const stored = objects.get(key);
      if (!stored) return null;
      return {
        etag: stored.etag,
        text: async () => stored.body,
        arrayBuffer: async () => encoder.encode(stored.body).buffer,
      };
    },
    async put(key, value, options = {}) {
      const expected = options?.onlyIf?.etagMatches;
      if (expected && objects.get(key)?.etag !== expected) return null;
      const body = typeof value === "string" ? value : new TextDecoder().decode(value);
      objects.set(key, { body, etag: `e${++etags}`, uploaded: new Date() });
      return { etag: `e${etags}` };
    },
    async delete(key) {
      objects.delete(key);
    },
    async list({ prefix = "", delimiter, cursor, limit = 1000 } = {}) {
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
      const from = cursor ? keys.findIndex((key) => key > cursor) : 0;
      if (from === -1) return { objects: [], delimitedPrefixes: [], truncated: false };
      const page = [];
      const prefixes = new Set();
      let index = from;
      for (let spent = 0; index < keys.length && spent < limit; index += 1, spent += 1) {
        const key = keys[index];
        const remainder = key.slice(prefix.length);
        const slash = delimiter ? remainder.indexOf(delimiter) : -1;
        if (slash === -1) {
          const stored = objects.get(key);
          page.push({ key, size: stored.body.length, uploaded: stored.uploaded, etag: stored.etag });
        } else {
          prefixes.add(`${prefix}${remainder.slice(0, slash + 1)}`);
        }
      }
      const truncated = index < keys.length;
      return {
        objects: page,
        delimitedPrefixes: [...prefixes],
        truncated,
        cursor: truncated ? keys[index - 1] : undefined,
      };
    },
  };
  return api;
}

/** Run passes until the sync says it has nothing left, or give up loudly. */
async function converge(store, budget = 2000, options = {}) {
  let last = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    last = await syncShardedIndex(store, { budget: createSearchBudget(budget), ...options });
    if (last.pending === 0) break;
  }
  return last;
}

async function runSyncLoopChecks(check) {
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

async function runVisibilityChecks(check) {
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
  const shardKeysA = [...workspaceA.objects.keys()].filter((k) => k.startsWith(".index/v2/shard-"));
  let sawB = false;
  for (const key of shardKeysA) {
    if (workspaceA.objects.get(key).body.includes("B holds")) sawB = true;
  }
  check("a sub-document from one workspace is never returned to another (proved on the stored bytes)", !sawB);
}

async function runRegenerationChecks(check) {
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
async function runGuardIndependenceChecks(check) {
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
async function runExistenceOracleChecks(check) {
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
async function runTenantCollisionChecks(check) {
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
      ([key, stored]) => key.startsWith(".index/") && stored.body.includes("yankeemikebravo")
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

async function runLegacyIndexChecks(check) {
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
  bucket.seed(".index/v2/shard-000.json", bytes, uploaded);
  bucket.seed(
    ".index/v2/manifest.json",
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
    ".index/v2/docmap.json",
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

/**
 * The claim: sub-documents are disposable derivatives — a rebuild from the
 * files reproduces them exactly, and a note that shrinks leaves no orphans.
 *
 * "Byte-for-byte" is taken literally: the incrementally-updated shard object
 * and one built from scratch over the same final files are compared as
 * stored bytes, which is the only comparison that would catch an orphan
 * posting that no longer scores but is still written down.
 */
async function runRebuildChecks(check) {
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

  const shardKeys = [...incremental.objects.keys()].filter((key) => key.startsWith(".index/v2/shard-")).sort();
  const freshKeys = [...fresh.objects.keys()].filter((key) => key.startsWith(".index/v2/shard-")).sort();
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

  const docmapIncremental = JSON.parse(incremental.objects.get(".index/v2/docmap.json").body);
  const docmapFresh = JSON.parse(fresh.objects.get(".index/v2/docmap.json").body);
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
async function runNoMessageFallbackChecks(check) {
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
      ([key, stored]) => key.startsWith(".index/v2/shard-") && stored.body.includes("plaintext-canary-beta")
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
async function runShardSizingChecks(check) {
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
  const shardObjects = [...mailbox.objects.keys()].filter((key) => key.startsWith(".index/v2/shard-"));
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

  /* -- 5. growth: a converged brain that later connects a mailbox -------- */

  const grown = createBucket();
  for (const note of plainNotes(20)) grown.seed(note.path, note.text);
  const before = await converge(grown, 2000, { shardByteCap: cap });
  check("a brain of ordinary notes sizes itself at one shard", before.manifest.shardCount === 1);
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
  const shedShards = [...tight.objects.keys()].filter((key) => key.startsWith(".index/v2/shard-"));
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
      [...impossible.objects.keys()].every((key) => !key.startsWith(".index/v2/shard-"))
  );
}
