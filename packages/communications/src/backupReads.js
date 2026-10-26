// Who reads the Messages backup: one small record per read, kept beside the
// backup in the person's own bucket, so Settings › Messages can say "Claude
// searched your texts, 2 hours ago" (board 2, "Who reads them", owner
// 2026-10-26; `docs/decisions/communications/messages-backup.md`).
//
// In the bucket and not in the control plane for the reason usage counters
// carry no query: what a person's AIs read is theirs, and their own storage
// is where a record of it lives. It sits under the backup, so deleting the
// backup deletes its history too. A record names the reader and what kind of
// read it was, never a conversation, a word or a person texted.

import { BACKUP_PREFIX } from "./backup.js";

export const BACKUP_READS_PREFIX = `${BACKUP_PREFIX}reads/`;

/** The kinds of read, each a phrase the page finishes. */
export const READ_KINDS = Object.freeze(["searched", "listed", "read", "downloaded"]);

/** Characters of a reader's name kept. */
const NAME_MOST = 80;
// Controls and bidi marks: a client names itself, so its name is cleaned like any other text from outside.
const UNSAFE = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g;

/** A reader's name as it is kept: one plain line, or "An app" when it gave none. */
export function readerName(name) {
  const cleaned = String(name ?? "").replace(UNSAFE, " ").replace(/\s+/g, " ").trim().slice(0, NAME_MOST).trim();
  return cleaned === "" ? "An app" : cleaned;
}

/** A read record as it is kept, or null when it is not one. */
export function normalizeReadRecord(raw) {
  if (typeof raw !== "object" || raw === null) return null;
  const at = typeof raw.at === "number" && Number.isFinite(raw.at) ? raw.at : null;
  if (at === null || !READ_KINDS.includes(raw.how)) return null;
  return { v: 1, at, who: readerName(raw.who), how: raw.how };
}

function randomPart() {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** `reads/<yyyy>/<mm>/<13-digit ms>-<random>.json`: listed in the order they happened, month by month. */
export function readKeyOf(at) {
  const iso = new Date(at).toISOString();
  return `${BACKUP_READS_PREFIX}${iso.slice(0, 4)}/${iso.slice(5, 7)}/${String(at).padStart(13, "0")}-${randomPart()}.json`;
}

/**
 * Keep one read. Never throws: a read that could not be written down is
 * still the person's answer, and the page says the history may be missing
 * some only by being a history, not a guarantee.
 *
 * @param {{ put(key: string, value: string, options?: object): Promise<unknown> }} store
 * @param {{ who: string, how: string, at?: number }} read
 */
export async function recordRead(store, { who, how, at = Date.now() }) {
  const record = normalizeReadRecord({ at, who, how });
  if (record === null) return false;
  try {
    // Without a type, as the log's objects are written: a string with none is text the store keeps as it is.
    await store.put(readKeyOf(at), JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

/** Keys one month's listing reads at most. */
const MONTH_KEYS = 1000;

/**
 * The newest reads, this month's and last month's, newest first, at most `most`.
 *
 * @param {{ list(options: object): Promise<any>, get(key: string): Promise<any> }} store
 */
export async function recentReads(store, { now = Date.now(), most = 20 } = {}) {
  const here = new Date(now);
  const months = [0, 1].map((back) => {
    const at = new Date(Date.UTC(here.getUTCFullYear(), here.getUTCMonth() - back, 1));
    return `${BACKUP_READS_PREFIX}${at.toISOString().slice(0, 4)}/${at.toISOString().slice(5, 7)}/`;
  });
  const keys = [];
  for (const prefix of months) {
    let after;
    for (let page = 0; page < 10; page += 1) {
      const listed = await store.list({ prefix, limit: MONTH_KEYS, ...(after ? { startAfter: after } : {}) });
      const found = (listed?.objects ?? []).map((object) => object.key).filter((key) => typeof key === "string" && key.startsWith(prefix) && (!after || key > after));
      keys.push(...found);
      if (!listed?.truncated || found.length === 0) break;
      after = found.at(-1);
    }
  }
  const newest = keys.sort().reverse().slice(0, most);
  const reads = [];
  for (const key of newest) {
    try {
      const object = await store.get(key);
      const record = object ? normalizeReadRecord(JSON.parse(await object.text())) : null;
      if (record !== null) reads.push({ at: record.at, who: record.who, how: record.how });
    } catch {
      // A record that cannot be read is left out, never shown as something it is not.
    }
  }
  return reads;
}
