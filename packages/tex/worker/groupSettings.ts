/**
 * "Tex, share my chats with the devs" in a group, or stop, or ask: the
 * sender's own switch, and whether the whole chat counts (`reviewSharing.ts`).
 * The group "Tex, settings" menu that also lived here is retired (Dev2,
 * 2026-11-11; `docs/decisions/texting-assistant/retire-settings.md`): how Tex
 * talks is changed by asking it in words.
 */

import type { GroupDeps } from "./groupInbox";
import { say } from "./groupSay";
import { saveReviewSharing, sharingReply, type Sharing } from "./reviewSharing";
import type { InboxStorage } from "./inbox";
import type { GroupMessage } from "./sendblueGroups";

/** Answer the sender's review-sharing words in the group. */
export async function groupReviewSharing(storage: InboxStorage, deps: GroupDeps, message: GroupMessage, sharing: Sharing): Promise<void> {
  const others = [...new Set([...message.participants, message.from])].filter((phone) => phone !== message.line);
  const answer = await saveReviewSharing(deps.fetch, deps.controlPlaneOrigin, deps.workerSecret, message.from, sharing, others);
  await say(storage, deps, message, sharingReply(sharing, answer, { inGroup: true }), { system: true });
}
