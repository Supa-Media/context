/**
 * Old number? node "oldLine" (`texConfig.json`, Dev2's Photon switch, 2026-11-14): when staff have switched Tex's old
 * Sendblue line to `redirect` (staff console, Platform → Lines; `apps/convex/functions/texOldLine.ts`), a text that
 * arrives on it gets one short reply naming the new number, at most once a day per chat, and no turn. Every other text
 * passes on to Triage.
 *
 * No model and no reads: the texting Worker hands in the setting it read (`apps/agent/src/oldLine.ts`, cached a
 * minute) and when this chat was last told, and sends the reply itself, as it sends a check-in's (`notify`). Output
 * `to`: "redirect" with the reply in `answer`; "hold" for a text on the old line when this chat was told within the
 * day (no reply and no turn: the person has been told where Tex is); else "pass".
 */

import { archiveSentence, formatNumber } from "../../../../../../packages/shared/src/texNumber.cjs";

/** The one reply a chat gets, at most, in this many milliseconds. */
export const OLD_LINE_EVERY_MS = 24 * 60 * 60 * 1000;

const SENDBLUE_CHAT = /^sendblue:/;
const E164 = /^\+[1-9]\d{6,14}$/;

/**
 * @param {{ chatId: string, mode: string, number?: string | null, archiveOn?: string | null, lastToldAt?: number | null, now: number }} input
 */
export async function oldLineNode(input) {
  const { chatId, mode, number, archiveOn, lastToldAt, now } = input;
  if (mode !== "redirect" || typeof number !== "string" || !E164.test(number)) return { to: "pass" };
  if (!SENDBLUE_CHAT.test(chatId)) return { to: "pass" };
  if (typeof lastToldAt === "number" && now - lastToldAt < OLD_LINE_EVERY_MS) return { to: "hold" };
  return { to: "redirect", answer: `I've moved to ${formatNumber(number)}. Text me there instead, same Tex, same notes.${archiveSentence(archiveOn)}` };
}
