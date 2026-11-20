/**
 * A chat's last cached prompt prefix, for warming the model's cache before the person's next text (Dev2, 2026-11-20,
 * the cache rules: "the cache is warmed when the chat opens or the person starts typing"; `agent/warmPrefix.js`, node
 * `warm`). One row per chat: the request the front door's first round sent, cut at the history's end, the day it was
 * sent for and when it was last sent or warmed.
 *
 * A cache, never a copy of record: it holds the chat's own history as the model was shown it, so it lives in the
 * chat's own home beside its ledger (a group's sealed memory never leaves it), is unreadable after `WARM_FRESH_MS`
 * (past that the model's own cache is gone too), and is wiped with the ledger (`wire.js` `wipe`). Never listed,
 * searched or exported.
 */
import { TexObjectRefused } from "./objects.js";

/** The model's cache keeps a prefix an hour after its last use; a row past that warms nothing it could still read. */
export const WARM_FRESH_MS = 2 * 60 * 60 * 1000;
/** One prefix, as JSON; a larger one (a chat with many pictures this week) is not kept, and its chat is not warmed. */
export const MAX_WARM_BYTES = 1_900_000;

const CHAT = /^[A-Za-z0-9_.:@+=-]{1,128}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const encoder = new TextEncoder();
const rows = (cursor) => (typeof cursor?.toArray === "function" ? cursor.toArray() : []);

function check(chat) {
  if (typeof chat !== "string" || !CHAT.test(chat)) throw new TexObjectRefused("not a chat this store keeps");
}

export function texWarm(sql, { now = Date.now, guard = () => {} } = {}) {
  sql.exec("CREATE TABLE IF NOT EXISTS ledger_warm (chat TEXT NOT NULL PRIMARY KEY, at INTEGER NOT NULL, used INTEGER NOT NULL, day TEXT NOT NULL, data TEXT NOT NULL)");
  const prune = () => sql.exec("DELETE FROM ledger_warm WHERE used < ?", now() - WARM_FRESH_MS);
  return {
    /** Keep a chat's newest prefix, `{day, zone, body}`, replacing the one before; stale rows of any chat go with it. */
    put(chat, data) {
      check(chat);
      if (data === null || typeof data !== "object" || typeof data.day !== "string" || !DAY.test(data.day) || data.body === null || typeof data.body !== "object" || !Array.isArray(data.body.messages)) throw new TexObjectRefused("not a prefix");
      const zone = typeof data.zone === "string" && /^[A-Za-z0-9_+\-/]{1,64}$/.test(data.zone) ? data.zone : "UTC";
      const text = JSON.stringify({ zone, body: data.body });
      if (encoder.encode(text).byteLength > MAX_WARM_BYTES) throw new TexObjectRefused(`prefix larger than ${MAX_WARM_BYTES} bytes`);
      guard();
      prune();
      const at = now();
      sql.exec("INSERT OR REPLACE INTO ledger_warm (chat, at, used, day, data) VALUES (?, ?, ?, ?, ?)", chat, at, at, data.day, text);
      return { ok: true };
    },
    /** A chat's prefix while fresh, `{at, used, day, zone, body}`, or null. */
    get(chat) {
      check(chat);
      guard();
      const row = rows(sql.exec("SELECT at, used, day, data FROM ledger_warm WHERE chat = ? AND used >= ?", chat, now() - WARM_FRESH_MS))[0];
      if (!row) return null;
      try {
        const { zone, body } = JSON.parse(row.data);
        return { at: Number(row.at), used: Number(row.used), day: String(row.day), zone, body };
      } catch {
        return null;
      }
    },
    /** The prefix was just sent again to warm the cache: its `used` moves to now. */
    used(chat) {
      check(chat);
      guard();
      sql.exec("UPDATE ledger_warm SET used = ? WHERE chat = ?", now(), chat);
      return { ok: true };
    },
    wipe() {
      sql.exec("DELETE FROM ledger_warm");
    },
  };
}
