/**
 * Rung 1 of the lookup ladder, `rungKnows` ("What it already knows"; `../../lookupLadder.js`, on the node shelf):
 * before Tex asks them a fact, search the chat's own history for it, further back than the front door reads (its
 * verbatim days and its day summaries), through the front door's own reader and grant (`weekTurn`).
 *
 * Input: the words to look for (`termsOf` the draft's questions). Output: `{ found: lines, days, ms }`, the lines that
 * hold at least half the words, best first; `found: []` when nothing does or the ledger could not be read in time.
 * No model, never throws.
 */
import { ledgerPlace } from "../../ledger.js";
import { linesWith } from "../../lookupLadder.js";
import { DEFAULT_TIME_ZONE, readTimeZone } from "../../localNow.js";
import { carryKey } from "../../stretch.js";
import { weekTurn } from "../../weekHistory.js";

/** How far back it reads verbatim, and its caps: further than the front door's week, every summary. */
export const KNOWS_READS = Object.freeze({ chat: Object.freeze({ days: 90, chars: 600_000 }), summaries: Object.freeze({ days: null, chars: 200_000 }) });
/** The longest it waits on the ledger. */
export const KNOWS_MS = 1_200;

export async function rungKnowsNode(input, io) {
  const t = io?.ctx?.turn ?? {};
  const terms = Array.isArray(input?.terms) ? input.terms : [];
  const started = Date.now();
  if (terms.length === 0) return { found: [], why: "no words to look for", ms: 0 };
  const place = ledgerPlace(t.session);
  const ledger = place !== null && typeof t?.store?.texLedger === "function" ? t.store.texLedger(place.owner.chat ?? null) : null;
  if (ledger === null) return { found: [], why: "no chat history here", ms: 0 };
  const at = Number.isFinite(t.received) ? t.received : Date.now();
  let timer;
  const week = await Promise.race([
    Promise.resolve()
      .then(() => weekTurn({ ledger, chat: place.chat, now: at, timeZone: readTimeZone(t?.body?.timeZone) ?? DEFAULT_TIME_ZONE, reads: KNOWS_READS, grant: carryKey(t.session), log: () => {} }))
      .catch(() => null),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), KNOWS_MS);
    }),
  ]).finally(() => clearTimeout(timer));
  const text = typeof week?.history?.text === "string" ? week.history.text : "";
  return { found: linesWith(text, terms), days: KNOWS_READS.chat.days, searched: terms, ms: Date.now() - started, ...(week === null ? { why: "history not read in time" } : {}) };
}
