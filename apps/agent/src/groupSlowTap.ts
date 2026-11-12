/**
 * A tapback from code when Tex's answer is slow (Dev2, 2026-11-12, Nov Babies issue 6a).
 *
 * A group's tapback came only from the judge's react, so a chat with no verdict got none: a brand-new group's
 * first texts were refused `no_group` before the turn made its row, and Seyi, seeing nothing for 70 s, sent his
 * whole message again. Now a message that names Tex is armed here as it is accepted, and if no text and no
 * tapback of Tex's has gone into the chat `SLOW_TAP_MS` later, the Worker taps one on it, the emoji picked from
 * its words. A quick answer gets none, which keeps the "too many emojis" fix of 2026-11-10: a tapback only where
 * a text has not come.
 *
 * Only a chat bound to its people, and not muted, gets one: a chat Tex is not set up in, or one it will not
 * answer, is never tapped.
 */

import { ackEmoji } from "./ackEmoji";
import { isBound, isMuted } from "./groupChat";
import { groupLineFor, type GroupLineDeps } from "./groupLine";
import { reactionFor } from "./reactEmoji";
import type { InboxStorage } from "./inbox";
import type { GroupMessage } from "./sendblueGroups";

/** How long a message naming Tex waits for a text or tapback before code taps one. */
export const SLOW_TAP_MS = 8_000;
const PREFIX = "gslowtap:";

type Armed = { at: number; message: GroupMessage };

/** A message naming Tex, accepted at `now`: armed for a slow tapback. */
export async function armSlowTap(storage: InboxStorage, message: GroupMessage, now: number): Promise<void> {
  await storage.put<Armed>(`${PREFIX}${message.messageId}`, { at: now, message });
}

/** Whether `messageId` is armed, so the caller can keep the object alive for it (`index.ts`). */
export async function slowTapArmed(storage: InboxStorage, messageId: string): Promise<boolean> {
  return (await storage.get<Armed>(`${PREFIX}${messageId}`)) !== undefined;
}

/** Tex tapped this message: it needs no other. */
export async function tappedBy(storage: InboxStorage, messageId: string): Promise<void> {
  await storage.delete(`${PREFIX}${messageId}`);
}

/** Tex texted the chat: every message waiting on it has seen Tex is on it. */
export async function textedChat(storage: InboxStorage): Promise<void> {
  const armed = await storage.list<Armed>({ prefix: PREFIX });
  for (const key of armed.keys()) await storage.delete(key);
}

/** Once `SLOW_TAP_MS` has passed: tap the message if nothing of Tex's reached the chat since and the chat is one Tex answers. Whether it tapped. */
export async function slowTap(storage: InboxStorage, deps: GroupLineDeps, messageId: string, now: number): Promise<boolean> {
  const key = `${PREFIX}${messageId}`;
  const armed = await storage.get<Armed>(key);
  if (armed === undefined || now - armed.at < SLOW_TAP_MS) return false;
  await storage.delete(key);
  const { message } = armed;
  if ((await isMuted(storage)) || !(await isBound(storage, message))) return false;
  await groupLineFor(deps, message.groupId).react({ line: message.line, groupId: message.groupId }, message.messageId, reactionFor(undefined, ackEmoji(message.text)));
  console.log(JSON.stringify({ event: "group_slow_tap", waitedMs: now - armed.at }));
  return true;
}
