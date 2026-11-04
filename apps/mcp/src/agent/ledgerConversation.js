/**
 * A PERSON'S TEXTS WITH TEX, AS THE TURNS EVERY READER OF THEIR CHAT WANTS,
 * REBUILT FROM THE CHAT'S LEDGER (decided by the owner, 2026-11-02: one record
 * per chat, every view rebuilt from it; `docs/decisions/texting-assistant/
 * chat-ledger.md`, "Retiring the old copies").
 *
 * Until this, every reader of the one-to-one chat (a turn's history, the
 * earlier-texts tool, the check-in, routines, the memory nudge, the self-review,
 * a texted yes overtaken, the report gate) read the gateway's history record
 * (`history.js`), a second copy of what the ledger holds. This rebuilds the
 * same turns, `{role, text, tainted?, tools?, sources?, id?, at?, thread?,
 * theirs?}` oldest first, from the ledger, so the record has no readers left.
 *
 * - What they texted is the ledger's `text` entries from a person, in the
 *   texting Worker's words (`logRender.js` `words`), each run of them one
 *   question, with what the gateway noted beside the answer (`attached`: the
 *   files they sent, where a picture is kept, a voice message's words).
 * - Tex's answer is its texts of one turn, shown only when the gateway's own
 *   `reply` entry for that turn exists: the Worker's events never vouch for
 *   themselves (`ledgerHistory.js`). `clean: false` marks it tainted, as the
 *   record did, so a later turn that reads it is untrusted (`historyIsTainted`).
 *   A Tex text with no reply behind it is never shown: one Tex sent by itself
 *   is its `note`, and one nobody can vouch for has no words worth the risk.
 * - A text Tex sent by itself (a check-in, a routine's run, a job's update, a
 *   settled yes) is its `note`: the line saying what it was, then its words,
 *   tainted by its own mark. A fixed text the Worker sent with no model is its
 *   `told` event, in the gateway's words for it.
 */

import { HISTORY, MAX_HISTORY_CHARS, MAX_HISTORY_TURNS, TOLD, TOLD_QUESTION } from "./conversation.js";
import { BACKFILLED, eventEntry, ONE_TO_ONE_CHAT } from "./ledger.js";
import { deskLedger } from "./history.js";
import { words } from "./logRender.js";
import { DESK_LEDGER } from "../texStore/desk.js";

