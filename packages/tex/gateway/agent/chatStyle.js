/**
 * HOW THIS CHAT TEXTS, COUNTED (Dev2, 2026-11-25: Tex should match the flow, energy and style of the people in each
 * 1:1 and group chat: their casing, length, pace and emoji, adding none until they do).
 *
 * The front door already reads the chat word for word, but Haiku wrote in one house style whatever the chat looked
 * like: its examples are all in sentence case, and nothing said how these people write. This counts it, from their own
 * recent texts in the chat's ledger, and hands the counts to the front door as data, in its per-text facts
 * (`runTheModel.js` turnNote). How to use them is taught by the voice modules and Training, never by words here
 * (`docs/decisions/texting-assistant/no-scripted-wording.md`).
 *
 * Only people's texts are counted, never Tex's own: mirroring itself would freeze whatever it wrote first. In a group,
 * the room is everyone together, and each person is counted alone too, by the label the transcript shows them under.
 */
import { asEvent } from "./ledgerHistory.js";
import { speaker } from "./logRender.js";

/** The newest people's texts counted, how far back, and the most people and emoji named. */
export const STYLE_TEXTS = 40;
export const STYLE_DAYS = 14;
export const STYLE_PEOPLE = 8;
export const STYLE_EMOJI = 8;
/** How many ledger entries one read asks for: Tex's texts and the people's share it. */
const READ_LIMIT = 200;
const DAY_MS = 86_400_000;

const LETTER = /\p{L}/u;
const EMOJI = /\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*/gu;
const LINK = /\bhttps?:\/\/\S+/giu;

/** The counts of one set of texts: how many, how many start in lowercase, end on a full stop, hold a "!", the median words, the emoji used. */
export function countStyle(texts) {
  const list = texts.map((text) => String(text ?? "").replace(LINK, "").trim()).filter((text) => text !== "");
  const lettered = list.filter((text) => LETTER.test(text));
  const words = list.map((text) => text.split(/\s+/u).filter(Boolean).length).sort((a, b) => a - b);
  const emoji = [];
  for (const text of list) for (const found of text.match(EMOJI) ?? []) if (!emoji.includes(found) && emoji.length < STYLE_EMOJI) emoji.push(found);
  return {
    texts: list.length,
    startsLowercase: lettered.filter((text) => /\p{Ll}/u.test(text.match(LETTER)[0])).length,
    endsWithFullStop: lettered.filter((text) => text.endsWith(".") && !text.endsWith("..")).length,
    hasExclamation: list.filter((text) => text.includes("!")).length,
    medianWords: words.length === 0 ? 0 : words[Math.floor((words.length - 1) / 2)],
    emoji,
  };
}

/**
 * The chat's style from its events (oldest first or not): `{ room, people? }`, `people` only in a group, keyed by the
 * transcript's label; null when no person has texted in the span.
 */
export function styleOf(events, { group = false, now = Date.now() } = {}) {
  const since = now - STYLE_DAYS * DAY_MS;
  const theirs = (Array.isArray(events) ? events : [])
    .filter((event) => event?.from?.kind === "person" && event.kind === "text" && event.unsent !== true && typeof event.text === "string" && Number.isFinite(event.at) && event.at >= since)
    .sort((a, b) => a.at - b.at)
    .slice(-STYLE_TEXTS);
  if (theirs.length === 0) return null;
  const room = countStyle(theirs.map((event) => event.text));
  if (!group) return { room };
  const byPerson = new Map();
  for (const event of theirs) {
    const who = speaker(event.from);
    if (!byPerson.has(who)) byPerson.set(who, []);
    byPerson.get(who).push(event.text);
  }
  const people = Object.fromEntries([...byPerson].sort((a, b) => b[1].length - a[1].length).slice(0, STYLE_PEOPLE).map(([who, texts]) => [who, countStyle(texts)]));
  return { room, people };
}

/** The style as the front door's facts read it: a tagged block of data, "" when there is none. */
export function styleFacts(style) {
  if (style === null || typeof style !== "object" || !style.room) return "";
  return `<chat_style>\n${JSON.stringify(style)}\n</chat_style>`;
}

/** The chat's style read from its ledger (`ledger.read`), or null: no ledger, nothing said, or a read that failed. */
export async function readChatStyle(ledger, chat, { group = false, now = Date.now() } = {}) {
  if (ledger === null || typeof ledger?.read !== "function" || typeof chat !== "string") return null;
  const read = await ledger.read(chat, { before: Number.MAX_SAFE_INTEGER, kinds: ["text"], limit: READ_LIMIT, slim: true, since: now - STYLE_DAYS * DAY_MS });
  return styleOf((read?.entries ?? []).map((entry) => asEvent(entry, chat)), { group, now });
}
