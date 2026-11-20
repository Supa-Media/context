/**
 * A chat's frozen prompt modules (Dev2, 2026-11-20, the cache rules: "until the next summary, the system prompt stays
 * byte-identical"; `agent/frozenModules.js`): per chat and step, the words its rarely-changing modules (About me, the
 * workspaces, the group's playbook…) had at the day's first turn, so every later turn that day sends the same bytes
 * above the history, and what changed since rides after it as a note.
 *
 * A cache, never a copy of record: one row per chat and step, replaced when the day turns, unreadable after
 * `FROZEN_FRESH_MS`; expired rows go on every write. Lives beside the chat's ledger, in the chat's own home, so a
 * group's sealed memory never leaves it. Wiped with the ledger (`wire.js` `wipe`).
 */
import { TexObjectRefused } from "./objects.js";

/** A day's words, read back for two days at most: a row older than that is from a summary long past. */
export const FROZEN_FRESH_MS = 48 * 60 * 60 * 1000;
/** One snapshot, as JSON: the words of a handful of modules. */
export const MAX_FROZEN_BYTES = 1_000_000;

const CHAT = /^[A-Za-z0-9_.:@+=-]{1,128}$/;
const STEP = /^[a-z][a-z0-9_-]{0,31}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const encoder = new TextEncoder();
const rows = (cursor) => (typeof cursor?.toArray === "function" ? cursor.toArray() : []);

function check(chat, step) {
  if (typeof chat !== "string" || !CHAT.test(chat)) throw new TexObjectRefused("not a chat this store keeps");
  if (typeof step !== "string" || !STEP.test(step)) throw new TexObjectRefused("not a step's name");
}

/** Only `{day, modules: {id: words}}` is kept or given back. */
function shaped(data) {
  if (data === null || typeof data !== "object" || typeof data.day !== "string" || !DAY.test(data.day)) return null;
  const modules = data.modules;
  if (modules === null || typeof modules !== "object" || Array.isArray(modules)) return null;
  const out = {};
  for (const [id, words] of Object.entries(modules)) if (typeof words === "string") out[id] = words;
  return { day: data.day, modules: out };
}

export function texFrozen(sql, { now = Date.now, guard = () => {} } = {}) {
  sql.exec("CREATE TABLE IF NOT EXISTS ledger_frozen (chat TEXT NOT NULL, step TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (chat, step))");
  const prune = () => sql.exec("DELETE FROM ledger_frozen WHERE at < ?", now() - FROZEN_FRESH_MS);
  return {
    /** Keep a chat's step's day of words, replacing the one before; stale rows of any chat go with it. */
    put(chat, step, data) {
      check(chat, step);
      const kept = shaped(data);
      if (kept === null) throw new TexObjectRefused("not frozen modules");
      const text = JSON.stringify(kept);
      if (encoder.encode(text).byteLength > MAX_FROZEN_BYTES) throw new TexObjectRefused(`frozen modules larger than ${MAX_FROZEN_BYTES} bytes`);
      guard();
      prune();
      sql.exec("INSERT OR REPLACE INTO ledger_frozen (chat, step, at, data) VALUES (?, ?, ?, ?)", chat, step, now(), text);
      return { ok: true };
    },
    /** A chat's step's words while fresh, or null. */
    get(chat, step) {
      check(chat, step);
      guard();
      const row = rows(sql.exec("SELECT data FROM ledger_frozen WHERE chat = ? AND step = ? AND at >= ?", chat, step, now() - FROZEN_FRESH_MS))[0];
      if (!row) return null;
      try {
        return shaped(JSON.parse(row.data));
      } catch {
        return null;
      }
    },
    wipe() {
      sql.exec("DELETE FROM ledger_frozen");
    },
  };
}
