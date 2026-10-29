/**
 * "Tex, settings" in a group (`texStyle.ts`, Dev2, 2026-10-28): the menu, a
 * member's reply to it, or plain words ("Tex, humor 60%"). Any member may
 * change the group's style, as they may its engagement (`groupChoose.ts`), and
 * Tex says who did. Choice 1 is the engagement question itself
 * (`groupStyle.ts`). A yes or no to sharing chats with the devs is answered
 * here too, as the sender's own (`reviewSharing.ts`).
 */

import { ServiceError } from "./clients";
import type { ControlAnswer } from "./groupControl";
import type { GroupDeps } from "./groupInbox";
import { say } from "./groupSay";
import { saveReviewSharing, sharingReply } from "./reviewSharing";
import { ENGAGEMENT_QUESTION, groupStyle, openQuestion, STYLE_NAMES } from "./groupStyle";
import type { Command } from "./groupWords";
import type { InboxStorage } from "./inbox";
import type { GroupMessage } from "./sendblueGroups";
import { closeMenu, menuReply, menuState, openMenu, saveGroupStyle, settingChoices, settingsMenu, styleSet, type SettingReply } from "./texStyle";

/** A reply to the group's open menu, as of `now`, or null when the menu is closed or the words aren't one. */
export async function groupSettingReply(storage: InboxStorage, text: string, now: number): Promise<SettingReply | null> {
  const state = await menuState(storage, now);
  return state === undefined ? null : menuReply(text, state, true);
}

/** Answer a settings command or menu reply in the group. */
export async function groupSettings(
  storage: InboxStorage,
  deps: GroupDeps,
  message: GroupMessage,
  command: Command | null,
  setting: SettingReply | undefined,
  asked: Extract<ControlAnswer, { status: "ready" }>,
): Promise<void> {
  const fixed = (text: string) => say(storage, deps, message, text, { system: true });
  // "Tex, share my chats with the devs" here: the sender's own yes, and whether the whole chat counts (`reviewSharing.ts`).
  if (command?.kind === "review_sharing") {
    const others = [...new Set([...message.participants, message.from])].filter((phone) => phone !== message.line);
    const answer = await saveReviewSharing(deps.fetch, deps.controlPlaneOrigin, deps.workerSecret, message.from, command.sharing, others);
    return void (await fixed(sharingReply(command.sharing, answer, { inGroup: true })));
  }
  const style = asked.texStyle ?? {};
  if (command?.kind === "settings") {
    await openMenu(storage, deps.now());
    return void (await fixed(settingsMenu(style, STYLE_NAMES[(await groupStyle(storage)).style])));
  }
  if (setting?.kind === "menu") {
    if (setting.step === "engagement") {
      await closeMenu(storage);
      await openQuestion(storage, deps.now());
      return void (await fixed(ENGAGEMENT_QUESTION));
    }
    await openMenu(storage, deps.now(), setting.step);
    return void (await fixed(settingChoices(setting.step, style)));
  }
  const patch = command?.kind === "style" ? command.patch : setting?.kind === "set" ? setting.patch : null;
  if (patch === null) return;
  await closeMenu(storage);
  const setBy = asked.handle ?? asked.guests?.find((entry) => entry.phone === message.from)?.label ?? "someone here";
  const saved = await saveGroupStyle(deps.fetch, deps.controlPlaneOrigin, deps.workerSecret, message.line, message.groupId, patch, setBy);
  if (saved === null) throw new ServiceError("control_plane", null);
  await fixed(styleSet(patch, setBy));
}
