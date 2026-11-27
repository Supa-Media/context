/**
 * What is waiting for each bot, and when each last checked (`docs/decisions/app-and-console/area-routines.md`, decided
 * by the owner, 2026-11-27: "design it in a lightweight way where the MCP can just return whether it has anything new
 * in its inbox or not, that way the loops don't burn a lot of tokens ... as long as the agent is pinging every 5
 * minutes it can be in good standing").
 *
 * Every routine sent to a bot and every mail line told to it (`areaRoutines.js` `send`, `botMail.js`) is kept here as
 * one row per bot and note, whether or not a webhook took it, so a bot with no webhook finds it with one cheap call
 * (`orient { for, check: true }`). The bot's own line in that note clears it; a routine is also cleared where it is
 * marked answered. Rows older than two weeks go, and a bot keeps at most `MAX_PER_BOT`.
 *
 * What it keeps: note ids, paths, areas, who wrote and when. Never a message's words.
 */

import areaBots from "../../../../packages/shared/src/areaBots.cjs";

const { mailJoinName } = areaBots;

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS ws_bot_inbox (bot TEXT NOT NULL, note_key TEXT NOT NULL, note_id TEXT, note TEXT NOT NULL, kind TEXT NOT NULL, area TEXT, sender TEXT, at INTEGER NOT NULL, PRIMARY KEY (bot, note_key))",
  "CREATE TABLE IF NOT EXISTS ws_bot_checks (bot TEXT PRIMARY KEY, at INTEGER NOT NULL)",
];
/** A pending item older than this is dropped: a bot that never checked in two weeks is not working that queue. */
export const BOT_INBOX_KEPT_MS = 14 * 24 * 60 * 60 * 1000;
/** Items one bot keeps; the oldest go first. */
export const MAX_PER_BOT = 50;
/** Bots whose last check-in is kept; anyone who may read can check in under a name, so the oldest go first. */
export const MAX_CHECKS = 200;
export const BOT_INBOX_KINDS = Object.freeze(["mail", "routine"]);

const all = (cursor) => (typeof cursor?.toArray === "function" ? cursor.toArray() : []);
const keyOf = (noteId, note) => (typeof noteId === "string" && noteId !== "" ? noteId : `path:${note}`);

/**
 * `{add, clear, clearRoutines, check, checks, counts}` over the object's SQL. `rows.byNoteId` gives a note's path now,
 * so an item follows its note through a move, and one whose note is gone is dropped.
 *
 * @param {any} sql
 * @param {{rows?: any, now?: () => number}} deps
 */
