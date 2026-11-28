/**
 * Who else hears a new line in an area's mail: the seat on the other end of the conversation
 * (`docs/decisions/note-mail.md`, "A reply goes to the seat that asked"; Dev, 2026-11-28).
 *
 * Area mail is addressed to a position, never a bot: "mailing the President, not Barack", so a bot can be swapped out
 * of an area and its successor carries on. Until 2026-11-28 only the holder of the folder a note sits in was told of
 * a new line, so when Muse (holding Operations) answered Grok Bot (holding Areas) in `areas/operations/mail/grok-bot.md`
 * nobody was told: Muse is that folder's holder, and a holder's own line tells nobody. Muse's audit counted twelve
 * asks that looked unanswered for that reason.
 *
 * Now the object keeps, per mail note, the seat each sender wrote from (`ws_mail_seats`): the note's own area when the
 * sender holds it, else the one area it holds anywhere, else none. A new line is told to every other sender in the
 * note (or only the one it names), each resolved to whoever holds that sender's seat *now*, so a reply reaches the
 * asking seat's successor too. A sender with no seat is told by its own name when it is a bot with a card; a person, or
 * an agent working for one, is left to its own mailbox for now.
 *
 * What it keeps: note ids, sender names and area paths. Never a message's words.
 */

import areaRoutines from "../../../../packages/shared/src/areaRoutines.cjs";
import areaBots from "../../../../packages/shared/src/areaBots.cjs";

const { botCardPaths } = areaRoutines;
const { mailJoinName } = areaBots;

const SCHEMA = ["CREATE TABLE IF NOT EXISTS ws_mail_seats (note_id TEXT NOT NULL, sender TEXT NOT NULL, seat TEXT NOT NULL, PRIMARY KEY (note_id, sender))"];
/** Areas read when finding which a bot holds; a workspace with more is read up to here. */
const MAX_AREAS_READ = 500;
/** Other senders one line reaches at most: a mail note is a conversation, not a list. */
export const MAX_ROUTED = 10;

const all = (cursor) => (typeof cursor?.toArray === "function" ? cursor.toArray() : []);
const isPerson = (name) => typeof name === "string" && name.startsWith("@");

/**
 * `{seatOf, record, recipients}` over the object's SQL.
 *
 * @param {any} sql
 * @param {{rows: any, facts: any, areasRoot: () => string | null, holderOf: (propsJson: string | undefined) => string | null}} deps
 */
export function mailRoute(sql, { rows, facts, areasRoot, holderOf }) {
  for (const statement of SCHEMA) sql.exec(statement);
  const propsAt = (path) => facts.props({ paths: [path] }, () => true).props?.[0] ?? null;

  /** The bot holding `area` now, as a mail name, or null (a person with no delegate, a sealed or missing area). */
  function holderNow(area) {
    const about = propsAt(`${area}/about.md`);
    if (!about || about.sealed) return null;
    const bot = holderOf(about.props);
    return bot === null ? null : mailJoinName(bot);
  }

  /** Every area `bot` holds, read from the areas' about.md notes. */
  function areasHeldBy(bot) {
    const root = areasRoot();
    if (root === null || typeof rows?.filesUnder !== "function") return [];
    const abouts = rows
      .filesUnder(`${root}/`)
      .map((row) => row.path)
      .filter((path) => typeof path === "string" && (path === `${root}/about.md` || path.endsWith("/about.md")) && !/\/mail\//.test(path))
      .slice(0, MAX_AREAS_READ);
    if (abouts.length === 0) return [];
    const found = facts.props({ paths: abouts }, () => true).props ?? [];
    // Only an area's about.md names an owner; a bot's card kept under the Areas folder (the older place) is not a seat.
    const owned = (json) => {
      try {
        const owner = JSON.parse(json ?? "null")?.properties?.owner;
        return typeof owner === "string" && owner.trim() !== "";
      } catch {
        return false;
      }
    };
    return found
      .filter((each) => !each.sealed && owned(each.props) && holderOf(each.props) !== null && mailJoinName(holderOf(each.props)) === bot)
      .map((each) => each.path.slice(0, -"/about.md".length));
  }

  /** Whether `name` is a bot with a card here. */
  function isBot(name) {
    const root = areasRoot();
    if (root === null) return false;
    return botCardPaths(root, name).some((path) => propsAt(path)?.props);
  }

  const seatOn = (noteId, sender) => all(sql.exec("SELECT seat FROM ws_mail_seats WHERE note_id = ? AND sender = ?", noteId, sender))[0]?.seat ?? null;

  return {
    /** The seat `sender` writes from in `area`'s mail: that area when it holds it, else its one area, else null. */
    seatOf(sender, area, areaHolder) {
      if (isPerson(sender) || sender === "tex") return null;
      if (area !== null && sender === areaHolder) return area;
      const held = areasHeldBy(sender);
      return held.length === 1 ? held[0] : null;
    },
    /** Keeps the seat a sender wrote this note from; the first one kept stays (a bot later swapped out keeps it). */
    record(noteId, sender, seat) {
      if (typeof noteId !== "string" || noteId === "" || typeof seat !== "string" || seat === "") return;
      sql.exec("INSERT INTO ws_mail_seats (note_id, sender, seat) VALUES (?, ?, ?) ON CONFLICT(note_id, sender) DO NOTHING", noteId, sender, seat);
    },
    /**
     * Who hears `line` besides the folder's holder: every other sender in the note (only the one it names, when it
     * names one), each as whoever holds its seat now, or as itself when it is a bot with no seat kept. Mail names,
     * never the writer or the folder's holder (told already). Persons and seatless agents are left out.
     */
    recipients(noteId, events, line, areaHolder) {
      const writer = line.from;
      const others = [...new Set(events.filter((event) => event.kind === "mail" && event.from !== writer).map((event) => event.from))];
      const named = line.to && line.to !== "everyone" ? others.filter((name) => name === line.to) : others;
      const out = new Set();
      for (const sender of named) {
        if (isPerson(sender) || sender === "tex") continue;
        const seat = seatOn(noteId, sender);
        const bot = seat !== null ? holderNow(seat) : isBot(sender) ? sender : null;
        if (bot === null || bot === writer || bot === areaHolder) continue;
        out.add(bot);
        if (out.size >= MAX_ROUTED) break;
      }
      return [...out];
    },
  };
}
