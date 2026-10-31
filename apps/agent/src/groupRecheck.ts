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

import { recheck, type ControlDeps } from "./decide";
import { keptEvents, renderTranscript } from "./events";
import { eventPeople } from "./groupChat";
import { groupStyle } from "./groupStyle";
import type { GroupPending } from "./groupTurn";
import type { InboxStorage } from "./inbox";
import type { GroupMessage } from "./sendblueGroups";

export type Rechecked = "send" | "held";

/**
 * Whether the draft `text` written for `covers` (the turn's events, from
 * `message`'s sender, the newest of them in at `upTo`) still goes out.
 * Only the asker's own newer words count: somebody else's tag is their own turn.
 */
export async function recheckDraft(
  storage: InboxStorage,
  deps: ControlDeps,
  { message, covers, upTo, text }: { message: GroupMessage; covers: readonly string[]; upTo: number; text: string },
): Promise<Rechecked> {
  if (text.trim() === "" || covers.length === 0) return "send";
  const pending = [...(await storage.list<GroupPending>({ prefix: "gpending:" }))];
  const own = pending.filter(([, item]) => item.ev !== undefined && covers.includes(item.ev));
  // Asked once: the turn that answers both is never held again.
  if (own.some(([, item]) => item.rechecked)) return "send";
  // A command, a yes or a style choice is answered by code (`byCode`), never an ask that could change this one.
  const newer = pending.filter(([, item]) => item.message.from === message.from && item.ev !== undefined && !covers.includes(item.ev) && !item.byCode && (item.at ?? 0) > upTo);
  if (newer.length === 0) return "send";
  const newest = newer.at(-1)![1].ev!;
  const answer = await recheck(
    deps,
    {
      chat: message.groupId,
      line: message.line,
      sender: message.from,
      style: (await groupStyle(storage)).style,
      // Only what was said in front of exactly these people, as decide is shown.
      transcript: renderTranscript(await keptEvents(storage, message.groupId), { people: await eventPeople(storage, message) }),
      candidates: [...covers, ...newer.map(([, item]) => item.ev!)],
      newest,
    },
    text,
    covers.at(-1)!,
  );
  console.log(JSON.stringify({ event: "group_recheck", outcome: answer.ok ? (answer.fits ? "send" : "held") : "unavailable", ...(!answer.ok ? { reason: answer.cause } : {}), newer: newer.length }));
  if (!answer.ok || answer.fits) return "send";
  // One turn answers both, the old ask and the newer words (`addressedTurn`: forced entries are its floor).
  for (const [key, item] of [...own, ...newer]) await storage.put<GroupPending>(key, { ...item, force: true, rechecked: true });
  return "held";
}
