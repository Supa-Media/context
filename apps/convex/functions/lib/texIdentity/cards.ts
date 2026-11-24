/**
 * Whose member card a group chat's turn may read (decided by the owner, Sayo, 2026-11-24;
 * `docs/decisions/texting-assistant/member-cards.md`). A member card is `tex/group-card.md` in a person's own personal
 * workspace: hints their own Tex wrote for groups, under their rules, which a group turn may use and never say.
 *
 * The control plane names the people; the gateway reads each one's card from their own object. Only a group chat's
 * grant, only on the token minted for an account holder's own tag (never a job's run token, never an earlier token
 * kept alive beside a newer tag, never an invited person's or a guest's tag, which act through someone else), and only
 * the people that tag was minted for, who are the chat's people with an account as that tag found them. A chat with
 * anyone in it who has no account (a guest, an invited number) reads nobody's: a stranger there would see what the
 * hints make Tex do; the gateway checks its own turn's room for one too (`agent/memberCards.js`). Every refusal is the
 * same `null`.
 */

import type { Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import { resolveLiveGrant } from "../controlPlane/liveGrants";
import { handleFor } from "../../texPage";
import { personalWorkspaceOf } from "../../textLinks";

/** A group chat's grant (`textGroups.ts` `TEXTS_GROUP_CLIENT_ID`), named here so this file needs nothing of the chat's. */
const TEXTS_GROUP_CLIENT_ID = "context_texts_group";

/** The most people one turn reads the cards of: a group chat on iMessage holds at most 32, and a card costs a prompt. */
export const MAX_CARD_PEOPLE = 12;

export type CardHome = { handle: string; workspaceId: string };

export async function memberCardsHandler(ctx: QueryCtx, args: { hashedAccessToken: string }): Promise<CardHome[] | null> {
  // `resolveLiveGrant`, never the run grants: a job's token reads no cards.
  const live = await resolveLiveGrant(ctx, args.hashedAccessToken);
  if (live === null || live.grant.clientId !== TEXTS_GROUP_CLIENT_ID) return null;
  const group = live.grant.texGroup;
  // Only the newest token of an account holder's own tag: `ownTagToken` is never set on an invited person's or a guest's.
  if (group === undefined || group.ownTagToken === undefined || group.ownTagToken !== args.hashedAccessToken) return null;
  // Anyone here without an account, or a guest's own group: no cards for anyone.
  if (group.guestPhone !== undefined || group.guestTagger === true || group.guestGroupId !== undefined) return null;
  if ((group.reachGuests ?? []).length > 0 || (group.coInvitationIds ?? []).length > 0) return null;
  const chat = await ctx.db.get(group.groupId);
  if (chat === null) return null;
  const tagger = group.homeOnly === true ? group.taggerId : live.grant.userId;
  if (tagger === undefined) return null;
  // Everyone this tag was minted for, the tagger first: each tag mints again with the chat's people as they are now, so
  // someone who left is on no newer tag's token. A home-only grant names nobody else, and its tag named the home's people
  // again in the same mutation (`textGroupHomeOnly.ts` `ensureChatHome`), so the home's people are this tag's; any other
  // grant names them itself (`coViewerIds`).
  const minted = group.homeOnly === true ? (chat.homeUsers ?? []) : group.coViewerIds;
  const people = [...new Set<Id<"users">>([tagger, ...minted])].slice(0, MAX_CARD_PEOPLE);
  const homes: CardHome[] = [];
  for (const userId of people) {
    const workspaceId = await personalWorkspaceOf(ctx, userId);
    const handle = await handleFor(ctx, userId);
    if (workspaceId !== null && handle !== "") homes.push({ handle, workspaceId });
  }
  return homes;
}
