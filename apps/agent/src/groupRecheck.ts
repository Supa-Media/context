/**
 * A group answer's last look before it sends (the group review of
 * 2026-10-30): Tex answered a debugging question with a reply about saving a
 * playbook, drafted for an earlier ask. Decide decides once, when a turn
 * starts; nothing looked again before the reply went out.
 *
 * Now, when the asker has said more since the turn started and none of it was
 * folded into the turn (`steer.ts`), the control plane is asked whether the
 * draft still answers them (`recheck`, CONTRACT.md section 3b). Held, the
 * turn ends as a restart does: nothing it wrote is sent, its held asks are
 * withdrawn, and one new turn answers the old ask and the newer words
 * together. Each ask is rechecked once, so a chat that keeps typing still
 * gets an answer. Recheck unreachable or unsure: sent, as before.
 */

import type { ControlDeps } from "./decide";
import { groupStyle } from "./groupStyle";
import type { GroupPending } from "./groupTurn";
import type { InboxStorage } from "./inbox";
import { lookAgain, type Rechecked } from "./lookAgain";
import type { GroupMessage } from "./sendblueGroups";

export type { Rechecked };

/**
 * Whether the draft `text` written for `covers` (the turn's events, from
 * `message`'s sender, the newest of them in at `upTo`) still goes out: the
 * door's `lookAgain` step (`lookAgain.ts`), with a group's queue and style.
 */
export async function recheckDraft(
  storage: InboxStorage,
  deps: ControlDeps,
  { message, covers, upTo, text }: { message: GroupMessage; covers: readonly string[]; upTo: number; text: string },
): Promise<Rechecked> {
  return await lookAgain<GroupPending>(
    storage,
    deps,
    {
      prefix: "gpending:",
      // A tapback never holds a reply, as in a 1:1 chat (`lookAgainTexts`): the 2026-11-05 Tex Devs 👎 on an older link threw away a finished answer.
      read: (item) => ({ from: item.message.from, ev: item.ev, at: item.at, byCode: item.byCode === true || item.message.reaction !== undefined, ...(item.rechecked ? { rechecked: true as const } : {}) }),
      // One turn answers both, the old ask and the newer words (`addressedTurn`: forced entries are its floor).
      mark: (item) => ({ ...item, force: true, rechecked: true }),
      chat: message.groupId,
      line: message.line,
      style: (await groupStyle()).style,
    },
    { sender: message.from, covers, upTo, text },
  );
}
