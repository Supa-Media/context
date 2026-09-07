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
 * 3. **Encrypted notes still yield nothing** (the phase-1 rule), carried
 *    through to sub-documents rather than only to whole notes.
 * 4. **Regenerating one channel-day note replaces exactly its
 *    sub-documents** — proved with two days in the same shard, one of them
 *    edited down, the other untouched.
 *
 * ## Sabotage record
 *
 * Each broken deliberately as a local edit and reverted; counts are against
 * the final fixtures in this file.
 *
 *   `isVisible` in `collectShardCandidates` checked against the sub-document's
 *     own key instead of `doc.notePath`                              2
 *   `docVersionsOf` keyed by the doc's own key instead of `notePath`
 *     (the diff never converges: every pass re-fetches every channel-day
 *     note it has already indexed)                                   1 (a
 *     no-progress loop caught by the convergence check)
 *   `removeDocsForNote` replaced with the old per-key `removeDoc` in the
 *     regeneration path (a removed message's sub-document survives)   1
 *   the independent per-message cap replaced with the whole-file cap
 *     applied before splitting (the last message of a large day is
 *     dropped, reproducing the bug this file exists to fix)           1
 */

import {
  channelDaySubDocuments,
  isChannelDayIndexPath,
  messageSegmentFor,
  subDocumentsFor,
} from "../src/search/commsIndex.js";
import { NOTE_INDEX_CHAR_CAP, createSearchBudget } from "../src/search/maintain.js";
import { searchIndexedNotes } from "../src/search/visible.js";
import { syncShardedIndex } from "../src/search/shards.js";
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
  /* Encrypted notes still yield nothing (the phase-1 rule)                  */
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
      "an encrypted channel-day note yields no sub-documents at all",
      Array.isArray(subs) && subs.length === 0
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
}

/* ---------------------------------------------------------------------- */
/* An in-memory bucket, R2/S3-shaped: pages, delimits, reports an etag.    */
/* ---------------------------------------------------------------------- */

function createBucket() {
  const objects = new Map();
  let etags = 0;
  const api = {
    objects,
    seed(key, body, uploaded = new Date()) {
      objects.set(key, { body, etag: `e${++etags}`, uploaded });
    },
    async get(key) {
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
async function converge(store, budget = 2000) {
  let last = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    last = await syncShardedIndex(store, { budget: createSearchBudget(budget) });
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
