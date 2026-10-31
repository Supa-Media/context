/**
 * What is answered while a handed turn holds the chat (`groupTurnRun.ts`):
 * messages code answers alone, with a fixed line and never the model. The
 * group review of 2026-10-30: "tex, settings" waited four minutes behind
 * another turn, though its menu needs nothing that turn has.
 *
 * Only these, so a chat still runs one model turn at a time: "Tex, settings"
 * and the other commands (`groupCommand`, which the control plane answers
 * with no grant to mint), a reply to the settings menu, a style choice, and
 * an SMS group's fixed line. A yes, a 👍, a routine's run or a job's report
 * still waits: each is a model turn.
 */

import { groupCommand } from "./groupWords";
import { answerInline, type GroupDeps } from "./groupInbox";
import type { GroupEntry, GroupPending } from "./groupTurn";
import type { InboxStorage } from "./inbox";

/** Whether code answers this waiting message alone, with no model turn (`answerGroup` returns before it asks the gateway). */
export function answeredByCode(item: GroupPending, choices: readonly string[]): boolean {
  if (item.message.routine !== undefined || item.message.reaction !== undefined || item.message.jobReport !== undefined) return false;
  if (item.message.sms === true || item.setting !== undefined || item.engagement !== undefined) return true;
  return item.byCode === true && groupCommand(item.message.text, choices) !== null;
}

/** Answer, oldest first, each waiting message code answers alone that the handed turn (`keys`) does not hold. */
export async function answerBesideTurn(storage: InboxStorage, deps: GroupDeps, keys: readonly string[], choices: readonly string[]): Promise<void> {
  const waiting: GroupEntry[] = [...(await storage.list<GroupPending>({ prefix: "gpending:" }))];
  for (const entry of waiting) {
    if (keys.includes(entry[0]) || !answeredByCode(entry[1], choices)) continue;
    console.log(JSON.stringify({ event: "group_turn", outcome: "beside_turn" }));
    // A retry is set for it (the alarm, RETRY_MS): the rest wait for that alarm too.
    if (await answerInline(storage, [entry], deps)) return;
  }
}
