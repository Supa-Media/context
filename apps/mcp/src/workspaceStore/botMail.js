/**
 * Mail for a bot that holds an area, noticed where the note is saved (`docs/decisions/app-and-console/area-bots.md`,
 * decided by Dev2 2026-11-25: "A, plus the workspace noticing mail itself").
 *
 * An area's mail is one note per sender under `<area>/mail/`. However a line lands there (the app's mail box, an AI
 * client's `write { action: "mail" }`, typed by hand), the note is saved in this object, so this is the one place
 * that sees all of them. After each saved note it checks:
 *
 *   - the note sits in an area's `mail/` folder;
 *   - its newest mail line is one it has not told about before (kept per note in `ws_bot_mail`, so an edit
 *     elsewhere in the note, or the same text saved again, tells nobody);
 *   - the area's `about.md` names an owner that is not a person (`@handle`): a bot;
 *   - the line is not the bot's own reply.
 *
 * Then it tells the control plane (`POST /gateway/bots/mail`), which calls the bot's webhook if one is saved and
 * does nothing otherwise. What it sends: the area, the note's path, the bot's name and who wrote. Never the message;
 * the bot reads that through its own connection, at its own clearance.
 */

import mail from "../../../../packages/shared/src/mail.cjs";
import areaBots from "../../../../packages/shared/src/areaBots.cjs";
import fileKinds from "../../../../packages/shared/src/fileKinds.cjs";

const { parseMail } = mail;
const { mailJoinName } = areaBots;
const { isNotePath } = fileKinds;

const NOTE_KEY = /^notes\/([A-Za-z0-9-]{1,128})\.md$/;
const SCHEMA = ["CREATE TABLE IF NOT EXISTS ws_bot_mail (note_id TEXT PRIMARY KEY, last TEXT NOT NULL)"];

const all = (cursor) => (typeof cursor?.toArray === "function" ? cursor.toArray() : []);

/** The area a mail note belongs to, or null: `areas/finance/mail/seyi.md` → `areas/finance`. */
export function areaOfMailNote(path) {
  if (typeof path !== "string" || !isNotePath(path)) return null;
  const match = /^(.+)\/mail\/[^/]+$/.exec(path);
  return match === null ? null : match[1];
}

/** The owner an area's `about.md` props name, or null. */
function ownerOf(propsJson) {
  try {
    const owner = JSON.parse(propsJson ?? "null")?.properties?.owner;
    return typeof owner === "string" && owner.trim() !== "" ? owner.trim() : null;
  } catch {
    return null;
  }
}

/**
 * `{noted(key, change), drain()}`. `noted` is the object's `onPut` and only remembers which notes changed, since it
 * runs inside the write; `drain` reads them once the write has landed and hands each new line to `tell`.
 *
 * @param {any} sql
 * @param {{rows: any, objects: any, facts: any, tell: (message: {bot: string, area: string, note: string, from: string}) => void, defer?: (work: () => void) => void}} deps
 */
export function botMailWatch(sql, { rows, objects, facts, tell, defer = (work) => queueMicrotask(work) }) {
  for (const statement of SCHEMA) sql.exec(statement);
  const pending = new Set();
  let scheduled = false;

  function check(noteId) {
    const row = rows.byNoteId(noteId);
    const area = areaOfMailNote(row?.path);
    if (area === null) return;
    const object = objects.get(`notes/${noteId}.md`);
    if (!object?.body) return;
    const text = new TextDecoder().decode(object.body);
    const lines = parseMail(text).events.filter((event) => event.kind === "mail");
    const newest = lines[lines.length - 1];
    if (newest === undefined) return;
    const mark = `${newest.at}|${newest.from}`;
    const seen = all(sql.exec("SELECT last FROM ws_bot_mail WHERE note_id = ?", noteId))[0]?.last ?? null;
    if (seen === mark) return;
    sql.exec("INSERT INTO ws_bot_mail (note_id, last) VALUES (?, ?) ON CONFLICT(note_id) DO UPDATE SET last = excluded.last", noteId, mark);
    const about = facts.props({ paths: [`${area}/about.md`] }, () => true).props?.[0];
    const owner = ownerOf(about?.props);
    if (owner === null || owner.startsWith("@") || about?.sealed) return;
    const bot = mailJoinName(owner);
    if (newest.from.toLowerCase() === bot) return;
    tell({ bot, area, note: row.path, from: newest.from });
  }

  function drain() {
    scheduled = false;
    const ids = [...pending];
    pending.clear();
    for (const noteId of ids) {
      try {
        check(noteId);
      } catch {
        // Telling a bot never fails a save.
      }
    }
  }

  return {
    noted(key, change) {
      const match = typeof key === "string" ? NOTE_KEY.exec(key) : null;
      if (match === null || change?.changed !== true) return;
      pending.add(match[1]);
      if (!scheduled) {
        scheduled = true;
        defer(drain);
      }
    },
    drain,
  };
}
