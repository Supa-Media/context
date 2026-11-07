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
 * Every earlier answer is shown as it was said, one to one as in a group (the
 * owner, 2026-11-05): an answer whose turn read from outside the workspace
 * once showed as held back, and since every later turn shown it was marked
 * the same, Tex lost the thread of its own chat
 * (`docs/decisions/texting-assistant/turn-trust.md`).
 */

import { checkEvent, EVENT_ID, EVENT_KINDS, READ_CHARS, READ_LIMIT } from "./log.js";
import { DESK_LEDGER } from "../texStore/desk.js";
import { sentOnItsOwn } from "./sentOnItsOwn.js";

/** The most entries one read of the ledger asks for; a turn reads at most `MAX_PAGES` of them. */
const PAGE = DESK_LEDGER.options.limit;
const MAX_PAGES = 3;
/** The most day summaries a turn reads past its texts, and the characters they may take. */
export const MAX_SUMMARIES = 60;
export const SUMMARY_CHARS = 12_000;
const BY_ITSELF = /^\(Not a text from them\./;

export const asEvent = (entry, chat) => {
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
  let more = false;
  try {
    for (let page = 0; page < MAX_PAGES && words < chars; page += 1) {
      // The first page may already be read, with the record, in the desk's one call (`texStore/desk.js`).
      const read = page === 0 && first !== null ? first : await ledger.read(chat, { before: cursor, kinds: DESK_LEDGER.options.kinds, limit: PAGE, slim: true });
      for (const entry of read?.entries ?? []) {
        entries.push(entry);
        if (entry.kind === "text" || entry.kind === "note") words += String(entry.text ?? "").length;
      }
      more = Number.isSafeInteger(read?.before);
      if (!more) break;
      cursor = read.before;
    }
    // A chat longer than the turn reads: the summaries of the days before it, so the old stays in context (`daySummaries.js`).
    if (more) entries.push(...((await ledger.read(chat, { before: cursor, kinds: ["day"], limit: MAX_SUMMARIES, slim: true }))?.entries ?? []));
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
 * characters, as `log.js` events, with Tex's check-ins among them; `tools`
 * maps a turn to the tools it used; faded, `summaries` are the days before
 * every text shown, as summed up the night after (`daySummaries.js`).
 */
export function earlierFromLedger(entries, chat, { before = Number.MAX_SAFE_INTEGER, chars = READ_CHARS, known = new Set(), fade = false, fadeFrom = before } = {}) {
  const tools = new Map();
  const events = [];
  const seen = new Set(known);
  let room = chars;
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry?.kind === "tool" && typeof entry.turn === "string" && entry.ok === true && typeof entry.name === "string") {
      const names = tools.get(entry.turn) ?? [];
      if (!names.includes(entry.name)) names.unshift(entry.name);
      tools.set(entry.turn, names);
    }
    if (room <= 0 || !(entry?.at < before)) continue;
    const found = entry.kind === "text" ? asEvent(entry, chat) : entry.kind === "note" ? noteEvent(entry, chat) : null;
    if (found === null || (!found.byItself && !EVENT_ID.test(found.id ?? "")) || !EVENT_KINDS.has(found.kind) || seen.has(found.id)) continue;
    const shown = fade ? faded(found, fadeFrom) : found;
    room -= String(shown.text ?? "").length + 40;
    if (room < 0) break;
    seen.add(shown.id);
    events.push(shown);
  }
  // Faded, the oldest day is shown whole or not at all, so what is shown of the past only moves once a day and the
  // cached history ahead of it stays the same from one text to the next (the context review, 2026-11-06).
  const kept = fade && room <= 0 && events.length > 0 ? wholeDays(events) : events;
  kept.sort((a, b) => a.at - b.at);
  // Faded, the days older than every text shown are given as the summaries written the night after (`daySummaries.js`).
  const summaries = fade ? daysBefore(entries, kept.length > 0 ? kept[0].at : before) : [];
  return { events: kept, tools, summaries };
}

/**
 * The day summaries in `entries` of days that ended before `oldest`, one per day, newest kept within
 * `SUMMARY_CHARS`, oldest first: `{day, text}`.
 */
function daysBefore(entries, oldest) {
  const found = [];
  const seen = new Set();
  let room = SUMMARY_CHARS;
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry?.kind !== "day" || typeof entry.day !== "string" || typeof entry.text !== "string" || entry.text.trim() === "" || !(entry.at < oldest) || seen.has(entry.day)) continue;
    const text = entry.text.trim();
    room -= text.length + 20;
    if (room < 0) break;
    seen.add(entry.day);
    found.push({ day: entry.day, text });
  }
  return found.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

/** The summaries as the lines a turn's history opens with, or "" when there are none. */
export function summaryLines(summaries) {
  if (!Array.isArray(summaries) || summaries.length === 0) return "";
  return ["Earlier days, older than the texts below, as you summed each up the night after:", ...summaries.map((summary) => `- ${summary.day}: ${summary.text.replace(/\s+/g, " ")}`)].join("\n");
}

/** A day, as the number of whole days since the epoch, in UTC. */
const dayOf = (at) => Math.floor(at / 86_400_000);

/** How many days before the turn's last day each age begins to fade, and how much of a text each keeps. */
export const FADE = Object.freeze([
  { from: 2, tex: 600, them: Infinity }, // the two days before the last: their words whole, Tex's answers clipped
  { from: 8, tex: 240, them: 800 }, // the week before that
  { from: 31, tex: 120, them: 400 }, // older than a month
]);

const LINK = /https?:\/\/[^\s<>()"']+/g;

/**
 * An earlier text faded by its age (Dev2, 2026-11-06: "weight recent heavier, keep old in context"): the nearer
 * days whole, older ones clipped, Tex's own answers most. A clipped text keeps every link it held, so a page or
 * draft Tex sent stays findable however old.
 */
export function faded(event, before, fade = FADE) {
  const text = String(event.text ?? "");
  if (!Number.isFinite(before) || before === Number.MAX_SAFE_INTEGER) return event;
  const age = dayOf(before) - dayOf(event.at);
  const tier = [...fade].reverse().find((step) => age >= step.from);
  if (tier === undefined) return event;
  const max = event.from?.kind === "tex" ? tier.tex : tier.them;
  if (text.length <= max) return event;
  const links = [...new Set(text.slice(max).match(LINK) ?? [])].filter((link) => !text.slice(0, max).includes(link));
  return { ...event, text: `${text.slice(0, max).trimEnd()}… [cut${links.length > 0 ? `; links: ${links.join(" ")}` : ""}]` };
}

/** `events` (newest first) without the oldest day, which ran out of room part-way. */
function wholeDays(events) {
  const oldest = dayOf(events.at(-1).at);
  const whole = events.filter((event) => dayOf(event.at) !== oldest);
  return whole.length > 0 ? whole : events;
}

/** A check-in or other text Tex sent by itself, as an event; anything else kept as a note is not shown. */
function noteEvent(entry, chat) {
  if (typeof entry.about !== "string" || !BY_ITSELF.test(entry.about) || typeof entry.text !== "string" || entry.text.trim() === "") return null;
  // Why it went out stays with it (`sentOnItsOwn.js`): a ping another agent asked for is that agent's, passed on.
  return { id: `note-${entry.id}`, at: entry.at, chat, from: { kind: "tex" }, kind: "text", text: entry.text.trim(), delivered: true, byItself: true, ...sentOnItsOwn(entry.about) };
}
