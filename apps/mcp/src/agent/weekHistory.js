/**
 * THE CHAT HISTORY MODULE, THE SAME FOR EVERY CHAT (Dev2, 2026-11-16: "the context module for messages for one-on-one
 * and groups to be the exact same ... 7 days worth of text fully, and then before that summarization, and at the end of
 * the summary ... the tool call with the exact ID it needs to call ... to get that day's transcript"; pictures "by ID
 * ... always added to the conversation history ... if it's within that 7 day range";
 * `docs/decisions/texting-assistant/week-history.md`).
 *
 * Two context modules in the front door's `ctx` turn it on, each set in the config alone (Dev2, 2026-11-17: "maybe we
 * show 7d of chat history, maybe 1 month, maybe all, these should all be config changes, as well as setting the
 * character cutoff ... and then a separate context module for chat summaries"; "make it number of days or all"):
 *
 *   `chat:<days|all>:<chars>`       the chat word for word over that many days (from midnight `days - 1` days back in
 *                                   the chat's zone, so the window moves once a day), newest kept within `chars`;
 *   `summaries:<days|all>:<chars>`  each day before that window that has a day summary (`daySummaries.js`), within the
 *                                   last `days` days, newest kept within `chars`, each ending with the same fixed line
 *                                   naming `read_day` and that day's id (`dayLine`).
 *
 * Both are shown, from the chat's ledger, in one history message, the summaries first; each picture sent within the
 * chat's window is inline where it was sent, by the id it is kept under (`picturesOf`).
 *
 * A one-to-one chat and a group get exactly this; nothing here asks which one it is.
 */

import { wallClock } from "../../../../packages/shared/src/routines.cjs";
import { dayOf } from "./jobLog.js";
import { earlierFromLedger } from "./ledgerHistory.js";
import { renderEvents } from "./logRender.js";
import { DESK_LEDGER } from "../texStore/desk.js";
import { texConfigOf, texStep } from "./texConfig.js";

/** The two context modules, as their keys start in the front door's `ctx` (`texConfig.json`). */
export const CHAT_MODULE = "chat";
export const SUMMARIES_MODULE = "summaries";
const MODULE_KEY = /^(chat|summaries):(\d{1,4}|all):(\d{1,7})$/;
/** The most summaries one read keeps, whatever the span: a year and a half of days. */
export const MAX_DAY_SUMMARIES = 500;
/** The most pictures shown inline, newest kept, and their bytes together (the request's own ceiling is far above). */
export const MAX_WEEK_PICTURES = 20;
export const MAX_WEEK_PICTURE_BYTES = 12_000_000;
/** One read of the ledger, and the most a turn reads for the seven days. */
const PAGE = 2_000;
const MAX_PAGES = 15;
/** `read_day`: the most of a day's words one call answers; a longer day is read in parts. */
export const READ_DAY_CHARS = 60_000;

/** The reads when a config names none: the last 7 days within 130k characters, every summary within 30k. 40k of the
 * week cut a busy group's 721 texts to its newest 218 (2026-11-17); 130k holds that week. The larger caps (200k and
 * 120k) put a full history over Haiku's 100k-token price cliff. Same numbers as the front door's `ctx`. */
export const DEFAULT_READS = Object.freeze({ chat: Object.freeze({ days: 7, chars: 130_000 }), summaries: Object.freeze({ days: null, chars: 30_000 }) });

/** The tool every older day names. */
export const READ_DAY = "read_day";

/** One module key read: `{ days: number | null (all), chars }`, or null when it is not one. */
export function moduleSpan(key, kind) {
  const match = MODULE_KEY.exec(String(key ?? ""));
  if (match === null || match[1] !== kind) return null;
  const days = match[2] === "all" ? null : Number(match[2]);
  const chars = Number(match[3]);
  if ((days !== null && days < 1) || chars < 1) return null;
  return { days, chars };
}

/** What a step's `ctx` reads of the chat: `{ chat, summaries }`, each a span or null, or null when it reads neither. */
export function historyReads(step) {
  const ctx = Array.isArray(step?.ctx) ? step.ctx : [];
  const chat = ctx.map((key) => moduleSpan(key, CHAT_MODULE)).find(Boolean) ?? null;
  const summaries = ctx.map((key) => moduleSpan(key, SUMMARIES_MODULE)).find(Boolean) ?? null;
  return chat === null && summaries === null ? null : { chat, summaries };
}

