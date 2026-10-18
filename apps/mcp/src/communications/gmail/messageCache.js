/**
 * The messages a day was last rendered from, kept so the next pass fetches
 * only what is new.
 *
 * A day note is regenerated from the day's complete list on every pass that
 * touches it (`sync.js`), and that list used to be fetched in full every time:
 * one `messages.get?format=full` per message on the day, for every new
 * message that landed on it. With push making a busy mailbox's passes thirty
 * seconds apart, today's hundredth email re-downloaded the ninety-nine before
 * it, and the hundred-and-first did it again. That is quadratic in a day's
 * mail, and it is what Google rate-limited (2026-10-18).
 *
 * A Gmail message never changes once it exists: an edit is a new message, and
 * what moves is its labels, which the day's own list query already answers.
 * So each day keeps the parsed events it was last rendered from here, keyed by
 * message id. A pass still lists the day, so the note is still exactly the
 * day's current list; it fetches only ids it has no event for, and drops
 * events whose id the list no longer names.
 *
 * A disposable derivative under `.context/`, like Calendar's event cache
 * (`calendarContributionStore.js`): anything unreadable, malformed or from an
 * older `VERSION` is an empty cache, which costs one full fetch of the day and
 * nothing else. Bump `VERSION` whenever `gmailMessageToEvent` changes what it
 * produces, or old days render from stale events.
 */

import { fnv1a64 } from "../../../../../packages/communications/src/anchors.js";

const ROOT = ".context/communications/gmail/messages";
export const MESSAGE_CACHE_VERSION = 1;

/** Days older than this are not cached: a pass almost never touches them twice. */
export const MESSAGE_CACHE_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

function folderFor(mailboxSlug) {
  return `${ROOT}/${fnv1a64(String(mailboxSlug ?? ""))}`;
}

export function messageCachePath(mailboxSlug, date) {
  return `${folderFor(mailboxSlug)}/${date}.json`;
}

/** Is `date` recent enough to cache, against the wall clock `now` (ms)? */
export function cachesDay(date, now) {
  now ??= Date.now();
  const day = Date.parse(`${date}T00:00:00.000Z`);
  return Number.isFinite(day) && now - day < MESSAGE_CACHE_DAYS * DAY_MS;
}

/**
 * The cached events for one day, by message id. Never throws: a cache that
 * cannot be read is an empty one.
 *
 * @returns {Promise<{events: Map<string, object>, existed: boolean}>}
 */
export async function readDayCache(store, mailboxSlug, date) {
  try {
    const object = await store.get(messageCachePath(mailboxSlug, date));
    if (!object) return { events: new Map(), existed: false };
    const parsed = JSON.parse(await object.text());
    if (parsed?.version !== MESSAGE_CACHE_VERSION || parsed.date !== date || !Array.isArray(parsed.events)) {
      return { events: new Map(), existed: true };
    }
    const events = new Map();
    for (const event of parsed.events) {
      if (event && typeof event === "object" && typeof event.messageId === "string" && event.messageId) {
        events.set(event.messageId, event);
      }
    }
    return { events, existed: true };
  } catch {
    return { events: new Map(), existed: false };
  }
}

/** One canonical serialization, so an unchanged day writes nothing. */
export function serializeDayCache(date, events) {
  const sorted = [...events].sort((left, right) => (left.messageId < right.messageId ? -1 : left.messageId > right.messageId ? 1 : 0));
  return JSON.stringify({ version: MESSAGE_CACHE_VERSION, date, events: sorted });
}

/**
 * Store the events a day was just rendered from, when they differ from what is
 * stored. Best effort: a failed write only costs the next pass a full fetch,
 * so it never fails the day. The first time a mailbox caches a day, days past
 * `MESSAGE_CACHE_DAYS` are deleted, so the folder holds about two weeks.
 *
 * `events` must be the pristine parsed events: `syncOneDay` annotates
 * attachments with stored paths, which must not be remembered past a file's
 * expiry.
 */
export async function writeDayCache(store, mailboxSlug, date, text, { existed, now = Date.now() } = {}) {
  try {
    const path = messageCachePath(mailboxSlug, date);
    const current = existed ? await store.get(path) : null;
    if (current && (await current.text()) === text) return false;
    await store.put(path, text, { contentType: "application/json" });
    if (!existed) await pruneDayCaches(store, mailboxSlug, now);
    return true;
  } catch {
    return false;
  }
}

async function pruneDayCaches(store, mailboxSlug, now) {
  if (typeof store.list !== "function" || typeof store.delete !== "function") return;
  const prefix = `${folderFor(mailboxSlug)}/`;
  let cursor;
  for (let page = 0; page < 10; page += 1) {
    const listed = await store.list({ prefix, cursor });
    for (const object of listed?.objects ?? []) {
      const date = /(\d{4}-\d{2}-\d{2})\.json$/.exec(object.key)?.[1];
      if (date !== undefined && !cachesDay(date, now)) await store.delete(object.key);
    }
    if (!listed?.truncated || !listed.cursor) return;
    cursor = listed.cursor;
  }
}
