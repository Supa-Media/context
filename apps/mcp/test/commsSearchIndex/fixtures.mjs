// Shared fixtures for the comms search index suite: a fake message builder, a
// large-day-note builder, and an in-memory R2/S3-shaped bucket with a
// convergence helper over `syncShardedIndex`.
//
// Split out of commsSearchIndex.test.mjs; see that file's sections for the
// checks built on these fixtures.

import { NOTE_INDEX_CHAR_CAP, createSearchBudget } from "../../src/search/maintain.js";
import { syncShardedIndex } from "../../src/search/shards.js";
import { renderChannelDayNote } from "../../../../packages/communications/src/note.js";

export const encoder = new TextEncoder();

/** One message, with everything the renderer reads. Every value is fake. */
export function msg(overrides = {}) {
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

export const DAY_BASE = {
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
export function bigDayNote(path, options = {}) {
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

export const NOTE_PATH = "0-inbox/email/name-at-example-com/2026-09-07.md";

/* -------------------------------------------------------------------------- */
/* An in-memory bucket, R2/S3-shaped: pages, delimits, reports an etag.       */
/* -------------------------------------------------------------------------- */

export function createBucket() {
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
export async function converge(store, budget = 2000, options = {}) {
  let last = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    last = await syncShardedIndex(store, { budget: createSearchBudget(budget), ...options });
    if (last.pending === 0) break;
  }
  return last;
}

// Re-exported so section files that need the char cap don't each import
// `maintain.js` for one constant.
export { NOTE_INDEX_CHAR_CAP };
