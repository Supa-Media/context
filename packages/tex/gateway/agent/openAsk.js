/**
 * THE OPEN ASK (Dev2, 2026-11-12, the Nov Babies chat).
 *
 * "Karaoke maybe? something fun" got an answer that was all karaoke, and the
 * job started for it came back all karaoke too: the reviewer only checked the
 * newest text, and the job and its done check only read the front door's
 * brief, which listed the karaoke finds to "verify and use".
 *
 * The open ask is their texts that Tex hasn't answered yet, before the one it
 * is answering now: walking back from the newest, every text of theirs, past
 * any Tex text that only asked them something back ("Which city?"), until a
 * Tex text that answered, or a text more than `OPEN_FOR_MS` old. Code finds
 * it, never a model. The reviewer reads it as the whole ask (`replyJudge.js`
 * `missed_ask`), and a job started this turn is handed it word for word
 * beside the brief, so the job and its done check judge against what they
 * said (`background.js`, `jobCheck.js`).
 */

/** How far back an open ask reaches, and how many of their texts it keeps. */
export const OPEN_FOR_MS = 3 * 60 * 60 * 1_000;
export const MAX_OPEN_TEXTS = 6;
const MAX_TEXT_CHARS = 1_000;

/** A Tex text that only asked something back, so what they asked before it is still open. */
const asksBack = (text) => /\?\s*$/.test(text);

/**
 * Their texts still open before this one, oldest first. `history` is the
 * chat as turns (`{ role, text, at }`), oldest first, without the text being
 * answered now. A turn with no time counts as recent.
 */
export function openAsk(history, { now = null } = {}) {
  const turns = Array.isArray(history) ? history : [];
  const open = [];
  for (let index = turns.length - 1; index >= 0 && open.length < MAX_OPEN_TEXTS; index -= 1) {
    const turn = turns[index];
    const text = typeof turn?.text === "string" ? turn.text.trim() : "";
    if (turn?.role === "assistant") {
      if (text === "" || asksBack(text)) continue;
      break;
    }
    if (turn?.role !== "user") continue;
    if (Number.isFinite(now) && Number.isFinite(turn.at) && now - turn.at > OPEN_FOR_MS) break;
    if (text !== "") open.unshift(text.slice(0, MAX_TEXT_CHARS));
  }
  return open;
}

/** `openAsk` of a history that may already end with their text now (`question`), which is left out. */
export function openAskBefore(history, question, options = {}) {
  const turns = Array.isArray(history) ? history : [];
  const last = turns.at(-1);
  const now = String(question ?? "").trim();
  return openAsk(last?.role === "user" && now !== "" && String(last.text ?? "").trim() === now ? turns.slice(0, -1) : turns, options);
}
