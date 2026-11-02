/**
 * "Tex, settings" in a group (`texStyle.ts`, Dev2, 2026-11-01): the menu, a
 * member's reply to it, or plain words ("Tex, no emoji"). Any member may
 * change the group's instructions or progress updates, as they may when Tex
 * speaks up (`groupChoose.ts`), and Tex says who did so anyone can undo it.
 * Choice 1 is the speak-up question itself (`groupStyle.ts`). A yes or no to
 * sharing chats with the devs is answered here too, as the sender's own
 * (`reviewSharing.ts`).
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
import { closeMenu, menuReply, menuState, NOTHING_TO_UNDO, openMenu, saveGroupStyle, settingChoices, settingSaid, settingsMenu, type SettingReply } from "./texStyle";

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
  const settings = { ...(asked.instructions ? { instructions: asked.instructions } : {}), ...(asked.updates ? { updates: asked.updates } : {}) };
  if (command?.kind === "settings") {
    await openMenu(storage, deps.now());
    return void (await fixed(settingsMenu(settings, STYLE_NAMES[(await groupStyle(storage)).style])));
  }
  if (setting?.kind === "menu") {
    if (setting.step === "engagement") {
      await closeMenu(storage);
      await openQuestion(storage, deps.now());
      return void (await fixed(ENGAGEMENT_QUESTION));
    }
    await openMenu(storage, deps.now(), setting.step);
    return void (await fixed(settingChoices(setting.step, settings)));
  }
  const ask = command?.kind === "style" ? command.ask : setting?.kind === "set" ? setting.ask : null;
  if (ask === null) return;
  await closeMenu(storage);
  const setBy = asked.handle ?? asked.guests?.find((entry) => entry.phone === message.from)?.label ?? "someone here";
  const saved = await saveGroupStyle(deps.fetch, deps.controlPlaneOrigin, deps.workerSecret, message.line, message.groupId, ask, setBy);
  if (saved === null) throw new ServiceError("control_plane", null);
  await fixed(saved === "nothing_to_undo" ? NOTHING_TO_UNDO : settingSaid(ask, saved, setBy));
}
