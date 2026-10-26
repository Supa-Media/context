// Who reads the Messages backup: what one read leaves in the person's bucket.
//
// SABOTAGE RECORD — applied to src/backupReads.js, suite re-run, reverted:
//
//   drop the bidi marks from readerName's clean             -> 2 checks failed
//   list oldest first in recentReads                        -> 1 check failed
//   read only this month's prefix                           -> 3 checks failed

import { BACKUP_PREFIX } from "../src/backup.js";
import { BACKUP_READS_PREFIX, normalizeReadRecord, readKeyOf, readerName, recentReads, recordRead } from "../src/backupReads.js";

function memoryStore() {
  const objects = new Map();
  return {
    objects,
    async put(key, value) {
      objects.set(key, String(value));
    },
    async get(key) {
      return objects.has(key) ? { text: async () => objects.get(key) } : null;
    },
    async list({ prefix = "", limit = 1000, startAfter } = {}) {
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix) && (!startAfter || key > startAfter)).sort();
      return { objects: keys.slice(0, limit).map((key) => ({ key })), truncated: keys.length > limit };
    },
  };
}

export async function runBackupReadsChecks(check) {
  check("reads: kept under the backup, so deleting the backup deletes them", BACKUP_READS_PREFIX.startsWith(BACKUP_PREFIX));

  const at = Date.UTC(2026, 9, 26, 14, 0, 0);
  const key = readKeyOf(at);
  check("reads: a key is the month and the moment, nothing of the reader", /^\.context\/messages\/imessage\/reads\/2026\/10\/\d{13}-[0-9a-f]{8}\.json$/.test(key));

  const kept = normalizeReadRecord({ at, who: "Claude", how: "searched", query: "rice", chat: "iMessage;-;+15550100" });
  check("reads: a record keeps who and how, never what was read", JSON.stringify(kept) === JSON.stringify({ v: 1, at, who: "Claude", how: "searched" }));
  check("reads: only the four kinds of read are kept", normalizeReadRecord({ at, who: "Claude", how: "deleted" }) === null && normalizeReadRecord({ who: "Claude", how: "read" }) === null);

  check("reads: a reader's name is one clean line", readerName("Evil\u202eredaeR\nApp\u0007") === "Evil redaeR App");
  check("reads: a reader with no name is \"An app\"", readerName("") === "An app" && readerName(null) === "An app" && readerName(" \u2066 ") === "An app");
  check("reads: a reader's name is kept short", readerName("x".repeat(500)).length === 80);

  const store = memoryStore();
  check("reads: a read is written", (await recordRead(store, { who: "Claude", how: "read", at })) === true && store.objects.size === 1);
  const written = JSON.parse([...store.objects.values()][0]);
  check("reads: what is written is the record", written.who === "Claude" && written.how === "read" && written.at === at);
  const broken = { put: async () => { throw new Error("down"); } };
  check("reads: a store that fails never fails the read", (await recordRead(broken, { who: "Claude", how: "read", at })) === false);
  check("reads: a kind that is not one writes nothing", (await recordRead(store, { who: "Claude", how: "wrote", at })) === false && store.objects.size === 1);

  const lastMonth = Date.UTC(2026, 8, 30, 9, 0, 0);
  const longAgo = Date.UTC(2026, 6, 1, 9, 0, 0);
  await recordRead(store, { who: "ChatGPT", how: "searched", at: lastMonth });
  await recordRead(store, { who: "Tex", how: "listed", at: longAgo });
  await recordRead(store, { who: "Claude", how: "downloaded", at: at + 60_000 });
  store.objects.set(`${BACKUP_READS_PREFIX}2026/10/0000000000001-garbage0.json`, "not json");
  const reads = await recentReads(store, { now: at + 120_000 });
  check("reads: newest first", reads.map((read) => read.how).join(",") === "downloaded,read,searched");
  check("reads: last month's are listed too, older ones are not", reads.some((read) => read.who === "ChatGPT") && !reads.some((read) => read.who === "Tex"));
  check("reads: at most the number asked for", (await recentReads(store, { now: at + 120_000, most: 1 })).length === 1);
  check("reads: a January lists December", (await recentReads(store, { now: Date.UTC(2026, 10, 2) })).some((read) => read.how === "downloaded") && (await recentReads(store, { now: Date.UTC(2027, 0, 2) })).length === 0);
}
