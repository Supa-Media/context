/**
 * A test chat's start read from a real chat (`route.js` `open`): its ledger before the text it starts at, its logged
 * steps for the line's delays, and one Lab row per real text. Read only.
 */

import { ledgerFor } from "../fromGateway/agent_ledger.js";
import { LEDGER_KINDS } from "../fromGateway/texStore_ledger.js";
import { THREADS_SUFFIX } from "../fromGateway/agent_threadsFold.js";

/** One read of a real chat's texts; a chat is read whole, page after page, up to `MAX_PAGES` (a million texts). */
const PAGE_TEXTS = 5_000;
const MAX_PAGES = 200;

/** What a test chat copies of the real chat's ledger: every kind a turn reads (replies, notes, tools, days, ...), never the steps' logs. */
const COPIED_KINDS = [...LEDGER_KINDS].filter((kind) => kind !== "step");

/**
 * A real chat's ledger before its text `base` (left out), oldest first: read only, and all of it, paged on with `after`
 * (Dev2, 2026-11-16: "its not truly loading the entire converstation history ... thats not gonna do"). Every kind a turn
 * reads, not the texts alone: Tex's history is rebuilt from the texts with their `reply` entries, and with texts only it
 * rebuilt nothing (`ledgerConversation.js`), so a test turn read no history. A read the ledger cannot answer leaves what
 * was read so far. `until` is when the text `base` arrived (null when there is none, or it is not found).
 */
export async function realLedgerAt(env, owner, chat, base) {
  const ledger = ledgerFor(env, owner);
  if (ledger === null) return { entries: [], until: null };
  const entries = [];
  let after = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const read = await ledger.read(chat, { ...(after === null ? {} : { after }), kinds: COPIED_KINDS, limit: PAGE_TEXTS, jobs: false }).catch(() => null);
    if (read === null) break;
    for (const entry of read.entries ?? []) if (entry && typeof entry === "object" && (entry.kind !== "text" || (typeof entry.eid === "string" && typeof entry.text === "string"))) entries.push(entry);
    if (!Number.isSafeInteger(read.next)) break;
    after = read.next;
  }
  entries.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  if (typeof base !== "string" || base === "") return { entries, until: null };
  const at = entries.findIndex((entry) => entry.kind === "text" && entry.eid === base);
  return at < 0 ? { entries, until: null } : { entries: entries.slice(0, at), until: Number.isFinite(entries[at].at) ? entries[at].at : null };
}

/**
 * The real chat's conversation threads as they stood when a text arrived at `until` (every thread entry the classifier
 * wrote before then), oldest first; all of them when `until` is null. Without it a test chat started back in the chat
 * read the threads as they are now, the summaries of what was said after the text it starts at included (2026-11-26: a
 * copy started before a send read "he has sent the reply" and offered a draft nobody had made). Read only; none when
 * they cannot be read.
 */
export async function realThreads(env, owner, chat, until) {
  const ledger = ledgerFor(env, owner);
  if (ledger === null) return [];
  const threads = [];
  let after = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const read = await ledger.read(`${chat}${THREADS_SUFFIX}`, { ...(after === null ? {} : { after }), limit: PAGE_TEXTS }).catch(() => null);
    if (read === null) break;
    for (const entry of read.entries ?? []) if (entry && typeof entry === "object" && entry.kind === "thread") threads.push(entry);
    if (!Number.isSafeInteger(read.next)) break;
    after = read.next;
  }
  threads.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const kept = until === null ? threads : threads.filter((entry) => Number.isFinite(entry.at) && entry.at < until);
  return kept.map(({ seq: _seq, ...entry }) => entry);
}

/** How many of the real chat's newest logged steps a test chat reads at open for its line's delays (`line.js`). */
const LINE_STEPS = 2_000;

/** The real chat's logged steps, newest first, for the line's measured delays; none when they cannot be read. */
export async function loggedSteps(env, owner, chat) {
  const ledger = ledgerFor(env, owner);
  if (ledger === null) return [];
  const read = await ledger.read(chat, { before: Number.MAX_SAFE_INTEGER, kinds: ["step"], limit: LINE_STEPS, jobs: false }).catch(() => null);
  return Array.isArray(read?.entries) ? read.entries : [];
}

/**
 * One row per real text. A voice note is logged twice under one event id (the audio, then what was heard, `heard`),
 * and the test chat keys its rows by that id, so the pair is one row: the one with words. Its history keeps both.
 */
export function oneRowPerText(entries) {
  const byEid = new Map();
  for (const entry of entries) {
    const had = byEid.get(entry.eid);
    if (!had || (String(had.text ?? "").trim() === "" && String(entry.text ?? "").trim() !== "")) byEid.set(entry.eid, entry);
  }
  return [...new Set(entries.map((entry) => entry.eid))].map((eid) => byEid.get(eid));
}

/** The Lab's row for a real text. */
export function realRow(entry, kind) {
  const who = entry.from?.kind === "tex" ? "Tex" : typeof entry.from?.name === "string" && entry.from.name !== "" ? entry.from.name : kind === "group" ? "Someone" : "You";
  return { id: entry.eid, eid: entry.eid, who, text: entry.text, at: entry.at, prod: true };
}