/** What this turn's config (a Lab draft's, in a Lab test chat) has the front door read of the chat, or null. */
export function historyReadsOf(env) {
  try {
    return historyReads(texStep("fd", texConfigOf(env)));
  } catch {
    return null;
  }
}

/** Whether the front door reads the chat through these modules at all. */
export const weekOn = (env) => historyReadsOf(env) !== null;

const pad = (n) => String(n).padStart(2, "0");
const DAY_ID = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The moment a day (`YYYY-MM-DD`) begins in `timeZone`. */
export function midnightOf(day, timeZone) {
  const [, y, m, d] = DAY_ID.exec(day).map(Number);
  const wall = Date.UTC(y, m - 1, d);
  let at = wall;
  // Two passes settle the zone's offset, a day the clocks change included.
  for (let pass = 0; pass < 2; pass += 1) {
    const w = wallClock(at, timeZone);
    const seen = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
    at += wall - seen;
  }
  return at;
}

/** The day `n` days before `day`. */
export function dayBefore(day, n = 1) {
  const [, y, m, d] = DAY_ID.exec(day).map(Number);
  const at = new Date(Date.UTC(y, m - 1, d - n));
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
}

/**
 * Where the chat word for word starts for a turn answering at `at`: midnight `days - 1` days before that day, in
 * `timeZone`; 0 (the chat's start) for `null` (all); the next midnight for 0 days (no chat module: nothing word for word).
 */
export function weekStart(at, timeZone, days = 7) {
  if (days === null) return 0;
  if (days === 0) return midnightOf(dayBefore(dayOf(at, timeZone), -1), timeZone);
  return midnightOf(dayBefore(dayOf(at, timeZone), days - 1), timeZone);
}

/** How the window is named to the model: "the last 7 days", "today", "the whole chat". */
export const spanName = (days) => (days === null ? "the whole chat" : days === 0 ? "only the newest texts" : days === 1 ? "today" : `the last ${days} days`);

/** The fixed line every older day's summary ends with: the exact call that opens that day whole. */
export const dayLine = (day) => `To read that day's whole transcript: fetch {"id": "day:${day}"}.`;

/** A day id as the history names it: `Sun, Nov 8`. */
function dayName(day) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(new Date(`${day}T12:00:00Z`));
}

/** The older days' part of the history: each summary with its fixed line, oldest first, or "" when there are none. */
export function summaryPart(summaries, days = 7) {
  if (!Array.isArray(summaries) || summaries.length === 0) return "";
  return [
    days === 0 ? "Earlier days, each as summed up after it ended:" : `Earlier days, before ${spanName(days)}, each as summed up after it ended:`,
    ...summaries.map((summary) => `- ${dayName(summary.day)} (${summary.day}): ${summary.text.replace(/\s+/g, " ").trim()} ${dayLine(summary.day)}`),
  ].join("\n");
}

/** Every entry the ledger keeps for `chat` from `since` (and before `until`), newest first, slim, within `MAX_PAGES` reads. */
export async function readSpan(ledger, chat, { since, until = null, kinds = DESK_LEDGER.options.kinds, pages = MAX_PAGES }) {
  const entries = [];
  let before = Number.isSafeInteger(until) ? until : Number.MAX_SAFE_INTEGER;
  let whole = false;
  for (let page = 0; page < pages; page += 1) {
    const read = await ledger.read(chat, { before, since, kinds, limit: PAGE, slim: true, keepArgs: DESK_LEDGER.options.keepArgs });
    entries.push(...(read?.entries ?? []));
    if (!Number.isSafeInteger(read?.before)) {
      whole = true;
      break;
    }
    before = read.before;
  }
  return { entries, whole };
}

/**
 * The day summaries kept before `before` (and for a day from `fromDay` on, when named), one a day, newest kept within
 * `chars`, oldest first: `{day, text}`.
 */
export async function readSummaries(ledger, chat, { before, fromDay = null, chars }) {
  const read = await ledger.read(chat, { before: Number.MAX_SAFE_INTEGER, kinds: ["day"], limit: 500, slim: true });
  const found = new Map();
  for (const entry of read?.entries ?? []) {
    if (entry?.kind !== "day" || typeof entry.day !== "string" || !DAY_ID.test(entry.day) || typeof entry.text !== "string" || entry.text.trim() === "") continue;
    if (!(entry.at < before) || found.has(entry.day) || (fromDay !== null && entry.day < fromDay)) continue;
    found.set(entry.day, entry.text.trim());
  }
  const days = [...found.keys()].sort().reverse();
  const kept = [];
  let room = chars;
  for (const day of days.slice(0, MAX_DAY_SUMMARIES)) {
    room -= found.get(day).length + 120;
    if (room < 0) break;
    kept.push({ day, text: found.get(day) });
  }
  return kept.reverse();
}

