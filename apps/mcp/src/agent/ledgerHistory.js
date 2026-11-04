/**
 * WHAT A TEXTED TURN READS OF ITS CHAT FROM THE LEDGER (decided by the owner,
 * 2026-11-02: one record per chat, every view rebuilt from it;
 * `docs/decisions/texting-assistant/chat-ledger.md`).
 *
 * A turn's last day of the chat comes from the ledger (`dayFromLedger`), with
 * the Worker's outbox on top; before the ledger, that day was all a turn saw. The ledger keeps the
 * whole chat, so a turn is shown everything before that day from it too, the
 * newest first until the log's character budget is spent, and, beside each of
 * Tex's answers, the tools it used (names only: the prompt reads the ledger
 * slim, never a tool's arguments or result).
 *
 * Trust fails closed, as `loggedTurn.js` does for the day the Worker holds.
 * The ledger's `text` entries came from the Worker, so they never prove an
 * answer clean; the gateway's own `reply` entry does (`clean`, written when
 * the turn answered, `texEntryPoint.js`). One of Tex's earlier answers whose turn has
 * no clean reply is shown as held back, never its words, so an answer that read
 * from outside the workspace never reaches a later turn's prompt and never
 * taints every turn after it. A check-in Tex sent by itself (`note`) is shown
 * by the same rule from its own `tainted` mark. A group's turn is untrusted
 * whatever it reads (`texEntryPoint.js`), so a group is shown every answer.
 */

import { checkEvent, EVENT_ID, EVENT_KINDS, READ_CHARS, READ_LIMIT } from "./log.js";
import { DESK_LEDGER } from "../texStore/desk.js";
import { sentOnItsOwn } from "./sentOnItsOwn.js";

