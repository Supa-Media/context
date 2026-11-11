/**
 * `POST /tex/page/ledger`: a chat's history file on the Tex page (decided by
 * the owner, 2026-11-02: the ledger is one history file, shown raw, with
 * filters, and a view of exactly what Tex sees;
 * `docs/decisions/texting-assistant/chat-ledger.md`).
 *
 *  - `{handle, chat, view: "raw", kinds?, day?, after?, before?}` → `{manifest, entries, next?, before?}`:
 *    the ledger's entries as kept, oldest first (or newest first with `before`), 100 at a time.
 *  - `{handle, chat, view: "sees"}` → `{settings, text}`: the chat as the next texted turn is
 *    shown it, rendered by the turn's own code (`agent/ledgerHistory.js`, `agent/logRender.js`).
 *  - `{handle, chat, view: "conversations"}` and `{…, view: "conversation", thread}`: the chat's
 *    conversations, and one of them with its texts (`conversations.js`).
 *  - `{handle, chat, view: "pages"}` → `{pages}`: the pages the chat's turns and jobs wrote (`pages.js`).
 *
 * Who may, and which chat: `page.js`, as every Tex page route; a group's
 * ledger only for the chat's own people. Nothing here is logged but the
 * route and outcome (`serve.js`).
 */

import { ledgerFor, ONE_TO_ONE_CHAT } from "../../agent/ledger.js";
import { earlierFromLedger, readLedger } from "../../agent/ledgerHistory.js";
import { renderEvents } from "../../agent/logRender.js";
import { READ_CHARS } from "../../agent/log.js";
import { LEDGER_KINDS } from "../../texStore/ledger.js";
import { handleOf, startOfDay } from "./page.js";
import { conversationsView, conversationView } from "./conversations.js";
import { pagesView } from "./pages.js";

/** Entries one raw page answers. */
export const RAW_PAGE = 100;
/** The texting Worker hands each turn this much of the chat itself (`apps/agent/src/events.ts` `KEEP_EVENTS_MS`). */
const HELD_MS = 24 * 3_600_000;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Which ledger a page's chat is: the person's one-to-one, or the group's. */
function placeOf(chat) {
  if (chat?.owner?.person) return { owner: { person: chat.owner.person }, name: ONE_TO_ONE_CHAT };
  if (chat?.owner?.chat) return { owner: { chat: chat.owner.chat }, name: chat.owner.chat };
  return null;
}

/** A day the person names (`YYYY-MM-DD`, their own time zone) as `{since, until}`, or null. */
export function dayRange(day, timeZone) {
  const named = typeof day === "string" ? DAY.exec(day) : null;
  if (named === null) return null;
  const noon = Date.UTC(Number(named[1]), Number(named[2]) - 1, Number(named[3]), 12);
  if (!Number.isFinite(noon)) return null;
  const since = startOfDay(noon, timeZone);
  return { since, until: startOfDay(since + 36 * 3_600_000, timeZone) };
}

const seqOf = (value) => (Number.isSafeInteger(value) ? value : null);

/** The page's answer for a chat's history file. Throws only when the request is not one it reads. */
export async function ledgerView(env, page, chat, body, { now = Date.now() } = {}) {
  const place = placeOf(chat);
  const ledger = place === null ? null : ledgerFor(env, place.owner);
  if (ledger === null) return { manifest: null, entries: [] };
  if (body?.view === "sees") return await sees(ledger, place, page, chat, now);
  // The chat's conversations, and one of them (`conversations.js`).
  if (body?.view === "conversations") return await conversationsView(ledger, place.name);
  if (body?.view === "conversation") return await conversationView(ledger, place.name, body?.thread);
  // The pages its turns and jobs wrote (`pages.js`): a call that named no workspace wrote in the chat's own.
  if (body?.view === "pages") return await pagesView(ledger, place.name, chat.kind === "me" ? handleOf(body?.handle) : handleOf(chat.about?.context ?? null));
  const kinds = Array.isArray(body?.kinds) ? body.kinds.filter((kind) => LEDGER_KINDS.has(kind)) : null;
  const range = dayRange(body?.day, page.timeZone);
  const before = seqOf(body?.before);
  const read = await ledger.read(place.name, {
    ...(before !== null ? { before } : (seqOf(body?.after) !== null ? { after: seqOf(body.after) } : {})),
    ...(kinds !== null && kinds.length > 0 ? { kinds } : {}),
    ...(range ?? {}),
    // One job's work (its page), or the chat with no job's work (the Jobs filter off).
    ...(typeof body?.job === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(body.job) ? { job: body.job } : body?.jobs === false ? { jobs: false } : {}),
    limit: RAW_PAGE,
  });
  return { manifest: read.manifest, entries: read.entries ?? [], ...(Number.isSafeInteger(read.next) ? { next: read.next } : {}), ...(Number.isSafeInteger(read.before) ? { before: read.before } : {}) };
}

/**
 * What Tex sees: the chat the next texted turn is shown, rebuilt from the
 * ledger the way the turn rebuilds it. The last day is shown as the texting
 * Worker hands it; before it, what the ledger adds, every answer in its words
 * (`docs/decisions/texting-assistant/turn-trust.md`).
 */
async function sees(ledger, place, page, chat, now) {
  const entries = await readLedger(ledger, place.name);
  const recent = earlierFromLedger(entries, place.name, { before: Number.MAX_SAFE_INTEGER }).events.filter((event) => event.at >= now - HELD_MS);
  const held = recent.reduce((sum, event) => sum + String(event.text ?? "").length, 0);
  const earlier = earlierFromLedger(entries, place.name, { before: recent[0]?.at ?? now - HELD_MS, chars: Math.max(0, READ_CHARS - held), known: new Set(recent.map((event) => event.id)) });
  const text = renderEvents([...earlier.events, ...recent], { timeZone: page.timeZone || "UTC", tools: earlier.tools });
  return {
    settings: {
      thinking: false,
      toolNames: true,
      toolResults: false,
      budgetChars: READ_CHARS,
      lastDayFrom: "texting Worker",
      before: "ledger",
    },
    text,
  };
}
