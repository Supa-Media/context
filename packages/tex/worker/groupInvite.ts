/**
 * "Share @studio with everyone here", in any words (Dev2, 2026-11-12): the turn's tool asked for it
 * (`apps/mcp/src/agent/settingsTools.js` `chat_add_everyone`), and the answer carries `invite`. Only this Worker holds
 * the chat's numbers, so it runs the same command as the fixed "Tex, add everyone here to @studio", as the person who
 * asked, once the answer has gone: the control plane invites only when they own the workspace (`textGroupInvited.ts`),
 * and the chat hears the same line either way.
 */

import { askControlPlane } from "./groupControl";
import type { GroupDeps } from "./groupInbox";
import { GROUP_LINES } from "./groupLines";
import { setChatBound } from "./groupChat";
import { say } from "./groupSay";
import type { InboxStorage } from "./inbox";
import type { GroupMessage } from "./sendblueGroups";

import type { ChatInvite } from "./chatInvite";

/** Run the invitation as the message's sender and say how it went; a refusal is said too, never dropped. */
export async function inviteEveryone(storage: InboxStorage, deps: GroupDeps, message: GroupMessage, people: string[], invite: ChatInvite): Promise<void> {
  const asked = await askControlPlane(deps, message, people, { kind: "invite", slug: invite.slug, role: invite.role });
  if (asked.status === "invited") {
    await setChatBound(storage, message);
    return void (await say(storage, deps, message, GROUP_LINES.invited(asked.slug, asked.count, asked.role), { system: true }));
  }
  if (asked.status === "not_allowed") return void (await say(storage, deps, message, GROUP_LINES.notOwner(invite.slug), { system: true }));
}
