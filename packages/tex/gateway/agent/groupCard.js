/**
 * A PERSON'S MEMBER CARD: WHAT THEIR OWN TEX LETS A GROUP CHAT'S TEX USE, AND NEVER SAY (decided by the owner, Sayo,
 * 2026-11-24; `docs/decisions/texting-assistant/member-cards.md`).
 *
 * `tex/group-card.md` in their own personal workspace: a few lines their Tex wrote from About me, under the five
 * classes, for planning with them in a group (a diet, a schedule, what they like; a sensitive need as the need, never
 * the reason; never a secret or anything about somebody else). They can read it, change it or delete it. A group turn
 * reads it by its key from their object (`memberCards.js`), never their About me.
 *
 * Written here, by the `groupCard` node (`graph/nodes/groupCard.js`), after the Learn step, only when About me has
 * changed since the card was written: the card ends with About me's fingerprint, in a comment. The model writes the lines; code
 * keeps only lines it would let any group read (`cardLineRefused`) and writes the note through the session's own
 * `write_note`, so the write is attributed and kept in the note's history like any other.
 */

import { readAboutMe } from "./aboutMe.js";
import { readWithEtag } from "./jobLog.js";
import { fingerprint } from "./promptManifest.js";

export const GROUP_CARD_PATH = "tex/group-card.md";

/** Bounds on what any group is told of one person, whatever the model or the person wrote. */
export const MAX_CARD_LINES = 30;
export const MAX_CARD_LINE_CHARS = 160;
const MAX_CARD_CHARS = 3_000;
const NONE = "NONE";

const PHONE = /\+?\d[\d\s().-]{6,}\d/;
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const MONEY = /[$£€¥₦]\s?\d|\d\s?(?:k\b|dollars?\b|usd\b|bucks\b|pounds?\b|naira\b)/i;
const LINK = /\bhttps?:\/\//i;
/** Where the card says which About me it was made from: a comment, so the note reads as plain lines. */
const FROM = /<!-- from About me ([0-9a-f]{8}) -->/;

/** Why a card line is never kept, or null: too long, or a phone number, an email, an amount of money or a link. */
export function cardLineRefused(line) {
  if (typeof line !== "string" || line.trim() === "") return "empty";
  if (line.length > MAX_CARD_LINE_CHARS) return "long";
  if (PHONE.test(line)) return "phone";
  if (EMAIL.test(line)) return "email";
  if (MONEY.test(line)) return "money";
  if (LINK.test(line)) return "link";
  return null;
}

/** The fingerprint of the About me the card was made from, and its lines, from the note's text. */
export function parseCard(text) {
  const body = String(text ?? "");
  const from = FROM.exec(body)?.[1] ?? null;
  // `off` on a line of its own: they asked for none of it to reach a group, and Tex stops keeping it.
  if (/^\s*off\s*$/im.test(body)) return { from, lines: [], off: true };
  const lines = [];
  let chars = 0;
  for (const raw of body.split("\n")) {
    const match = /^\s*[-*]\s+(.+?)\s*$/.exec(raw);
    if (match === null || cardLineRefused(match[1]) !== null) continue;
    if (lines.length >= MAX_CARD_LINES || chars + match[1].length > MAX_CARD_CHARS) break;
    lines.push(match[1]);
    chars += match[1].length;
  }
  return { from, lines, off: false };
}

/** The note as it is written: the fingerprint it was made from, what it is, and its lines. */
export function renderCard(from, lines) {
  return [
    "# What Tex may use for you in group chats",
    "",
    "Your Tex keeps this from About me. In a group chat with you, Tex may plan around these lines, and never quotes them, " +
      "explains them or says where they came from. Change or delete any line. Write off on a line by itself and Tex stops " +
      "keeping it, and no group chat uses any of it.",
    "",
    ...lines.map((line) => `- ${line}`),
    "",
    `<!-- from About me ${from} -->`,
    "",
  ].join("\n");
}

/** What the model is asked: About me, the card as it stands (the person may have changed it), and the classes. */
export function cardQuestion(about, current) {
  return [
    "This is not a text from a person. Nobody is waiting, and nothing you say is texted to anyone.",
    "Below is About me, what you know about the person you text. Write their member card: short lines a group chat's Tex may " +
      "use to plan with them, with their friends there, without ever saying them. Sort each fact by what it is:",
    "- Open or everyday (what they'd tell anyone: a diet, a schedule pattern, what they like, their city): keep it as a short line.",
    "- Personal (their job, their family, their plans): keep it only when it helps plan with them and reads fine said to a group of friends.",
    "- Sensitive (health, money, drinking or drugs, religion, sexuality, relationships, anything they'd be embarrassed by): keep only " +
      "the need, never the reason. \"Eats mild food\", never the condition. \"Prefers places with good non-drinking options\", never why.",
    "- Secret, anything they asked you to keep, and anything about another person (an ex, somebody else's news): never.",
    "Never a phone number, an email, an address, an amount of money or a link. One fact per line, under 120 characters.",
    current.length > 0
      ? "The card as it stands is below too; they may have changed it. Keep its lines unless About me no longer supports them, and never add back what About me says to keep private."
      : "",
    `Answer only the lines, each starting with "- ", at most ${MAX_CARD_LINES}. If nothing in About me helps plan with them, answer exactly ${NONE}.`,
    `## About me\n\n${about.trim()}`,
    current.length > 0 ? `## The card as it stands\n\n${current.map((line) => `- ${line}`).join("\n")}` : "",
  ]
    .filter((part) => part !== "")
    .join("\n\n");
}

const refuseAll = async () => ({ isError: true, content: [{ type: "text", text: "No tools here: answer with the lines." }] });

/**
 * Keep the card in step with About me. `ask(question, callTool)` runs the model and answers its text (the node's
 * `runTurn`). Never throws. `{ outcome }`: "no_about", "unread" (the card could not be read, so nothing is written over
 * it), "off" (they turned it off), "fresh" (About me has not changed since), "none" (nothing to keep: an empty card is written), "wrote", or
 * "failed", with `lines` and `refused` counts, never a line's words.
 */
export async function keepGroupCard({ dispatch, ask }) {
  try {
    const about = await readAboutMe(dispatch);
    if (about.trim() === "") return { outcome: "no_about" };
    const from = fingerprint(about.trim());
    const seen = await readWithEtag(dispatch, GROUP_CARD_PATH);
    if (seen === null) return { outcome: "unread" };
    const current = seen.missing ? { from: null, lines: [], off: false } : parseCard(seen.body);
    if (current.off) return { outcome: "off" };
    if (current.from === from) return { outcome: "fresh" };
    const answer = String((await ask(cardQuestion(about, current.lines), refuseAll)) ?? "").trim();
    const said = answer === NONE ? [] : answer.split("\n").map((raw) => /^\s*[-*]\s+(.+?)\s*$/.exec(raw)?.[1] ?? null).filter((line) => line !== null);
    const lines = parseCard(said.map((line) => `- ${line}`).join("\n")).lines;
    const written = await dispatch("write_note", {
      path: GROUP_CARD_PATH,
      content: renderCard(from, lines),
      ...(seen.missing ? {} : { expected_etag: seen.etag }),
    });
    if (written?.isError === true) return { outcome: "failed", where: "write" };
    return { outcome: lines.length === 0 ? "none" : "wrote", lines: lines.length, refused: said.length - lines.length };
  } catch (error) {
    return { outcome: "failed", where: typeof error?.name === "string" ? error.name : "error" };
  }
}
