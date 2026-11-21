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
import { noteAbout, sentOnItsOwn } from "./sentOnItsOwn.js";
import { isLinkedText, isUnsentNote, isUnsentText, keptNotTexted, linkedSends, notesByTurn } from "./sentOnItsOwn.js";
import { shownFacts } from "./toldFacts.js";
import { withGuestNames } from "./groupGuestNames.js";
import { ONE_TO_ONE_CHAT } from "./ledger.js";

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
      const read = page === 0 && first !== null ? first : await ledger.read(chat, { before: cursor, kinds: DESK_LEDGER.options.kinds, limit: PAGE, slim: true, keepArgs: DESK_LEDGER.options.keepArgs });
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
  return withGuestNames(entries, ledger, chat);
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
  // A text Tex sent on its own that was never said is not shown (`sentOnItsOwn.js`); one that was carries why it went out, from its note.
  const links = linkedSends(entries);
  const notes = notesByTurn(entries);
  for (const entry of entries) {
    if (events.length >= READ_LIMIT) break;
    if (entry?.kind !== "text" || entry.backfill === "record" || typeof entry.eid !== "string" || seen.has(entry.eid) || !Number.isSafeInteger(entry.at)) continue;
    if (isUnsentText(entry, links)) continue;
    let event;
    try {
      // A guest's kept name (`withGuestNames`) is the reader's, never the log's: checked without it, kept on after.
      const { guestName, ...from } = entry.from ?? {};
      event = checkEvent(asEvent(entry.from ? { ...entry, from } : entry, chat), { chat, now: entry.at });
      if (typeof guestName === "string") event = { ...event, from: { ...event.from, guestName } };
    } catch {
      continue; // Not one the log would have kept.
    }
    if (isLinkedText(entry, links)) event = withNoteReason(event, notes.get(entry.turn));
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
 * first): `{events, tools, facts}`. `events` are the chat's texts older than
 * `before` (the oldest the turn already holds), oldest first, within `chars`
 * characters, as `log.js` events, with Tex's check-ins among them; `tools`
 * maps a turn to the tools it used, `facts` to what its reply read for what it said; faded, `summaries` are the days before
 * every text shown, as summed up the night after (`daySummaries.js`).
 */
/**
 * Room steps for the earlier days (Dev2, 2026-11-14: "lets just look into the cache misses"). The days before today get
 * what today's texts leave of `READ_CHARS`, and the oldest day is shown whole or not at all (`wholeDays`). Measured that
 * day, a 1:1 chat's transcript went 496, 522, 522, 496, 522 lines on texts minutes apart: today's size moved by a text
 * or two (and by which texts the stretch carried as messages instead), the oldest day dropped out or came back, and every
 * line after the top changed, so each such text rewrote 30,000 to 60,000 tokens to the cache. Today's size is now
 * counted in steps, so the oldest day moves only when today has grown by a step, a few times a day.
 */
export const ROOM_STEP = 20_000;

/** The room the earlier days get beside `todayChars` of today's texts, in whole `ROOM_STEP`s. */
export function earlierRoom(todayChars) {
  const used = Math.ceil(Math.max(0, todayChars) / ROOM_STEP) * ROOM_STEP;
  return Math.max(0, READ_CHARS - used);
}