export function botInbox(sql, { rows = null, now = Date.now } = {}) {
  for (const statement of SCHEMA) sql.exec(statement);

  function prune(bot, at) {
    sql.exec("DELETE FROM ws_bot_inbox WHERE at < ?", at - BOT_INBOX_KEPT_MS);
    sql.exec("DELETE FROM ws_bot_inbox WHERE bot = ? AND rowid NOT IN (SELECT rowid FROM ws_bot_inbox WHERE bot = ? ORDER BY at DESC LIMIT ?)", bot, bot, MAX_PER_BOT);
  }

  /** The item's path now, or null when its note is gone. */
  function pathOf(row) {
    if (rows === null || typeof rows.byNoteId !== "function" || typeof row.note_id !== "string" || row.note_id === "") return row.note;
    return rows.byNoteId(row.note_id)?.path ?? null;
  }

  return {
    /** One item for `bot`: the note's row is kept once, with its newest time and sender. */
    add({ bot, noteId = null, note, kind, area = null, from = null, at = now() }) {
      if (typeof bot !== "string" || bot === "" || typeof note !== "string" || note === "" || !BOT_INBOX_KINDS.includes(kind)) return;
      const name = mailJoinName(bot);
      const when = Number.isFinite(at) ? Math.min(at, now()) : now();
      sql.exec(
        "INSERT INTO ws_bot_inbox (bot, note_key, note_id, note, kind, area, sender, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(bot, note_key) DO UPDATE SET note = excluded.note, kind = excluded.kind, area = excluded.area, sender = excluded.sender, at = MAX(at, excluded.at)",
        name,
        keyOf(noteId, note),
        noteId,
        note,
        kind,
        area,
        from,
        when,
      );
      prune(name, now());
    },
    /** `bot` wrote in this note at `at`: what was waiting there from before then is answered. */
    clear(bot, { noteId = null, note = "" }, at) {
      if (!Number.isFinite(at)) return;
      sql.exec("DELETE FROM ws_bot_inbox WHERE bot = ? AND note_key = ? AND at <= ?", mailJoinName(bot), keyOf(noteId, note), at);
    },
    /** `bot` answered its routines in `area` at `at` (its own mail note there, `areaRoutines.js` `recordMail`). */
    clearRoutines(bot, area, at) {
      if (!Number.isFinite(at)) return;
      sql.exec("DELETE FROM ws_bot_inbox WHERE bot = ? AND area = ? AND kind = 'routine' AND at <= ?", mailJoinName(bot), area, at);
    },
    /**
     * `bot` checked in: its time is kept, and it is handed what waits for it in notes `sees` lets this reader read,
     * newest first. `[{kind, note, area, from, at}]`; paths and names only.
     */
    check(bot, sees = () => true, at = now()) {
      const name = mailJoinName(bot);
      if (name === "") return [];
      sql.exec("INSERT INTO ws_bot_checks (bot, at) VALUES (?, ?) ON CONFLICT(bot) DO UPDATE SET at = excluded.at", name, at);
      sql.exec("DELETE FROM ws_bot_checks WHERE bot NOT IN (SELECT bot FROM ws_bot_checks ORDER BY at DESC LIMIT ?)", MAX_CHECKS);
      prune(name, at);
      const items = [];
      for (const row of all(sql.exec("SELECT * FROM ws_bot_inbox WHERE bot = ? ORDER BY at DESC", name))) {
        const path = pathOf(row);
        if (path === null) {
          sql.exec("DELETE FROM ws_bot_inbox WHERE bot = ? AND note_key = ?", name, row.note_key);
          continue;
        }
        if (!sees(path)) continue;
        items.push({ kind: row.kind, note: path, area: row.area ?? null, from: row.sender ?? null, at: Number(row.at) });
      }
      return items;
    },
    /**
     * `bot` wrote its own line at `at`: it is reached, so it counts as a check-in (Dev, 2026-11-27: Muse answered mail
     * from its own login and its card still said "Not checking yet"). Only its bound login writes as it (`mail.js`), and
     * a later check-in is never moved back.
     */
    seen(bot, at) {
      const name = mailJoinName(bot);
      if (name === "" || !Number.isFinite(at)) return;
      const when = Math.min(at, now());
      sql.exec("INSERT INTO ws_bot_checks (bot, at) VALUES (?, ?) ON CONFLICT(bot) DO UPDATE SET at = MAX(at, excluded.at)", name, when);
    },
    /** When `bot` last checked in, or null for never. */
    lastCheck(bot) {
      const row = all(sql.exec("SELECT at FROM ws_bot_checks WHERE bot = ?", mailJoinName(bot)))[0];
      return row === undefined ? null : Number(row.at);
    },
    /** Every bot's last check-in: `[{bot, at}]`, by mail name. */
    checks() {
      return all(sql.exec("SELECT bot, at FROM ws_bot_checks ORDER BY bot")).map((row) => ({ bot: row.bot, at: Number(row.at) }));
    },
    /** How many items wait for each bot in notes `sees` lets this reader read: `[{bot, count}]`. */
    counts(sees = () => true) {
      const counted = new Map();
      for (const row of all(sql.exec("SELECT * FROM ws_bot_inbox ORDER BY bot"))) {
        const path = pathOf(row);
        if (path === null || !sees(path)) continue;
        counted.set(row.bot, (counted.get(row.bot) ?? 0) + 1);
      }
      return [...counted].map(([bot, count]) => ({ bot, count }));
    },
  };
}
