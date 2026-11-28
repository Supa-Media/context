/**
 * An ask closes when the work it names is finished (`docs/decisions/note-mail.md`, "Work done closes an ask"; Dev,
 * 2026-11-28, of the open-asks proposal: "Closes when Areas answers, or when the PR or task it names finishes").
 *
 * An `[ask]` that links a note (`[[projects/x/task.md]]`, `[label](projects/x/task.md)` or a Context note link) is kept
 * here against each bot it waits for. When one of those notes is saved with a finished `status` (done, shipped and
 * the like), the ask stops waiting in that bot's inbox (`botInbox.js`), so its check-in no longer says an answer is
 * owed. The line stays in the note as written: closing is the inbox's, never a rewrite of anybody's mail.
 *
 * What it keeps: bot names, note ids and keys, and the linked notes' paths. Never a message's words.
 */

import areaBots from "../../../../packages/shared/src/areaBots.cjs";
import fileKinds from "../../../../packages/shared/src/fileKinds.cjs";

const { mailJoinName } = areaBots;
const { isNotePath } = fileKinds;

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS ws_ask_until (bot TEXT NOT NULL, note_id TEXT NOT NULL, note TEXT NOT NULL, ref TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (bot, note_id, ref))",
  "CREATE INDEX IF NOT EXISTS ws_ask_until_ref ON ws_ask_until (ref)",
];
/** Links one ask is kept against at most. */
export const MAX_REFS = 5;
/** A kept link older than this goes, as an inbox item does (`botInbox.js` `BOT_INBOX_KEPT_MS`). */
export const ASK_UNTIL_KEPT_MS = 14 * 24 * 60 * 60 * 1000;
/** The `status` values that say a task is finished. */
export const FINISHED = new Set(["done", "finished", "complete", "completed", "shipped", "merged", "closed", "live"]);

const all = (cursor) => (typeof cursor?.toArray === "function" ? cursor.toArray() : []);

/** A linked note as a workspace path ending in `.md`, or null for a web link, a file or nothing. */
function notePath(raw) {
  let path = String(raw ?? "").trim().split("|")[0].split("#")[0].trim();
  const app = /^https:\/\/[^/]+\/note\/@[a-z0-9-]+\/(.+)$/i.exec(path);
  if (app !== null) path = decodeURIComponent(app[1]);
  if (path === "" || /^[a-z]+:/i.test(path) || path.includes("..")) return null;
  path = path.replace(/^\/+/, "");
  if (!/\.[a-z0-9]+$/i.test(path)) path = `${path}.md`;
  return isNotePath(path) && !/(^|\/)mail\//.test(path) ? path : null;
}

/** The notes an ask's words link, at most `MAX_REFS`. */
export function linkedNotes(text) {
  const words = String(text ?? "");
  const found = [];
  for (const match of words.matchAll(/\[\[([^\]\n]{1,300})\]\]|\]\(([^)\s]{1,300})\)|(https:\/\/[^\s)]+\/note\/@[a-z0-9-]+\/[^\s)]+)/gi)) {
    const path = notePath(match[1] ?? match[2] ?? match[3]);
    if (path !== null && !found.includes(path)) found.push(path);
    if (found.length >= MAX_REFS) break;
  }
  return found;
}

/** Whether a note's front matter (`facts.props` JSON) says it is finished. */
export function finished(propsJson) {
  try {
    const status = JSON.parse(propsJson ?? "null")?.properties?.status;
    return typeof status === "string" && FINISHED.has(status.trim().toLowerCase());
  } catch {
    return false;
  }
}

/**
 * `{keep, changed}` over the object's SQL.
 *
 * @param {any} sql
 * @param {{facts: any, inbox: () => any, now?: () => number}} deps
 */
export function askUntil(sql, { facts, inbox, now = Date.now }) {
  for (const statement of SCHEMA) sql.exec(statement);
  return {
    /** An ask in `note` waits for `bot`: keep it against each note its words link. */
    keep({ bot, noteId, note, text, at }) {
      if (typeof noteId !== "string" || noteId === "" || !Number.isFinite(at)) return;
      const name = mailJoinName(bot);
      for (const ref of linkedNotes(text)) {
        sql.exec(
          "INSERT INTO ws_ask_until (bot, note_id, note, ref, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(bot, note_id, ref) DO UPDATE SET at = MAX(at, excluded.at), note = excluded.note",
          name,
          noteId,
          note,
          ref,
          at,
        );
      }
      sql.exec("DELETE FROM ws_ask_until WHERE at < ?", now() - ASK_UNTIL_KEPT_MS);
    },
    /** `path` was saved: if an ask waits on it and it is finished now, that ask stops waiting. */
    changed(path) {
      if (typeof path !== "string" || path === "") return;
      const waiting = all(sql.exec("SELECT bot, note_id, note, at FROM ws_ask_until WHERE ref = ?", path));
      if (waiting.length === 0) return;
      const props = facts.props({ paths: [path] }, () => true).props?.[0] ?? null;
      if (props === null || props.sealed || !finished(props.props)) return;
      for (const row of waiting) inbox()?.closeAsk?.(row.bot, { noteId: row.note_id, note: row.note }, Number(row.at));
      sql.exec("DELETE FROM ws_ask_until WHERE ref = ?", path);
    },
  };
}