export function earlierFromLedger(entries, chat, { before = Number.MAX_SAFE_INTEGER, chars = READ_CHARS, known = new Set(), fade = false, fadeFrom = before, grant = null } = {}) {
  const tools = new Map();
  const facts = new Map();
  const events = [];
  const seen = new Set(known);
  let room = chars;
  // A text Tex sent on its own is shown by its note, which carries why it went out (`sentOnItsOwn.js`): the text's own
  // event is left out here, and the note too when the day already shows the text (`known` holds its id).
  const list = Array.isArray(entries) ? entries : [];
  const links = linkedSends(list);
  const eidOf = new Map(list.filter((entry) => isLinkedText(entry, links)).map((entry) => [entry.turn, entry.eid]));
  for (const entry of list) {
    if (isLinkedText(entry, links) || isUnsentText(entry, links) || isUnsentNote(entry, links) || keptNotTexted(entry)) continue;
    if (entry?.kind === "note" && eidOf.has(entry.turn) && seen.has(eidOf.get(entry.turn))) continue;
    if (entry?.kind === "tool" && typeof entry.turn === "string" && entry.ok === true && typeof entry.name === "string") {
      const names = tools.get(entry.turn) ?? [];
      if (!names.includes(entry.name)) names.unshift(entry.name);
      tools.set(entry.turn, names);
    }
    // What a reply read for what it said (`toldFacts.js`): a web page's always, a note's only under the grant it was read under.
    if (entry?.kind === "reply" && typeof entry.turn === "string") {
      const kept = shownFacts(entry, grant);
      if (kept.length > 0) facts.set(entry.turn, kept);
    }
    if (room <= 0 || !(entry?.at < before)) continue;
    const found = entry.kind === "text" ? asEvent(entry, chat) : entry.kind === "note" ? noteEvent(entry, chat) : null;
    if (found === null || (!found.byItself && !EVENT_ID.test(found.id ?? "")) || !EVENT_KINDS.has(found.kind) || seen.has(found.id)) continue;
    const shown = fade ? faded(found, fadeFrom) : found;
    room -= String(shown.text ?? "").length + 40;
    // Past the room, the scan goes on for the tools and facts of the texts it kept, never ending at a point a text moves.
    if (room < 0) continue;
    seen.add(shown.id);
    events.push(shown);
  }
  // A one-to-one turn lost after it drafted its answer: shown as the answer it drafted, never delivered, with the tools
  // it used under it, so the next turn knows what that turn already did (Dev2, 2026-11-21: "just because we didn't
  // record a turn, we don't know whether it succeeded"; that day's lost turn had written the note it was asked for).
  if (chat === ONE_TO_ONE_CHAT) {
    for (const event of lostReplies(list, before)) {
      if (seen.has(event.id)) continue;
      const shown = fade ? faded(event, fadeFrom) : event;
      room -= String(shown.text ?? "").length + 40;
      if (room < 0) break;
      seen.add(shown.id);
      events.push(shown);
    }
  }
  // Faded, the oldest day is shown whole or not at all, so what is shown of the past only moves once a day and the
  // cached history ahead of it stays the same from one text to the next (the context review, 2026-11-06).
  const kept = fade && room <= 0 && events.length > 0 ? wholeDays(events) : events;
  kept.sort((a, b) => a.at - b.at);
  // Faded, the days older than every text shown are given as the summaries written the night after (`daySummaries.js`).
  const summaries = fade ? daysBefore(entries, kept.length > 0 ? kept[0].at : before) : [];
  return { events: kept, tools, facts, summaries };
}

/** How long after its drafted answer a turn with no text out counts as lost: a send still on its way is not. */
export const LOST_AFTER_MS = 5 * 60_000;

/**
 * Turns that drafted an answer (`reply`) and never got a text out or a note kept, older than `before` and at least
 * `LOST_AFTER_MS` older than the newest entry: each as one of Tex's texts, `delivered: false`, `reason: "lost"`, newest
 * first as `entries` are. A turn that chose silence drafts no words, so it is never one.
 */
export function lostReplies(entries, before = Number.MAX_SAFE_INTEGER) {
  const list = Array.isArray(entries) ? entries : [];
  const newest = list.reduce((max, entry) => (Number.isFinite(entry?.at) && entry.at > max ? entry.at : max), -Infinity);
  const out = new Set();
  for (const entry of list) if ((entry?.kind === "text" && entry.from?.kind === "tex") || entry?.kind === "note") out.add(entry?.turn);
  const lost = [];
  for (const entry of list) {
    if (entry?.kind !== "reply" || entry.backfill !== undefined || typeof entry.turn !== "string" || out.has(entry.turn)) continue;
    const text = typeof entry.text === "string" ? entry.text.trim() : "";
    if (text === "" || !Number.isSafeInteger(entry.at) || !(entry.at < before) || newest - entry.at < LOST_AFTER_MS) continue;
    out.add(entry.turn);
    lost.push({ id: `lost-${entry.turn}`, at: entry.at, kind: "text", from: { kind: "tex" }, turn: entry.turn, text, delivered: false, reason: "lost" });
  }
  return lost;
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

/** A day's text Tex sent on its own, with the reason from its note (`sentOnItsOwn.js`), as `noteEvent` gives it. */
function withNoteReason(event, note) {
  const about = note === undefined || note.others === true ? null : noteAbout(note);
  return about === null || !BY_ITSELF.test(about) ? event : { ...event, byItself: true, ...sentOnItsOwn(about) };
}

/** A check-in or other text Tex sent by itself, as an event; anything else kept as a note is not shown. */
function noteEvent(entry, chat) {
  // A routine's note keeps its path, not an `about`; one texted to other people is not this chat's (`finishARoutine.js`).
  const about = entry.others === true ? null : noteAbout(entry);
  if (about === null || !BY_ITSELF.test(about) || typeof entry.text !== "string" || entry.text.trim() === "") return null;
  // Why it went out stays with it (`sentOnItsOwn.js`): a ping another agent asked for is that agent's, passed on.
  return { id: `note-${entry.id}`, at: entry.at, chat, from: { kind: "tex" }, kind: "text", text: entry.text.trim(), delivered: true, byItself: true, ...sentOnItsOwn(about) };
}