/** The most entries one read of the ledger asks for; a turn reads at most `MAX_PAGES` of them. */
const PAGE = DESK_LEDGER.options.limit;
const MAX_PAGES = 3;
const BY_ITSELF = /^\(Not a text from them\./;
/** What one of Tex's earlier answers that is not proven clean is shown as. */
export const HELD_BACK = "(an earlier answer, not shown: that turn read from outside this workspace or was never confirmed)";

const asEvent = (entry, chat) => {
  const { v: _v, seq: _seq, eid, event, kind: _kind, id: _id, cut: _cut, ...rest } = entry;
  return { ...rest, id: eid, chat, kind: event };
};

/**
 * The chat's newest ledger entries a turn may show, newest first: at most
 * `MAX_PAGES` reads, slim (names only for a tool). Started beside the read of
 * the day the Worker holds, so it adds no wait of its own; `first` is a page
 * already read (the desk's), so a short chat costs no call at all. Empty when there
 * is no ledger or it cannot be read.
 */
export async function readLedger(ledger, chat, { chars = READ_CHARS, first = null } = {}) {
  if (ledger === null || typeof ledger?.read !== "function" || typeof chat !== "string") return [];
  const entries = [];
  let cursor = Number.MAX_SAFE_INTEGER;
  let words = 0;
  try {
    for (let page = 0; page < MAX_PAGES && words < chars; page += 1) {
      // The first page may already be read, with the record, in the desk's one call (`texStore/desk.js`).
      const read = page === 0 && first !== null ? first : await ledger.read(chat, { before: cursor, kinds: DESK_LEDGER.options.kinds, limit: PAGE, slim: true });
      for (const entry of read?.entries ?? []) {
        entries.push(entry);
        if (entry.kind === "text" || entry.kind === "note") words += String(entry.text ?? "").length;
      }
      if (!Number.isSafeInteger(read?.before)) break;
      cursor = read.before;
    }
  } catch (error) {
    console.log(JSON.stringify({ event: "ledger_history_unread", reason: String(error?.name ?? "error").slice(0, 40) }));
    return [];
  }
  return entries;
}

/**
 * The chat's newest texts as the bucket's log (`log.js` `readEvents`) would
 * give them, from the ledger entries a turn already read (`readLedger`, newest
 * first): the Worker's own events only, by their `eid`, never what the
 * backfill rebuilt from the history record, each checked again as the log
 * checks an event (its day window aside), at most `READ_LIMIT` of them within
 * `READ_CHARS`, oldest first. Null unless every event the turn covers is
 * among them, so a ledger that missed a post leaves the turn to the log.
 */
export function dayFromLedger(entries, chat, covers) {
  if (!Array.isArray(entries) || !Array.isArray(covers)) return null;
  const events = [];
  const seen = new Set();
  let room = READ_CHARS;
  for (const entry of entries) {
    if (events.length >= READ_LIMIT) break;
    if (entry?.kind !== "text" || entry.backfill === "record" || typeof entry.eid !== "string" || seen.has(entry.eid) || !Number.isSafeInteger(entry.at)) continue;
    let event;
    try {
      event = checkEvent(asEvent(entry, chat), { chat, now: entry.at });
    } catch {
      continue; // Not one the log would have kept.
    }
    room -= JSON.stringify(event).length;
    if (room < 0) break;
    seen.add(event.id);
    events.push(event);
  }
  if (!covers.every((id) => seen.has(id))) return null;
  return events.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * What a turn is shown from its ledger's entries (`readLedger`, newest
 * first): `{events, tools}`. `events` are the chat's texts older than
 * `before` (the oldest the turn already holds), oldest first, within `chars`
 * characters, as `log.js` events, with Tex's check-ins among them and Tex's
 * answers not proven clean held back; `tools` maps a turn to the tools it used.
 * `untrusted` is a turn that is untrusted whatever it reads (a group's,
 * `texEntryPoint.js`): it holds nothing back, since nothing shown can taint it more.
 */
export function earlierFromLedger(entries, chat, { before = Number.MAX_SAFE_INTEGER, chars = READ_CHARS, known = new Set(), untrusted = false } = {}) {
  const tools = new Map();
  const clean = new Set();
  const events = [];
  const seen = new Set(known);
  let room = chars;
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry?.kind === "tool" && typeof entry.turn === "string" && entry.ok === true && typeof entry.name === "string") {
      const names = tools.get(entry.turn) ?? [];
      if (!names.includes(entry.name)) names.unshift(entry.name);
      tools.set(entry.turn, names);
    } else if (entry?.kind === "reply" && typeof entry.turn === "string" && entry.clean === true) clean.add(entry.turn);
    if (room <= 0 || !(entry?.at < before)) continue;
    const shown = entry.kind === "text" ? asEvent(entry, chat) : entry.kind === "note" ? noteEvent(entry, chat) : null;
    if (shown === null || (!shown.byItself && !EVENT_ID.test(shown.id ?? "")) || !EVENT_KINDS.has(shown.kind) || seen.has(shown.id)) continue;
    room -= String(shown.text ?? "").length + 40;
    if (room < 0) break;
    seen.add(shown.id);
    events.push(shown);
  }
  // Tex's own answers are shown only when the gateway recorded their turn clean; a check-in by its own mark.
  const held = events.map((event) => {
    if (!event.byItself && event.from?.kind !== "tex") return event;
    if (untrusted) return event;
    const proven = event.byItself ? event.tainted !== true : clean.has(event.turn);
    return proven ? event : { ...event, text: HELD_BACK };
  });
  return { events: held.sort((a, b) => a.at - b.at), tools };
}

/** A check-in or other text Tex sent by itself, as an event; anything else kept as a note is not shown. */
function noteEvent(entry, chat) {
  if (typeof entry.about !== "string" || !BY_ITSELF.test(entry.about) || typeof entry.text !== "string" || entry.text.trim() === "") return null;
  // Why it went out stays with it (`sentOnItsOwn.js`): a ping another agent asked for is that agent's, passed on.
  return { id: `note-${entry.id}`, at: entry.at, chat, from: { kind: "tex" }, kind: "text", text: entry.text.trim(), delivered: true, byItself: true, ...sentOnItsOwn(entry.about), ...(entry.tainted === true ? { tainted: true } : {}) };
}