/** Every line Tex sent without a text from them begins so (`heartbeat.js`, `conversation.js`, `attention.js`). */
const BY_ITSELF = /^\(Not a text from them\./;
/** At most this many reads of the ledger rebuild one conversation. */
const MAX_PAGES = 4;
const SKIPPED_EVENTS = new Set(["delivery", "ask_settled"]);
/** The Worker's copy of a fixed text and the gateway's are this close: further apart, it was texted again. */
const SAME_TOLD_MS = 10 * 60_000;

const routineLine = (path) => `(Not a text from them. Your routine ${path} ran on its schedule and you texted them what follows.)`;
const bySeq = (a, b) => (a.seq ?? 0) - (b.seq ?? 0);

/** The turns of a ledger's entries (any order), oldest first, unbounded: `keep` bounds them. */
export function conversationFromLedger(entries, { question: asQuestion = null } = {}) {
  const list = (Array.isArray(entries) ? entries : []).filter((entry) => entry !== null && typeof entry === "object").sort(bySeq);
  const replies = new Map();
  const tools = new Map();
  const byItself = new Set();
  for (const entry of list) {
    if (entry.kind === "reply" && typeof entry.turn === "string") replies.set(entry.turn, entry);
    else if (entry.kind === "note" && typeof entry.turn === "string") byItself.add(entry.turn);
    else if (entry.kind === "tool" && typeof entry.turn === "string" && (entry.ok === true || entry.held === true) && typeof entry.name === "string") {
      const names = tools.get(entry.turn) ?? [];
      if (!names.includes(entry.name)) names.push(entry.name);
      tools.set(entry.turn, names);
    }
  }

  // An event written again (a voice message once heard, `heardWords.js`) is shown once, where it first came, in its newest words.
  const newestOf = new Map();
  for (const entry of list) if (entry.kind === "text" && typeof entry.eid === "string") newestOf.set(entry.eid, entry);
  const placed = new Set();
  const turns = [];
  const toldAt = new Map();
  let asked = [];
  let answering = null;
  // A run of their texts as one question: its id the first text's, so the same question keeps it however much is read.
  const question = (fallback, extra = {}) => {
    const texts = asked;
    asked = [];
    const pairs = texts.map((entry) => [entry, words({ ...entry, kind: entry.event })]).filter(([, text]) => text.trim() !== "");
    const said = pairs.map(([, text]) => text);
    if (said.length === 0) return fallback === null ? null : { role: "user", text: fallback, ...extra };
    const [first, last] = [texts[0], texts.at(-1)];
    // A group's question names who said each text (`groupPageCopy.js` `groupQuestion`); a person's own is their words.
    const text = typeof asQuestion === "function" ? asQuestion(pairs.map(([entry]) => entry), said) : said.join("\n");
    return { role: "user", text, ...(typeof first.eid === "string" ? { id: first.eid } : {}), ...(Number.isSafeInteger(last.at) ? { at: last.at } : {}), theirs: true, ...extra };
  };
  const flush = () => {
    if (answering === null) return;
    const reply = replies.get(answering.turn);
    // A voice message heard onto their own line is not repeated from what the gateway noted beside the answer.
    const onTheirLine = asked.some((entry) => entry.heard === "voice");
    const noted = typeof reply.attached === "string" ? reply.attached.split("\n").filter((line) => line !== "" && !(onTheirLine && line.startsWith("[Voice message "))).join("\n") : "";
    const extra = [noted !== "" ? noted : null].filter(Boolean);
    const user = question(null, typeof reply.thread === "string" ? { thread: reply.thread } : {});
    if (user !== null) {
      if (extra.length > 0) user.text = [user.text, ...extra].join("\n");
      turns.push(user, {
        role: "assistant",
        text: answering.texts.join("\n"),
        ...(reply.clean !== true ? { tainted: true } : {}),
        ...(tools.has(answering.turn) ? { tools: tools.get(answering.turn) } : {}),
        ...(Array.isArray(reply.sources) && reply.sources.length > 0 ? { sources: reply.sources } : {}),
      });
    }
    answering = null;
  };

  for (const entry of list) {
    if (entry.kind === "text") {
      const from = entry.from?.kind;
      if (SKIPPED_EVENTS.has(entry.event)) continue;
      if (from === "person") {
        if (typeof entry.eid === "string" && placed.has(entry.eid)) continue;
        if (typeof entry.eid === "string") placed.add(entry.eid);
        flush();
        asked.push(typeof entry.eid === "string" ? newestOf.get(entry.eid) : entry);
      } else if (from === "system" && typeof entry.told === "string" && Object.hasOwn(TOLD, entry.told)) {
        // Both the Worker and the gateway keep a fixed text (`conversation.js` `appendTold`): one of them is shown.
        // Each copy pairs with at most one of the other's, so the same text sent twice is still shown twice.
        const source = typeof entry.eid === "string" ? "worker" : "gateway";
        const other = toldAt.get(`${source === "worker" ? "gateway" : "worker"}:${entry.told}`);
        if (other !== undefined && Number.isSafeInteger(entry.at) && Math.abs(entry.at - other.at) < SAME_TOLD_MS && !other.paired) {
          other.paired = true;
          continue;
        }
        if (Number.isSafeInteger(entry.at)) toldAt.set(`${source}:${entry.told}`, { at: entry.at, paired: false });
        flush();
        turns.push({ role: "user", text: TOLD_QUESTION, ...(typeof entry.id === "string" ? { id: entry.id } : {}), ...(Number.isSafeInteger(entry.at) ? { at: entry.at } : {}) }, { role: "assistant", text: TOLD[entry.told] });
      } else if (from === "tex" && entry.delivered !== false && typeof entry.text === "string" && entry.text.trim() !== "") {
        const turn = entry.turn;
        if (typeof turn !== "string" || !replies.has(turn) || byItself.has(turn)) continue;
        if (answering?.turn === turn) answering.texts.push(entry.text.trim());
        else {
          flush();
          answering = { turn, texts: [entry.text.trim()] };
        }
      }
    } else if (entry.kind === "note" && entry.others !== true && entry.backfill === undefined && typeof entry.text === "string" && entry.text.trim() !== "") {
      // A routine's text to other people is not this chat's (`texEntryPoint.js`); a copied-in note is already among the texts.
      flush();
      const about = typeof entry.about === "string" ? entry.about : typeof entry.routine === "string" ? routineLine(entry.routine) : null;
      const at = Number.isSafeInteger(entry.at) ? { at: entry.at } : {};
      // One that answers them (a settled yes) takes their texts as its question; one Tex sent by itself leaves them waiting.
      const thread = typeof entry.thread === "string" ? { thread: entry.thread } : {};
      // The note's own id names the exchange, so a reply under it finds its thread (`threadView.js`).
      const user = about !== null && BY_ITSELF.test(about) ? { role: "user", text: about, ...(typeof entry.id === "string" ? { id: entry.id } : {}), ...at, ...thread } : question(about ?? "", { ...(entry.theirs === true ? { theirs: true } : {}), ...thread });
      if (user === null || user.text === "") continue;
      turns.push(user, { role: "assistant", text: entry.text.trim(), ...(entry.tainted === true ? { tainted: true } : {}), ...(Array.isArray(entry.sources) && entry.sources.length > 0 ? { sources: entry.sources } : {}) });
    }
  }
  flush();
  return turns;
}

/**
 * The person's one-to-one chat as turns, from their ledger: the desk's page
 * first (read with the rest of the turn's first reads, `texStore/desk.js`),
 * then older pages until the record's bounds are met. Null when the store
 * keeps no ledger for them (not a person's own texting session), or when the
 * whole ledger was read and their chat from before it began is not copied in
 * yet (no `BACKFILLED` mark, `ledgerBackfill.js`): the record is then the
 * fuller copy, until their next text copies it in. Throws when the ledger
 * can't be read.
 */
export async function readLedgerConversation(store) {
  const ledger = typeof store?.texLedger === "function" ? store.texLedger(null) : null;
  if (ledger === null || typeof ledger?.read !== "function") return null;
  const entries = [];
  let cursor = Number.MAX_SAFE_INTEGER;
  let whole = false;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const first = page === 0 ? await deskLedger(store) : null;
    const read = first ?? (await ledger.read(ONE_TO_ONE_CHAT, { ...DESK_LEDGER.options, before: cursor }));
    entries.push(...(read?.entries ?? []));
    if (!Number.isSafeInteger(read?.before)) {
      whole = true;
      break;
    }
    const turns = conversationFromLedger(entries);
    if (turns.length >= MAX_HISTORY_TURNS || turns.reduce((sum, turn) => sum + turn.text.length, 0) >= MAX_HISTORY_CHARS) break;
    cursor = read.before;
  }
  if (whole && !entries.some((entry) => entry?.id === BACKFILLED)) return null;
  return HISTORY.keep(conversationFromLedger(entries));
}