const KEPT_IMAGE = /([^\s,()]+\.(?:png|jpe?g|gif|webp|heic|heif)) in ([^)\s][^)]*\.md)\)/gi;

/**
 * The pictures each text sent them was kept under, by the text's id: a turn that kept pictures names each on its reply
 * (`attachments.js` `attachmentsLine`: "(image <id> in <note>)"), and that turn's texts name the texts they answered
 * (`covers`); each picture goes to the answered texts that were a picture or file, in order, the rest to the last.
 */
export function picturesOf(entries) {
  const kept = new Map();
  const covered = new Map();
  for (const entry of entries) {
    if (entry?.kind === "reply" && typeof entry.turn === "string" && typeof entry.attached === "string") {
      const found = [...entry.attached.matchAll(KEPT_IMAGE)].map((match) => ({ id: match[1], note: match[2].trim() }));
      if (found.length > 0) kept.set(entry.turn, found);
    }
    if (entry?.kind === "text" && entry.from?.kind === "tex" && typeof entry.turn === "string" && Array.isArray(entry.covers)) {
      const ids = covered.get(entry.turn) ?? [];
      for (const id of entry.covers) if (typeof id === "string" && !ids.includes(id)) ids.push(id);
      covered.set(entry.turn, ids);
    }
  }
  const kinds = new Map(entries.filter((entry) => entry?.kind === "text" && typeof entry.eid === "string").map((entry) => [entry.eid, entry.event]));
  const byText = new Map();
  for (const [turn, pictures] of kept) {
    const texts = (covered.get(turn) ?? []).filter((id) => kinds.has(id)).sort();
    if (texts.length === 0) continue;
    const sent = texts.filter((id) => kinds.get(id) === "picture" || kinds.get(id) === "file");
    const homes = sent.length > 0 ? sent : [texts.at(-1)];
    pictures.forEach((picture, index) => {
      const home = homes[Math.min(index, homes.length - 1)];
      byText.set(home, [...(byText.get(home) ?? []), picture]);
    });
  }
  return byText;
}

const sameWords = (text) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 60);

/** The marker a picture stands at in the transcript; the history message carries its bytes beside it. */
export const pictureMarker = (id) => `[picture ${id}]`;

/**
 * The week's history: `{ text, pictures: [{marker, id, note}], shown, summaries, chars, cut }`. `entries` are the seven
 * days' ledger entries (newest first, `readSpan`); `extra` events the turn holds that the ledger may not yet (the
 * Worker's outbox, a one-to-one chat's check-ins kept in the person's record), added when their ids are new; `skip`
 * the ids the turn is answering now and the stretch it carries as messages.
 */
