/**
 * A person's chat with Tex over some days, read from its ledger (decided by the
 * owner, 2026-11-02: one record per chat, every view rebuilt from it;
 * `docs/decisions/texting-assistant/chat-ledger.md`). What the nightly dream
 * (`dream.js`) and the hand-back miner (`handbackMiner.js`) read, in place of
 * the daily transcript notes (`tex/transcripts/`) they read before, which are
 * no longer written.
 *
 * Rendered as the transcripts were: what they texted, what Tex thought and said
 * between its tools, each tool with its arguments and outcome, and the answer;
 * never what a tool returned (`transcript.js` `eventLines`, the same lines).
 */

import { clock, dayOf } from "./jobLog.js";
import { ledgerPlace, ONE_TO_ONE_CHAT } from "./ledger.js";
import { eventLines } from "./transcript.js";

/** One read's page of the ledger. */
const PAGE = 500;
/** The most entries one night reads: a busy day is a few hundred. */
export const MAX_DAYS_ENTRIES = 4_000;
/** The most of the rendered chat a dream is shown, newest kept. */
export const MAX_DREAM_CHAT_CHARS = 60_000;
const MAX_TEXT_CHARS = 3_000;

const cut = (text, max) => {
  const words = String(text ?? "").trim();
  return words.length > max ? `${words.slice(0, max)}…` : words;
};

/**
 * The person's own chat's entries at or after `since`, oldest first, at most
 * `MAX_DAYS_ENTRIES` (the newest kept). Empty when the session keeps no
 * one-to-one ledger or it cannot be read.
 */
export async function readChatSince(store, session, { since }) {
  const place = ledgerPlace(session);
  if (place === null || place.chat !== ONE_TO_ONE_CHAT || typeof store?.texLedger !== "function") return [];
  const ledger = store.texLedger(null);
  if (ledger === null || typeof ledger?.read !== "function") return [];
  const entries = [];
  let before = Number.MAX_SAFE_INTEGER;
  try {
    // Newest first, so a long stretch keeps its end.
    while (entries.length < MAX_DAYS_ENTRIES) {
      const read = await ledger.read(ONE_TO_ONE_CHAT, { before, since, limit: PAGE });
      entries.push(...(read?.entries ?? []));
      if (!Number.isSafeInteger(read?.before)) break;
      before = read.before;
    }
  } catch {
    return [];
  }
  return entries.slice(0, MAX_DAYS_ENTRIES).reverse();
}

const fromThem = (entry) => entry.kind === "text" && entry.from?.kind === "person";
const fromTex = (entry) => entry.kind === "text" && entry.from?.kind === "tex";

/** A ledger entry as a transcript's lines (`transcript.js`), or null for one a transcript never showed. */
function entryLines(entry, timeZone) {
  const at = Number.isSafeInteger(entry.at) ? `${clock(entry.at, timeZone)} ` : "";
  if (fromThem(entry)) return `**Them (${at.trim()}):** ${cut(entry.text, MAX_TEXT_CHARS)}\n`;
  if (fromTex(entry)) return entry.delivered === false ? null : `**Tex (${at.trim()}):** ${cut(entry.text, MAX_TEXT_CHARS)}\n`;
  if (entry.kind === "note" && entry.backfill === undefined) return `**Tex, by itself (${at.trim()}):** ${cut(entry.text, MAX_TEXT_CHARS)}\n`;
  if (entry.kind === "thinking") return eventLines({ kind: "thinking", text: entry.text });
  if (entry.kind === "said") return eventLines({ kind: "say", text: entry.text });
  if (entry.kind === "tool") return eventLines({ kind: "tool", name: entry.name, args: entry.args, ok: entry.ok, held: entry.held, reason: entry.reason, ms: entry.ms });
  return null;
}

/**
 * The entries as one text, a heading per day in their zone, newest kept within
 * `chars`. Empty when nothing in them was texted.
 */
export function renderChatDays(entries, { timeZone, chars = MAX_DREAM_CHAT_CHARS } = {}) {
  if (!entries.some((entry) => fromThem(entry) || fromTex(entry))) return "";
  const parts = [];
  let day = null;
  for (const entry of entries) {
    const lines = entryLines(entry, timeZone);
    if (lines === null) continue;
    const today = Number.isSafeInteger(entry.at) ? dayOf(entry.at, timeZone) : day;
    if (today !== day) {
      parts.push(`\n## ${today}\n\n`);
      day = today;
    }
    parts.push(lines);
  }
  let text = parts.join("").trim();
  if (text.length > chars) text = `(earlier texts left out)\n\n${text.slice(text.length - chars).replace(/^[^\n]*\n/, "")}`;
  return text;
}

/**
 * The texted turns in the entries, oldest first, as the hand-back miner reads
 * them: when each answer went, what they texted since the answer before, the
 * tools the turn ran, and the answer. A turn with no text from them before it
 * (a routine's run, a check-in) is left out: nobody texted it.
 */
export function chatTurns(entries) {
  const turns = [];
  let asked = [];
  const toolsOf = new Map();
  for (const entry of entries) {
    if (entry.kind === "tool" && typeof entry.turn === "string") {
      if (!toolsOf.has(entry.turn)) toolsOf.set(entry.turn, []);
      toolsOf.get(entry.turn).push({ name: entry.name, ok: entry.ok === true || entry.held === true });
    }
  }
  for (const entry of entries) {
    if (fromThem(entry)) asked.push(String(entry.text ?? "").trim());
    if (entry.kind !== "reply") continue;
    const question = asked.filter(Boolean).join("\n");
    asked = [];
    const answer = String(entry.text ?? "").trim();
    if (question === "" || answer === "" || !Number.isSafeInteger(entry.at)) continue;
    turns.push({ at: entry.at, question, steps: toolsOf.get(entry.turn) ?? [], answer });
  }
  return turns;
}
