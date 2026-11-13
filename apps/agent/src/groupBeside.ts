/**
 * What is answered while a handed turn holds the chat (`groupTurnRun.ts`):
 * messages code answers alone, with a fixed line and never the model. The
 * group review of 2026-10-30: "tex, settings" waited four minutes behind
 * another turn, though its menu needs nothing that turn has.
 *
 * Only these, never a model turn (those run side by side up to the chat's cap, `groupTurnRun.ts`): the commands
 * (`groupCommand`, which the control plane answers with no grant to mint)
 * and an SMS group's fixed line. A yes, a 👍, a routine's run or a job's report
 * still waits: each is a model turn.
 */

import { groupCommand } from "./groupWords";
import { answerInline, type GroupDeps } from "./groupInbox";
import type { GroupEntry, GroupPending } from "./groupTurn";
import type { InboxStorage } from "./inbox";

/** Whether code answers this waiting message alone, with no model turn (`answerGroup` returns before it asks the gateway). */
export function answeredByCode(item: GroupPending): boolean {
  if (item.message.routine !== undefined || item.message.reaction !== undefined || item.message.jobReport !== undefined) return false;
  // An SMS still waiting on the judge's first look is not code's yet (`groupTurn.ts` `firstLook`).
  if ((item.message.sms === true && item.look !== true)) return true;
  return item.byCode === true && groupCommand(item.message.text) !== null;
}

/** Answer, oldest first, each waiting message code answers alone that no handed turn (`keys`) holds. True when one failed and waits for its retry. */
export async function answerBesideTurn(storage: InboxStorage, deps: GroupDeps, keys: readonly string[]): Promise<boolean> {
  const waiting: GroupEntry[] = [...(await storage.list<GroupPending>({ prefix: "gpending:" }))];
  for (const entry of waiting) {
    if (keys.includes(entry[0]) || !answeredByCode(entry[1])) continue;
    console.log(JSON.stringify({ event: "group_turn", outcome: "beside_turn" }));
    // A retry is set for it (the alarm, RETRY_MS): the rest wait for that alarm too.
    if (await answerInline(storage, [entry], deps)) return true;
  }
  return false;
}