export function weekView({ entries, chat, start, summaries = [], extra = [], skip = () => false, timeZone = "UTC", tags = null, grant = null, preface = "", chars: cap = 40_000, days = 7 }) {
  const read = earlierFromLedger(entries, chat, { before: Number.MAX_SAFE_INTEGER, chars: Number.MAX_SAFE_INTEGER, fade: false, grant });
  const byId = new Map();
  for (const event of read.events) if (event.at >= start) byId.set(event.id, event);
  // A check-in kept only in the person's record (`sentByItself.js`) is added unless the ledger already holds its words.
  const said = new Set([...byId.values()].filter((event) => event.from?.kind === "tex").map((event) => sameWords(event.text)));
  for (const event of extra) if (event?.at >= start && !byId.has(event.id) && !(event.byItself && said.has(sameWords(event.text)))) byId.set(event.id, event);
  let events = [...byId.values()].filter((event) => !skip(event)).sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // Past the cap, the newest are kept, whole days first to go.
  let chars = events.reduce((sum, event) => sum + String(event.text ?? "").length + 40, 0);
  let cut = 0;
  while (chars > cap && events.length > 0) {
    chars -= String(events[0].text ?? "").length + 40;
    events = events.slice(1);
    cut += 1;
  }
  const pictures = [];
  const placed = picturesOf(entries);
  const newest = [...events].reverse().flatMap((event) => (placed.get(event.id) ?? []).map((picture) => ({ ...picture, text: event.id })));
  const shownPictures = new Set(newest.slice(0, MAX_WEEK_PICTURES).map((picture) => `${picture.text}:${picture.id}`));
  const marked = events.map((event) => {
    const mine = (placed.get(event.id) ?? []).filter((picture) => shownPictures.has(`${event.id}:${picture.id}`));
    if (mine.length === 0) return event;
    for (const picture of mine) pictures.push({ marker: pictureMarker(picture.id), id: picture.id, note: picture.note });
    return { ...event, pictures: mine.map((picture) => picture.id) };
  });
  const tagged = typeof tags === "function" ? tags(marked) : tags; // each text's conversation (`conversationThreads.js`)
  const transcript = renderEvents(marked, { timeZone, answeredBy: [...read.events, ...extra], tools: read.tools, facts: read.facts, tags: tagged, lulls: true });
  const told = [summaryPart(summaries, days), cut > 0 ? `(The ${cut} oldest texts of ${spanName(days)} are left out here for room; read_day opens any day whole.)` : "", transcript].filter((part) => part !== "").join("\n\n");
  return { text: preface ? `${preface}\n\n${told}` : told, pictures, shown: marked, summaries, chars, cut };
}

/** The bytes of each picture, read by `readPicture(note, id)`, within the byte cap: `[{marker, mediaType, data}]`. */
export async function loadPictures(pictures, readPicture) {
  if (typeof readPicture !== "function" || pictures.length === 0) return [];
  const read = await Promise.all(pictures.map((picture) => Promise.resolve().then(() => readPicture(picture.note, picture.id)).catch(() => null)));
  const loaded = [];
  let bytes = 0;
  for (const [index, image] of read.entries()) {
    if (typeof image?.data !== "string" || typeof image.mediaType !== "string") continue;
    bytes += image.data.length;
    if (bytes > MAX_WEEK_PICTURE_BYTES) break;
    loaded.push({ marker: pictures[index].marker, mediaType: image.mediaType, data: image.data });
  }
  return loaded;
}

/** A `read_image` tool's answer as `{mediaType, data}`, or null. */
export function imageOf(result) {
  const block = Array.isArray(result?.content) ? result.content.find((part) => part?.type === "image" && typeof part.data === "string") : null;
  return block && !result.isError ? { mediaType: block.mimeType ?? block.mediaType, data: block.data } : null;
}

/**
 * `read_day`: one day of the chat word for word, as the history shows its last seven, in parts of `READ_DAY_CHARS`.
 * The same tool in every chat; it reads only this chat's ledger.
 */
export function readDayTool({ ledger, chat, timeZone = "UTC", grant = null, log = (line) => console.log(line) }) {
  return {
    tool: {
      name: READ_DAY,
      description:
        "Read one earlier day of this chat word for word: every text, oldest first, as the history shows the newest days. " +
        'Each earlier day in the history ends with the exact call, like fetch {"id": "day:2026-11-08"}. A long day comes in parts: pass part 2, 3 and on when the answer says there is more.',
      inputSchema: {
        type: "object",
        properties: {
          day: { type: "string", description: "The day, YYYY-MM-DD, as the history names it." },
          part: { type: "integer", description: "Which part of a long day, from 1. Leave it out for the first." },
        },
        required: ["day"],
      },
    },
    call: async (args) => {
      const day = typeof args?.day === "string" ? args.day.trim() : "";
      const part = Number.isSafeInteger(args?.part) && args.part > 0 ? args.part : 1;
      if (!DAY_ID.test(day)) return { content: [{ type: "text", text: 'Name the day as YYYY-MM-DD, like {"day": "2026-11-08"}.' }], isError: true };
      const since = midnightOf(day, timeZone);
      const until = midnightOf(dayBefore(day, -1), timeZone);
      const began = Date.now();
      try {
        const { entries } = await readSpan(ledger, chat, { since, until });
        const view = earlierFromLedger(entries, chat, { before: until, chars: Number.MAX_SAFE_INTEGER, fade: false, grant });
        const text = renderEvents(view.events, { timeZone, tools: view.tools, facts: view.facts, lulls: true });
        const parts = Math.max(1, Math.ceil(text.length / READ_DAY_CHARS));
        log(JSON.stringify({ event: "tex_read_day", texts: view.events.length, chars: text.length, part, parts, ms: Date.now() - began }));
        if (text === "") return { content: [{ type: "text", text: `Nothing was texted in this chat on ${day}.` }] };
        if (part > parts) return { content: [{ type: "text", text: `${day} has ${parts} part${parts === 1 ? "" : "s"}.` }], isError: true };
        const slice = text.slice((part - 1) * READ_DAY_CHARS, part * READ_DAY_CHARS);
        const more = part < parts ? `\n\n(Part ${part} of ${parts}. The rest: call ${READ_DAY} with {"day": "${day}", "part": ${part + 1}}.)` : "";
        return { content: [{ type: "text", text: `${day}, word for word:\n\n${slice}${more}` }] };
      } catch (error) {
        log(JSON.stringify({ event: "tex_read_day", failed: String(error?.name ?? "error").slice(0, 40), ms: Date.now() - began }));
        return { content: [{ type: "text", text: `That day could not be read just now.` }], isError: true };
      }
    },
  };
}

