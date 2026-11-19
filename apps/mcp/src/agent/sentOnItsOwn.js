/**
 * WHY TEX SENT A TEXT NOBODY ASKED FOR, KEPT BESIDE IT WHEREVER A TURN IS SHOWN IT
 * (Dev2, 2026-11-04: a message his ChatGPT agent asked Tex to pass on was shown
 * to a later turn as Tex's own words, so Tex disowned it: "ignore my last text
 * about ChatGPT connectors").
 *
 * A check-in, a routine's run or a ping another agent asked for is kept with
 * the reason it went out (`about`, "(Not a text from them. ...)",
 * `conversation.js`, `attention.js`, `heartbeat.js`). The readers that place
 * those texts in a turn's chat (`ledgerHistory.js` `noteEvent`,
 * `sentByItself.js`) kept the words and dropped the reason. This turns the
 * reason into the event's own fields, which `logRender.js` draws:
 *
 * - a ping another of their agents asked for is said by that agent, passed on
 *   by Tex (`from.kind: "agent"`), the way a group member's text is theirs;
 * - anything else Tex sent by itself stays "You", with a line under it saying
 *   why it went out.
 */

const BY_ITSELF = /^\(Not a text from them\.\s*/;

/**
 * Why a routine's text went out, for a routine's note, which keeps its path and no `about` (`finishARoutine.js`).
 * Both readers use it (`ledgerConversation.js`, `ledgerHistory.js` `noteEvent`): with only the first, a one-to-one
 * routine's text reached a turn's chat only through `sentByItself.js`, a day long, so Tex forgot after 24 hours it had
 * sent it (Dev2, 2026-11-17).
 */
export const routineLine = (path) => `(Not a text from them. Your routine ${path} ran on its schedule and you texted them what follows.)`;

/** Why a note Tex sent by itself went out: its `about`, or a routine's line from its path; null for any other note. */
export const noteAbout = (entry) => (typeof entry?.about === "string" ? entry.about : typeof entry?.routine === "string" && entry.routine !== "" ? routineLine(entry.routine) : null);
const RELAYED = /another of their agents asked you/i;
/** A reason longer than this is cut: it is a label, never instructions to follow. */
export const MAX_WHY_CHARS = 200;

/** The fields an event Tex sent by itself takes from the reason it was kept with (`about`): `{from, why}`, or `{}` for none. */
export function sentOnItsOwn(about) {
  if (typeof about !== "string" || !BY_ITSELF.test(about)) return {};
  if (RELAYED.test(about)) return { from: { kind: "agent" }, why: "another of their agents asked you to pass this on; it is that agent's message, not yours and not theirs" };
  const first = about.replace(BY_ITSELF, "").replace(/\)\s*$/, "").split(/(?<=\.)\s/)[0] ?? "";
  const why = first.replace(/\s+/g, " ").trim().slice(0, MAX_WHY_CHARS);
  return why === "" ? {} : { why: `sent on your own: ${why}` };
}

/*
 * LINKED SENDS. A text Tex sent by itself, recorded twice and shown once (Dev2, 2026-11-18: a check-in at 8:01 AM was missing from
 * the chat's history, because `/routine-text` texted it and recorded no Tex text event, only the gateway's note).
 *
 * Every text Tex delivers now lands in the chat's ledger as a Tex `text` event with its `source` (`apps/agent/src/
 * texSends.ts`), written by the same recorder the reply path uses. A text Tex sent on its own (a check-in, a routine,
 * a ping, a job's update) also has the gateway's `note`, written before the Worker texted, which carries why it went.
 * The two share their run's `turn`: that is the link. Readers that show notes keep the note (it carries the reason)
 * and drop the linked text event; a note whose linked send was not delivered is dropped, since it was never said.
 * A note with no linked text event (one written before 2026-11-18, or a send whose event never reached the ledger)
 * stays as it was: no backfill.
 */

/** The `source` of a text Tex sent on its own, outside a reply to a text: these have a gateway note beside them. */
export const OWN_SOURCES = new Set(["checkin", "routine", "ping", "update", "job", "new_line"]);
/** Every `source` a Tex text event may carry (`log.js` `checkEvent`). */
export const TEXT_SOURCES = new Set(["reply", "progress", ...OWN_SOURCES]);

const texSend = (entry) => entry !== null && typeof entry === "object" && entry.from?.kind === "tex" && typeof entry.turn === "string" && entry.turn !== "" && OWN_SOURCES.has(entry.source);

/**
 * From a chat's ledger entries (or `log.js` events), any order: `noted`, the turns that have a `note`; `said`, the
 * turns with a delivered linked text event; `unsaid`, the turns whose linked send was recorded undelivered.
 */
export function linkedSends(entries) {
  const noted = new Set();
  const said = new Set();
  const unsaid = new Set();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry?.kind === "note" && typeof entry.turn === "string" && entry.turn !== "") noted.add(entry.turn);
    else if (texSend(entry)) (entry.delivered === false ? unsaid : said).add(entry.turn);
  }
  for (const turn of said) unsaid.delete(turn);
  return { noted, said, unsaid };
}

/** A Tex text event a note already stands for (same turn): a reader that shows the note skips it. */
export function isLinkedText(entry, links) {
  return texSend(entry) && links.noted.has(entry.turn);
}

/** A note whose send was recorded and not delivered: never shown as said. */
export function isUnsentNote(entry, links) {
  return entry?.kind === "note" && typeof entry.turn === "string" && links.unsaid.has(entry.turn);
}

/** A routine's note that was kept and not texted (`send: note`, `finishARoutine.js`): never shown as a sent text. */
export const keptNotTexted = (entry) => entry?.kind === "note" && entry.send === "note";

/** A Tex text event that was recorded undelivered, sent on its own: it was never said, and its note is not shown. */
export function isUnsentText(entry, links) {
  return texSend(entry) && links.unsaid.has(entry.turn);
}

/** The gateway's note of each turn that has one (the last, if a run wrote more than one): `turn` to its note entry. */
export function notesByTurn(entries) {
  const notes = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) if (entry?.kind === "note" && typeof entry.turn === "string" && entry.turn !== "") notes.set(entry.turn, entry);
  return notes;
}

/**
 * What the record's own exchanges must not repeat: the words of every text Tex sent on its own that was not said (its
 * linked send undelivered, or the note kept and not texted), shaped as the chat's texts so `sentByItself.js` can match
 * them by words. A record exchange whose words these hold is not shown.
 */
export function notSaidOwn(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const links = linkedSends(list);
  const out = [];
  for (const entry of list) {
    if (isUnsentText(entry, links) || (isUnsentNote(entry, links) || keptNotTexted(entry))) out.push({ from: { kind: "tex" }, kind: "text", text: String(entry.text ?? ""), turn: entry.turn });
  }
  return out;
}

/** A chat's text entries as said: one Tex sent on its own that never went out is left out (the Lab's rows, `labSandbox/route.js`). */
export function saidTexts(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const links = linkedSends(list);
  return list.filter((entry) => entry?.kind === "text" && !isUnsentText(entry, links));
}
