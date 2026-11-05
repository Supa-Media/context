/**
 * A VOICE MESSAGE'S WORDS, ON THE PERSON'S OWN LINE OF THE CHAT'S LEDGER
 * (Dev2, 2026-11-04: "one record of everything said, voice and relay
 * included, SHOULD be the history file").
 *
 * The texting Worker logs a voice message the moment it arrives, as a `file`
 * from the person with no words: nobody has heard it yet. The gateway hears it
 * inside the turn (`attachments.js` `hearVoiceMessages`), and until this the
 * words were kept only beside Tex's answer (the reply entry's `attached`),
 * which no turn's history reads. The next turn saw "@them: (a file)" and could
 * not know what had been asked (the 2026-11-04 morning chat: "email Joe" was
 * gone a turn later, and Tex answered an older question instead).
 *
 * So once the words are heard, the person's event is written again with them:
 * the same event id (`eid`), `heard: "voice"`, its text the words. The ledger
 * is append-only, so this is a newer entry for the same event, and every
 * reader takes an event's newest entry (`ledgerHistory.js`, `ledgerConversation.js`,
 * the History view), so the chat reads "@them: (a voice message) <words>" from
 * then on, in the one record, as theirs.
 *
 * Which event a voice message was: the turn's covered events that are a
 * person's file with no words. One such event takes every voice message the
 * turn heard (one text can carry several); as many events as voice messages
 * pair in order; anything else is left as it was and counted, never guessed.
 */

import { eventEntry } from "./ledger.js";

/** A heard voice message's words kept on its event, at most this long (as `attached` kept them). */
export const MAX_HEARD_CHARS = 3000;

/**
 * What the person said aloud this turn, as one string, or "" for nothing
 * heard: the transcription service's words, never the model's. A job the turn
 * starts is handed the person's own words as its question (`apps/agent/src/jobs.ts`
 * `jobQuestion`); a voice-only text has no typed words, so without these a
 * job started from a voice message was asked nothing and every part was
 * refused (2026-11-05, the Morocco trip job).
 */
export function heardWords(attachments) {
  const heard = (Array.isArray(attachments) ? attachments : []).filter((attachment) => attachment?.heard === true && !attachment.carried && typeof attachment.text === "string" && attachment.text.trim() !== "");
  return heard.map((attachment) => attachment.text.trim()).join(" ").slice(0, MAX_HEARD_CHARS);
}

const wordless = (event) => event?.from?.kind === "person" && event.kind === "file" && event.heard === undefined && String(event.text ?? "").trim() === "";

/**
 * The covered events restated with the words heard for them (`log.js` shape,
 * `heard: "voice"`), or none. `attachments` are the turn's, after hearing;
 * `covered` the person's events the turn answers (`loggedTurn.js`).
 */
export function heardEvents(attachments, covered) {
  const heard = (Array.isArray(attachments) ? attachments : []).filter((attachment) => attachment?.heard === true && !attachment.carried && typeof attachment.text === "string" && attachment.text.trim() !== "");
  const targets = (Array.isArray(covered) ? covered : []).filter(wordless);
  if (heard.length === 0 || targets.length === 0) return [];
  const said = (list) => list.map((attachment) => attachment.text.trim()).join(" ").slice(0, MAX_HEARD_CHARS);
  if (targets.length === 1) return [{ ...targets[0], text: said(heard), heard: "voice" }];
  if (targets.length === heard.length) return targets.map((event, index) => ({ ...event, text: said([heard[index]]), heard: "voice" }));
  console.log(JSON.stringify({ event: "tex_heard_unpaired", voices: heard.length, files: targets.length }));
  return [];
}

/** A restated event as a ledger entry: its `eid` the event's, its own entry id, so the append keeps it beside the first. */
export function heardEntry(event) {
  const entry = eventEntry(event);
  return { ...entry, id: `${entry.id}h` };
}