/**
 * Whether the person's chat from before their ledger began is copied in (its
 * `BACKFILLED` mark sits first): from then on the ledger is the chat's one copy
 * and the old history record is no longer written. False when the store keeps
 * no ledger for them, or the ledger can't be read: the record goes on.
 */
export async function copiedIn(store) {
  const ledger = typeof store?.texLedger === "function" ? store.texLedger(null) : null;
  if (ledger === null || typeof ledger?.oldest !== "function") return false;
  try {
    return (await ledger.oldest(ONE_TO_ONE_CHAT))?.id === BACKFILLED;
  } catch {
    return false;
  }
}

const eventId = (at) => `${String(Math.max(0, Math.floor(at))).padStart(13, "0")}-${String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0")}`;

/**
 * The texts of an exchange the texting Worker logged none of (a turn that names
 * no texts it answers: the bench, a caller other than the Worker), as `text`
 * entries in the gateway's words: their question at `asked`, Tex's answer now,
 * under `turn`, whose own `reply` entry is what vouches for it.
 */
export function exchangeEntries(question, answer, { turn, asked = Date.now(), now = Date.now() }) {
  const entries = [];
  if (String(question ?? "").trim() !== "") entries.push(eventEntry({ id: eventId(asked), at: Math.floor(asked), from: { kind: "person" }, kind: "text", text: String(question) }));
  if (String(answer ?? "").trim() !== "") entries.push(eventEntry({ id: eventId(now), at: Math.floor(now), from: { kind: "tex" }, kind: "text", text: String(answer), turn, delivered: true }));
  return entries;
}
