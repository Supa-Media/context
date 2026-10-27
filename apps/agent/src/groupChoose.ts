/**
 * A member's answer to the style question (`groupStyle.ts`), saved for the
 * group by the control plane; moved out of `groupInbox.ts` whole.
 */

import { ServiceError } from "./clients";
import { setEngagement, type GroupStyle } from "./decide";
import type { ControlAnswer } from "./groupControl";
import type { GroupDeps } from "./groupInbox";
import { say } from "./groupSay";
import { closeQuestion, engagementSet, keepStyle } from "./groupStyle";
import { groupPendingKey as pendingKey, type GroupPending } from "./groupTurn";
import type { InboxStorage } from "./inbox";
import type { GroupMessage } from "./sendblueGroups";

/** A member chose the style: saved for the group, confirmed with who set it, then the message the question held is answered. */
export async function chooseStyle(storage: InboxStorage, deps: GroupDeps, message: GroupMessage, style: GroupStyle, asked: Extract<ControlAnswer, { status: "ready" }>): Promise<void> {
  const setBy = asked.handle ?? asked.guests?.find((entry) => entry.phone === message.from)?.label ?? "someone here";
  if (!(await setEngagement(deps, message.line, message.groupId, style, setBy))) throw new ServiceError("control_plane", null);
  await keepStyle(storage, style, true);
  await say(storage, deps, message, engagementSet(style, setBy), { system: true });
  const held = await closeQuestion<GroupPending>(storage);
  if (held === undefined) return;
  const seq = ((await storage.get<number>("gseq")) ?? 0) + 1;
  await storage.put("gseq", seq);
  await storage.put<GroupPending>(pendingKey(seq), { ...held, attempts: 0, byCode: true, styleAsked: true });
  await storage.setAlarm(deps.now());
}

