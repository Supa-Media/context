/**
 * A group turn takes its asker's texts that landed behind it (bot battle, 2026-11-23: "tex, burst test A: reply with
 * ALPHA-24" and, a second later, "... B: reply with BRAVO-24").
 *
 * Which texts a group turn answers is fixed when the Worker hands it (`covers`), but the turn reads the chat when it
 * starts. A text from the same asker that landed in between was shown to it, and it answered it, while the record
 * still said it answered only the first; the Worker could not fold the second in (the turn had no session yet,
 * `packages/tex/worker/steer.ts`), so it waited, took a turn of its own and was answered again, and the first answer's
 * BRAVO went under ALPHA. Now the turn covers such a text: it is numbered with the others (`replyUnder.js`), so its
 * answer goes under it, and it is named in the answer's `steered`, so the Worker drops it from its queue
 * (`groupModelTurn.ts` `dropSteered`).
 *
 * Only the asker's own (a group turn runs on their grant), only texts after the newest it covers, only ones that ask
 * Tex (name it, or reply to a text of Tex's), and none Tex already answered.
 */

/** Tex named in a text, as the Worker's group inbox reads it (`groupLedgerHistory.js` `TAGS_TEX`). */
const TAGS_TEX = /(?:^|[^\w@])@?(?:tex|context)(?![\w-])/i;
/** At most this many are taken into one turn. */
export const MAX_TAKEN = 4;

/** The events among `events` (the chat's day, oldest first) a group turn answering `covered` takes in as well. */
export function takenBehind(events, covered, { group = false } = {}) {
  if (!group || !Array.isArray(events) || !Array.isArray(covered) || covered.length === 0) return [];
  const asked = covered.filter((event) => event?.from?.kind === "person");
  const who = asked[0]?.from?.who;
  if (typeof who !== "string" || who === "" || !asked.every((event) => event.from?.who === who)) return [];
  const newest = Math.max(...covered.map((event) => event.at));
  const have = new Set(covered.map((event) => event.id));
  const byId = new Map(events.map((event) => [event.id, event]));
  const answered = new Set(events.filter((event) => event?.from?.kind === "tex").flatMap((event) => (Array.isArray(event.covers) ? event.covers : [])));
  const asksTex = (event) => TAGS_TEX.test(String(event.text ?? "")) || byId.get(event.replyTo)?.from?.kind === "tex";
  return events
    .filter((event) => event?.kind === "text" && event.from?.kind === "person" && event.from?.who === who && event.at > newest && !have.has(event.id) && !answered.has(event.id) && asksTex(event))
    .slice(0, MAX_TAKEN);
}