/** What the history opens with, for the span its chat module reads (null: all) and whether summaries come first. */
export function weekPreface(days, summed) {
  if (days === 0) return `(The chat's earlier days, each summed up. "You" is you. The newest messages, the ones you are answering, come next.)`;
  const these = days === null ? "the chat's texts since it began" : days === 1 ? "today's texts" : `the chat's last ${days} days of texts`;
  const within = days === null ? "the chat" : days === 1 ? "today" : `these ${days} days`;
  const before = summed ? ", after a summary of each earlier day" : "";
  return `(${these[0].toUpperCase()}${these.slice(1)}, oldest first, as they happened${before}. "You" is you. A picture sent in ${within} is shown where it was sent, by its id. The newest messages, the ones you are answering, come next.)`;
}
/** The preface for the default reads (7 days, summaries before them). */
export const WEEK_PREFACE = weekPreface(7, true);

/**
 * The week's history for one turn, read from the chat's ledger (`ledger.read`): `{ history, read_day, shown, log }`,
 * `history` one user message with its pictures, or null when the ledger holds nothing to show. `now` is the newest
 * text it answers (or the moment it runs); `extra`, `skip` and `tags` as `weekView` takes them.
 */
export async function weekTurn({ ledger, chat, now, timeZone = "UTC", reads = DEFAULT_READS, extra = [], skip = () => false, tags = null, grant = null, readPicture = null, log = (line) => console.log(line) }) {
  if (ledger === null || typeof ledger?.read !== "function" || typeof chat !== "string") return null;
  const began = Date.now();
  const days = reads.chat === null ? 0 : reads.chat.days;
  const start = weekStart(now, timeZone, days);
  const fromDay = reads.summaries?.days == null ? null : dayBefore(dayOf(now, timeZone), reads.summaries.days);
  const [span, summaries] = await Promise.all([
    reads.chat === null ? { entries: [], whole: true } : readSpan(ledger, chat, { since: start }),
    reads.summaries === null ? [] : readSummaries(ledger, chat, { before: start, fromDay, chars: reads.summaries.chars }).catch(() => []),
  ]);
  const view = weekView({ entries: span.entries, chat, start, summaries, extra: reads.chat === null ? [] : extra, skip, timeZone, tags, grant, preface: weekPreface(days, summaries.length > 0), chars: reads.chat?.chars ?? 0, days });
  const read = Date.now();
  const pictures = await loadPictures(view.pictures, readPicture);
  const line = { event: "tex_week_history", start, days: days ?? "all", cap: reads.chat?.chars ?? 0, summaryDays: reads.summaries === null ? 0 : reads.summaries.days ?? "all", summaryCap: reads.summaries?.chars ?? 0, texts: view.shown.length, chars: view.chars, cut: view.cut, whole: span.whole, entries: span.entries.length, summaries: summaries.length, pictures: view.pictures.length, picturesShown: pictures.length, readMs: read - began, picturesMs: Date.now() - read };
  log(JSON.stringify(line));
  const read_day = readDayTool({ ledger, chat, timeZone, grant, log });
  if (view.shown.length === 0 && summaries.length === 0) return { history: null, read_day, shown: [], log: line };
  return { history: { role: "user", text: view.text, ...(pictures.length > 0 ? { pictures } : {}) }, read_day, shown: view.shown, log: line };
}
