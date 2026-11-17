/**
 * Where a texted turn's rounds wait for a try after a crash (Dev2, 2026-11-17; `agent/savedRounds.js`): in the
 * chat's own home, beside its ledger, never in the texting Worker. A person's in their personal workspace's object,
 * a group chat's in its own Tex object, so a group's sealed memory never leaves the home only its people open.
 *
 * A cache, never a copy of record: one row per text being answered, the newest snapshot of what its turn has done,
 * read back only by the next try of that same text, deleted once it is answered (`turnResume.js` `forget`) and
 * unreadable after `ROUNDS_FRESH_MS`. Expired rows are deleted on read and on forget as well as on save, so a
 * snapshot of mail or note text does not sit until the next text is saved.
 * Not notes, so never listed, searched or exported; wiped with the ledger (`wire.js` `wipe`).
 */
import { TexObjectRefused } from "./objects.js";

/** How long a text's rounds are read back: its tries are minutes apart (`apps/agent/src/inbox.ts`). */
export const ROUNDS_FRESH_MS = 30 * 60 * 1000;
/** One snapshot, as JSON: pictures are never in it, and long results are cut before it gets here (`agent/savedRounds.js`). */
export const MAX_ROUNDS_BYTES = 1_500_000;

const CHAT = /^[A-Za-z0-9_.:@+=-]{1,128}$/;
const KEY = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();
const rows = (cursor) => (typeof cursor?.toArray === "function" ? cursor.toArray() : []);

function check(chat, key) {
  if (typeof chat !== "string" || !CHAT.test(chat)) throw new TexObjectRefused("not a chat this store keeps");
  if (typeof key !== "string" || !KEY.test(key)) throw new TexObjectRefused("not a text's key");
}

export function texRounds(sql, { now = Date.now, guard = () => {} } = {}) {
  sql.exec("CREATE TABLE IF NOT EXISTS ledger_rounds (chat TEXT NOT NULL, key TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (chat, key))");
  const prune = () => sql.exec("DELETE FROM ledger_rounds WHERE at < ?", now() - ROUNDS_FRESH_MS);
  return {
    /** Keep a text's newest snapshot, replacing the one before; stale rows of any text go with it. */
    put(chat, key, data) {
      check(chat, key);
      const text = JSON.stringify(data ?? null);
      if (encoder.encode(text).byteLength > MAX_ROUNDS_BYTES) throw new TexObjectRefused(`rounds larger than ${MAX_ROUNDS_BYTES} bytes`);
      guard();
      prune();
      sql.exec("INSERT OR REPLACE INTO ledger_rounds (chat, key, at, data) VALUES (?, ?, ?, ?)", chat, key, now(), text);
      return { ok: true };
    },
    /** A text's snapshot while fresh, or null. Expired rows of any text go with the read. */
    get(chat, key) {
      check(chat, key);
      guard();
      prune();
      const row = rows(sql.exec("SELECT data FROM ledger_rounds WHERE chat = ? AND key = ?", chat, key))[0];
      if (!row) return null;
      try {
        return JSON.parse(row.data);
      } catch {
        return null;
      }
    },
    /** The text is answered: its snapshot goes, and so does every expired one. */
    forget(chat, key) {
      check(chat, key);
      guard();
      sql.exec("DELETE FROM ledger_rounds WHERE chat = ? AND key = ?", chat, key);
      prune();
      return { ok: true };
    },
    wipe() {
      sql.exec("DELETE FROM ledger_rounds");
    },
  };
}
