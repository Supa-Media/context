/**
 * isItForTex: the door's first step, run in the chat's own queue for a 1:1
 * chat and a group alike (Dev2's one-door plan, 2026-11-05, "Chat's queue,
 * same steps"; drawn in `docs/architecture/tex.md`). It runs here, before the
 * gateway, because a group's chatter must never mint a grant to be read.
 *
 * It answers one question about one incoming text: is it code's to answer,
 * never a model's. An SMS (anyone can fake its sender), a settings or style
 * choice, a command said to Tex by name. Whether anything else is for Tex is
 * not decided here: it is the one judge's (`textDecide.cjs`, asked from
 * `groupTurn.ts`; Dev2, 2026-11-11), with no word rule in code.
 */

import { sha256Hex } from "./groupChat";
import { SENT_KEY } from "./groupSay";
import { commandTo } from "./groupWords";
import type { InboxStorage } from "./inbox";
import { decidedByCode } from "./inboxTurn";
import type { Message } from "./reply";
import type { GroupMessage } from "./sendblueGroups";
import { sharingWords } from "./reviewSharing";

/** What the step found: whether code answers the text (`forTex`: it is queued as code's, never judged), and whether code alone does. */
export type ForTex = { forTex: boolean; byCode: boolean };

/** A 1:1 text: always for Tex. Sharing chats with the devs is marked so code answers it before decide (`reviewSharing.ts`). */
export async function isItForTexAlone(_storage: InboxStorage, message: Message, _now: number): Promise<ForTex & { message: Message }> {
  // An SMS never sets a setting: anyone can send one that shows their number.
  if (!message.sms && !message.tapback && sharingWords(message.text) !== null) message = { ...message, setting: true };
  return { forTex: true, byCode: decidedByCode(message), message };
}

/** How long a yes Tex asked for stays the asker's to give: their thumb on the ask is held as their answer (`thumbs.ts`). */
export const ASK_OPEN_MS = 30 * 60_000;
export const ASK_KEY = "gask";
export type OpenAsk = { from: string; at: number };

/** Whether this is from the person Tex last asked for a yes, while that ask is open. */
export async function isAsker(storage: InboxStorage, message: GroupMessage, now: number): Promise<boolean> {
  const ask = await storage.get<OpenAsk>(ASK_KEY);
  return ask !== undefined && now - ask.at < ASK_OPEN_MS && ask.from === (await sha256Hex(message.from));
}

/**
 * A group text: code's when it is a command said to Tex by name; anything else goes to the judge (`forTex` false).
 * `repliesToTex`: it was typed under one of Tex's texts here, which the judge reads.
 */
export async function isItForTexInGroup(
  storage: InboxStorage,
  message: GroupMessage,
  _now: number,
): Promise<ForTex & { repliesToTex: boolean }> {
  const sent = (await storage.get<string[]>(SENT_KEY)) ?? [];
  const repliesToTex = message.replyTo !== undefined && sent.includes(message.replyTo);
  const forTex = message.reaction === undefined && commandTo(message.text) !== null;
  // Never the model's: a command.
  return { forTex, byCode: forTex, repliesToTex };
}
