/**
 * isItForTex: the door's first step, run in the chat's own queue for a 1:1
 * chat and a group alike (Dev2's one-door plan, 2026-11-05, "Chat's queue,
 * same steps"; drawn in `docs/architecture/tex.md`). It runs here, before the
 * gateway, because a group's chatter must never mint a grant to be read.
 *
 * It answers two questions about one incoming text:
 *  - is it for Tex: a 1:1 text always is; in a group, only one addressed to
 *    Tex, the asker's yes, a style choice or a settings reply is (the rest is
 *    chat the group's style may still put to decide, `groupInbox.ts`);
 *  - is it code's to answer, never the model's: an SMS (anyone can fake its
 *    sender), a yes Tex asked for, a settings or style choice, a command.
 */

import { sha256Hex } from "./groupChat";
import { SENT_KEY } from "./groupSay";
import { groupSettingReply } from "./groupSettings";
import { engagementChoice, questionOpen } from "./groupStyle";
import { addressesTex, groupCommand, namesTex, unquoted } from "./groupWords";
import type { GroupStyle } from "./decide";
import type { InboxStorage } from "./inbox";
import { decidedByCode } from "./inboxTurn";
import type { Message } from "./reply";
import type { GroupMessage } from "./sendblueGroups";
import { isSettingsText, type SettingReply } from "./texStyle";

/** What the step found: whether the text is for Tex, and whether code answers it. */
export type ForTex = { forTex: boolean; byCode: boolean };

/** A 1:1 text: always for Tex. A settings text is marked so code answers it before decide (`texStyle.ts`). */
export async function isItForTexAlone(storage: InboxStorage, message: Message, now: number): Promise<ForTex & { message: Message }> {
  // An SMS never sets a setting: anyone can send one that shows their number.
  if (!message.sms && !message.tapback && (await isSettingsText(storage, message.text, now))) message = { ...message, setting: true };
  return { forTex: true, byCode: decidedByCode(message), message };
}

/** How long a yes Tex asked for stays the asker's to give without its name. */
export const ASK_OPEN_MS = 30 * 60_000;
export const ASK_KEY = "gask";
export type OpenAsk = { from: string; at: number };
/** Words that only answer a yes Tex asked for: a yes, a no, or "send it" (`apps/mcp/src/agent/textedApprovals.js` decides what they settle). A bare "ok" stays chat: it is not a yes to a send there, and would only disarm the ask. */
const ANSWERS_ASK =
  /^\s*(?:yes|yes please|yep|yeah|yup|y|no|nope|cancel|send|send it|send that|file it|do it|go ahead|looks good)(?:[\s,.!-]+(?:send it|send|please|file it|do it|go ahead))*\s*[.!]*\s*$/i;

/** Whether this is from the person Tex last asked for a yes, while that ask is open. */
export async function isAsker(storage: InboxStorage, message: GroupMessage, now: number): Promise<boolean> {
  const ask = await storage.get<OpenAsk>(ASK_KEY);
  return ask !== undefined && now - ask.at < ASK_OPEN_MS && ask.from === (await sha256Hex(message.from));
}

/**
 * A group text. `answeringTex`: a reaction that answers Tex's own question
 * (`groupInbox.ts` `acceptReaction`), answered as a message to Tex is (the 1:1's, #2469).
 */
export async function isItForTexInGroup(
  storage: InboxStorage,
  message: GroupMessage,
  now: number,
  answeringTex: boolean,
): Promise<ForTex & { repliesToTex: boolean; engagement: GroupStyle | null; setting: SettingReply | null }> {
  const sent = (await storage.get<string[]>(SENT_KEY)) ?? [];
  const repliesToTex = message.replyTo !== undefined && sent.includes(message.replyTo);
  // A bare yes, no or "send" from the person Tex just asked, while that ask is open (Dev2's "yes" to the bug report,
  // 2026-10-21, kept as chat). Anyone else's is chat: only the asker's yes can release what was held for them.
  const yes = ANSWERS_ASK.test(unquoted(message.text)) && (await isAsker(storage, message, now));
  // An SMS never sets the style: anyone can send one that shows a member's number.
  const engagement = !message.sms && (await questionOpen(storage, now)) ? engagementChoice(message.text) : null;
  const setting = !message.sms && engagement === null ? await groupSettingReply(storage, message.text, now) : null;
  // A reply to one of Tex's texts that says more than thanks is addressed: its turn starts at once, decide beside it (Dev2, 2026-11-01, superseding 2026-10-27's decide-first).
  // A voice message is addressed by what it says (`groupVoice.ts`): said aloud, Tex's name anywhere is the tag, since decide can't hear it.
  const heard = message.reaction === undefined && message.heard !== undefined && (addressesTex(message.heard, repliesToTex) || namesTex(message.heard));
  const addressed = message.reaction === undefined ? addressesTex(message.text, repliesToTex) || heard : answeringTex;
  const forTex = addressed || yes || engagement !== null || setting !== null;
  // Never the model's: an SMS (anyone can fake its sender), the asker's yes, a style choice, a command.
  const byCode = message.sms === true || yes || engagement !== null || setting !== null || (addressed && groupCommand(message.text) !== null);
  return { forTex, byCode, repliesToTex, engagement, setting };
}
