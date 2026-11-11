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
import { groupSettingReply } from "./groupSettings";
import { engagementChoice, questionOpen } from "./groupStyle";
import { commandTo } from "./groupWords";
import type { GroupStyle } from "./decide";
import type { InboxStorage } from "./inbox";
import { decidedByCode } from "./inboxTurn";
import type { Message } from "./reply";
import type { GroupMessage } from "./sendblueGroups";
import { isSettingsText, type SettingReply } from "./texStyle";

/** What the step found: whether code answers the text (`forTex`: it is queued as code's, never judged), and whether code alone does. */
export type ForTex = { forTex: boolean; byCode: boolean };

/** A 1:1 text: always for Tex. A settings text is marked so code answers it before decide (`texStyle.ts`). */
export async function isItForTexAlone(storage: InboxStorage, message: Message, now: number): Promise<ForTex & { message: Message }> {
  // An SMS never sets a setting: anyone can send one that shows their number.
  if (!message.sms && !message.tapback && (await isSettingsText(storage, message.text, now))) message = { ...message, setting: true };
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
 * A group text: code's when it is a style choice, a settings reply or a command said to Tex by name; anything else
 * goes to the judge (`forTex` false). `repliesToTex`: it was typed under one of Tex's texts here, which the judge reads.
 */
export async function isItForTexInGroup(
  storage: InboxStorage,
  message: GroupMessage,
  now: number,
): Promise<ForTex & { repliesToTex: boolean; engagement: GroupStyle | null; setting: SettingReply | null }> {
  const sent = (await storage.get<string[]>(SENT_KEY)) ?? [];
  const repliesToTex = message.replyTo !== undefined && sent.includes(message.replyTo);
  // An SMS never sets the style: anyone can send one that shows a member's number.
  const engagement = !message.sms && (await questionOpen(storage, now)) ? engagementChoice(message.text) : null;
  const setting = !message.sms && engagement === null ? await groupSettingReply(storage, message.text, now) : null;
  const command = message.reaction === undefined && commandTo(message.text) !== null;
  const forTex = command || engagement !== null || setting !== null;
  // Never the model's: an SMS (anyone can fake its sender), a style choice, a setting, a command.
  return { forTex, byCode: forTex, repliesToTex, engagement, setting };
}
