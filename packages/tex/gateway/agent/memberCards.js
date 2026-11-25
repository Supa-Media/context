/**
 * A GROUP CHAT'S TURN READS THE MEMBER CARDS OF THE PEOPLE IN THE ROOM (decided by the owner, Sayo, 2026-11-24;
 * `docs/decisions/texting-assistant/member-cards.md`).
 *
 * Each person's card is `tex/group-card.md` in their own personal workspace (`groupCard.js`): hints their own Tex wrote
 * for groups. Code reads them, never the model: the control plane names whose (`controlPlane.memberCardHomes`, on an
 * account holder's own tag only), this turn's chat must name each of them among its people too, and each card is read
 * from that person's object by the one call that answers it alone (`texStore/desk.js` `readCard`). No guest chat, no
 * chat with anyone in it who has no account, and never a turn whose tagger isn't an account holder.
 *
 * The turn is told the lines under each person's handle, as hints to plan with and never to say (`cardsPrompt`). The
 * words are never kept in the chat's records (`promptManifest.js` `UNKEPT_MODULES`), and the node logs counts only.
 */

import { callTexStore, texStoreStub } from "../texStore/wire.js";
import { parseCard } from "./groupCard.js";

/** The prompt part the cards are said in (`runTheModel.js` `threadNote`), never kept (`promptManifest.js`). */
export const CARDS_PART = "cards";
/** How long one person's card may take before the turn goes on without it. */
export const CARD_READ_MS = 1_500;

const HANDLE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const WORKSPACE = /^[A-Za-z0-9_-]{1,64}$/;

/** Whether this turn may read cards at all: a group's, with an account holder's tag, and nobody here without an account. */
export function cardsAllowed(group) {
  if (group === null || typeof group !== "object") return false;
  if (group.guestChat === true || group.guestTagger === true || !group.from) return false;
  if (Array.isArray(group.guests) && group.guests.length > 0) return false;
  return true;
}

/** One person's card lines, or null when it is missing, off, unreadable or late. Never throws. */
async function oneCard(env, workspaceId, ms) {
  const stub = texStoreStub(env, { person: workspaceId });
  if (stub === null) return null;
  let timer;
  try {
    const read = callTexStore(stub, "card").then((response) => response.json());
    const late = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    });
    const answer = await Promise.race([read.catch(() => null), late]);
    const text = answer?.card?.text;
    if (typeof text !== "string") return null;
    const card = parseCard(text);
    return card.off || card.lines.length === 0 ? null : card.lines;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The cards of the people in this room, `[{ handle, lines }]` in the order the control plane named them, or null when
 * this turn reads none. `asked` counts the people the control plane named, `read` those with a card.
 */
export async function readMemberCards({ env, controlPlane, session, group, ms = CARD_READ_MS }) {
  if (!cardsAllowed(group) || typeof controlPlane?.memberCardHomes !== "function" || typeof session?.accessToken !== "string") return null;
  let homes;
  try {
    homes = await controlPlane.memberCardHomes(session.accessToken);
  } catch {
    return null;
  }
  if (!Array.isArray(homes)) return null;
  // This turn's own room as well as the control plane's: a person the chat doesn't name here now is nobody's card.
  const here = new Set([group.from, ...(Array.isArray(group.people) ? group.people : [])].filter((handle) => typeof handle === "string"));
  const named = homes.filter((home) => HANDLE.test(home?.handle ?? "") && WORKSPACE.test(home?.workspaceId ?? "") && here.has(home.handle));
  const cards = await Promise.all(named.map(async (home) => ({ handle: home.handle, lines: await oneCard(env, home.workspaceId, ms) })));
  return { asked: named.length, cards: cards.filter((card) => card.lines !== null) };
}

/** What the turn is told, or "" when nobody here has a card. */
export function cardsPrompt(read) {
  const cards = Array.isArray(read?.cards) ? read.cards : [];
  if (cards.length === 0) return "";
  return [
    "",
    "What the people here let you use: each person's own Tex wrote these from what they told it, for planning with them in a group. " +
      "They are not things anyone said here.",
    ...cards.map((card) => `@${card.handle}: ${card.lines.join("; ")}`),
    "Plan around them without being asked: pick what works for everyone. When the chat proposes something a line doesn't fit " +
      "(a bar crawl, a spicy place, a pricey night), go along and add an option that works for that person too, offered as one " +
      "more idea for the whole group. Never quote one, explain one, hint at the reason behind one, or say who told you or that " +
      "you were told. If someone asks why, say it's what works for the group. " +
      "What someone says in this chat is the chat's: you may answer with what was said here, even about someone else, and only that.",
    "",
  ].join("\n");
}
