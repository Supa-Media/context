/**
 * The mailbox measurement behind `docs/decisions/search.md`, "The index is
 * sized by the volume it has to hold", run against whatever is checked out.
 *
 * **Deliberately not part of `pnpm test`.** It builds tens of megabytes of
 * Markdown and runs the real 2MB shard cap, which is a minute of CPU rather
 * than a suite check; the *mechanism* is pinned at suite speed by
 * `runShardBudgetChecks` in `commsSearchIndex.test.mjs` with a small
 * `shardByteCap`. This file exists so the numbers in the decision docs can be
 * re-measured by anyone who doubts them, which is the standing rule in
 * `docs/decisions/testing.md`: a guard nobody has checked is not a guard, and
 * a number nobody can reproduce is not a measurement.
 *
 *   node apps/mcp/test/bench/shardSizing.mjs                 # the review's case
 *   node apps/mcp/test/bench/shardSizing.mjs --days 365 --per-day 200
 *   node apps/mcp/test/bench/shardSizing.mjs --sweep         # the threshold
 *
 * Every value in the fixtures is fake, as everywhere else in this repository.
 */

import { createSearchBudget } from "../../src/search/maintain.js";
import { syncShardedIndex } from "../../src/search/shards.js";
import { searchIndexedNotes } from "../../src/search/visible.js";
import { renderChannelDayNote } from "../../../../packages/communications/src/note.js";

const encoder = new TextEncoder();

/* -- the same in-memory bucket the suite uses ---------------------------- */

function createBucket() {
  const objects = new Map();
  let etags = 0;
  const api = {
    objects,
    puts: 0,
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
      api.puts += 1;
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
          page.push({
            key,
            size: encoder.encode(stored.body).length,
            uploaded: stored.uploaded,
            etag: stored.etag,
          });
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

/* -- the mailbox --------------------------------------------------------- */

const ACCOUNT = "name-at-example-com";

function dayNote(dayIndex, perDay, marker) {
  const date = new Date(Date.UTC(2026, 0, 1 + dayIndex)).toISOString().slice(0, 10);
  const events = [];
  for (let i = 0; i < perDay; i += 1) {
    const last = i === perDay - 1;
    events.push({
      channel: "email",
      account: ACCOUNT,
      messageId: `<d${dayIndex}m${i}@mail.example.net>`,
      threadId: `thread-${dayIndex}-${i % 7}`,
      sentAt: new Date(Date.UTC(2026, 0, 1 + dayIndex, 6, i % 60, i % 60)).toISOString(),
      subject: `Message ${i} of day ${dayIndex}`,
      from: { name: "Adam Okonkwo", address: "adam@example.net" },
      to: [{ address: "name@example.com" }],
      // ~1.4KB of body, the storage estimate's low end for a normalized mail.
      body: `Body ${i}. ${"lorem ipsum dolor sit amet consectetur ".repeat(30)}${
        last && marker ? ` ${marker}` : ""
      }`,
      attachments: [],
    });
  }
  return {
    path: `0-inbox/email/${ACCOUNT}/${date}.md`,
    text: renderChannelDayNote({
      channel: "email",
      account: ACCOUNT,
      address: "name@example.com",
      date,
      nonce: "0123456789abcdef",
      now: `${date}T18:04:11.221Z`,
      events,
    }),
  };
}

function seedScenario({ days, perDay, plainNotes, marker }) {
  const bucket = createBucket();
  let mailBytes = 0;
  for (let day = 0; day < days; day += 1) {
    const note = dayNote(day, perDay, day === days - 1 ? marker : null);
    mailBytes += encoder.encode(note.text).length;
    bucket.seed(note.path, note.text);
  }
  for (let i = 0; i < plainNotes; i += 1) {
    bucket.seed(
      `1-projects/plan-${String(i).padStart(3, "0")}.md`,
      `# Plan ${i}\n\nordinary-note-word and some prose about project ${i}.\n`
    );
  }
  return { bucket, mailBytes };
}

/* -- one measured run ---------------------------------------------------- */

async function measure({ days, perDay, plainNotes = 200, budget = 600, maxPasses = 40 }) {
  const marker = "zzmarkerzz";
  const { bucket, mailBytes } = seedScenario({ days, perDay, plainNotes, marker });

  let passes = 0;
  let last = null;
  for (; passes < maxPasses; passes += 1) {
    last = await syncShardedIndex(bucket, { budget: createSearchBudget(budget) });
    if (last.pending === 0 && !last.listingTruncated) {
      passes += 1;
      break;
    }
  }

  const shardKeys = [...bucket.objects.keys()].filter((key) => key.startsWith(".index/v2/shard-"));
  const shardBytes = shardKeys.reduce(
    (total, key) => total + encoder.encode(bucket.objects.get(key).body).length,
    0
  );

  const run = async (query) => {
    const started = Date.now();
    const answer = await searchIndexedNotes(bucket, {
      isVisible: () => true,
      isIndexable: (key) => key.endsWith(".md"),
      query,
      budget: createSearchBudget(budget),
      refreshOnMiss: false,
    });
    return { answer, ms: Date.now() - started };
  };

  const mail = await run(marker);
  const plain = await run("ordinary-note-word");

  return {
    days,
    perDay,
    plainNotes,
    notes: days + plainNotes,
    mailMB: (mailBytes / 1e6).toFixed(1),
    documents: last.manifest.stats.reduce((total, entry) => total + entry.docCount, 0),
    built: [...last.shards.values()].reduce((total, shard) => total + shard.docs.size, 0),
    shardCount: last.manifest.shardCount,
    shardObjects: shardKeys.length,
    shardMB: (shardBytes / 1e6).toFixed(2),
    passes,
    pending: last.pending,
    oversized: last.oversizedShards ?? 0,
    degraded: (last.degraded || []).length,
    mail: `${mail.answer.indexed ? `${(mail.answer.hits || []).length} hit` : "indexed: false"}, ${mail.ms}ms`,
    plain: `${plain.answer.indexed ? `${(plain.answer.hits || []).length} hit` : "indexed: false"}, ${plain.ms}ms`,
  };
}

/* -- the runner ---------------------------------------------------------- */

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  if (at === -1 || at === process.argv.length - 1) return fallback;
  const value = Number(process.argv[at + 1]);
  return Number.isFinite(value) ? value : fallback;
}

function print(row) {
  console.log(
    [
      `days=${row.days}x${row.perDay}`,
      `notes=${row.notes}`,
      `mail=${row.mailMB}MB`,
      `docs=${row.documents}`,
      `built=${row.built}`,
      `shards=${row.shardCount}`,
      `written=${row.shardObjects} (${row.shardMB}MB)`,
      `passes=${row.passes}`,
      `pending=${row.pending}`,
      `oversized=${row.oversized}`,
      `degraded=${row.degraded}`,
      `mail-search=${row.mail}`,
      `plain-search=${row.plain}`,
    ].join("  ")
  );
}

const sweep = process.argv.includes("--sweep");
if (sweep) {
  for (const perDay of [10, 20, 50, 100, 200, 400, 800]) {
    print(await measure({ days: arg("days", 90), perDay }));
  }
} else {
  print(await measure({ days: arg("days", 90), perDay: arg("per-day", 200), plainNotes: arg("plain", 200) }));
}
