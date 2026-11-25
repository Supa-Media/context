/**
 * "Share @studio with everyone here", in any words (Dev2, 2026-11-12): the turn's tool asked for it
 * (`packages/tex/gateway/agent/settingsTools.js` `chat_add_everyone`), and the answer carries `invite`. Only this Worker holds
 * the chat's numbers, so it runs the same command as the fixed "Tex, add everyone here to @studio", as the person who
 * asked, once the answer has gone: the control plane invites only when they own the workspace (`textGroupInvited.ts`),
 * and the chat hears the same line either way.
 */

import { askControlPlane } from "./groupControl";
import type { GroupDeps } from "./groupInbox";
import { GROUP_LINES } from "./groupLines";
import { setChatBound } from "./groupChat";
import { dropKept } from "./groupKept";
import { tellTex } from "./didFacts";
import type { InboxStorage } from "./inbox";
import type { GroupMessage } from "./sendblueGroups";

import type { ChatInvite } from "./chatInvite";

/** Run the invitation as the message's sender and say how it went; a refusal is said too, never dropped. */
export async function inviteEveryone(storage: InboxStorage, deps: GroupDeps, message: GroupMessage, people: string[], invite: ChatInvite): Promise<void> {
  const asked = await askControlPlane(deps, message, people, { kind: "invite", slug: invite.slug, role: invite.role });
  if (asked.status === "invited") {
    await setChatBound(storage, message);
    // The kept answer (`groupKept.ts`) holds the token minted before the invitation, which reads only what the chat
    // reached then: dropped, so the next tag mints one that reaches the workspace (2026-11-25: a search right after the
    // invite still ran on the chat's home alone, and Tex said it couldn't see the workspace).
    await dropKept(storage);
    // Tex says how it went, from the facts (`didFacts.ts`); the old line only while node `did` is unwired.
    const did = { action: "invite", status: "invited", workspace: `@${asked.slug}`, people: asked.count, role: asked.role };
    return void (await tellTex(storage, deps, message, did, GROUP_LINES.invited(asked.slug, asked.count, asked.role)));
  }
  if (asked.status === "not_allowed") return void (await tellTex(storage, deps, message, { action: "invite", status: "not_owner", workspace: `@${invite.slug}` }, GROUP_LINES.notOwner(invite.slug)));
}
