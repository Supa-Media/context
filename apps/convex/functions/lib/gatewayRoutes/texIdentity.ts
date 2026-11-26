/**
 * `POST /gateway/agent/identity` — `{ accessToken, expectedWorkspaceId }` →
 * `{ identity: { name, handle, phones, emails, google } | null }`; with
 * `{ accessToken, asker: true }`, who tagged Tex in a group chat, on their own
 * tag only (`askerIdentityHandler`); with `{ accessToken, expectedWorkspaceId,
 * groups: true }`, `{ groups: [{ key, name, people, lastSeenAt }] | null }`, the
 * group chats the 1:1 texting grant's own person is in (`lib/texIdentity/groups.ts`); with `{ accessToken, cards:
 * true }`, `{ cards: [{ handle, workspaceId }] | null }`, whose member card a group chat's turn may read, on an
 * account holder's own tag only (`lib/texIdentity/cards.ts`); with `{ accessToken, holders: "<workspace>" }`,
 * `{ holders: { slug, holders } | null }`, who in a group chat is a member of the shared workspace it named
 * (`lib/texIdentity/holders.ts`).
 *
 * Who is texting Tex (`lib/texIdentity/identity.ts`). Behind the gateway's
 * secret, with the person's own access token: the person comes off the
 * token's live grant, never from anything the gateway names. Always 200;
 * `null` is every caller who may not know, one answer for every reason.
 */

import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { hashToken } from "../crypto";
import { json, stringField } from "../gatewayAuth";

export async function gatewayAgentIdentityHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const accessToken = stringField(body, "accessToken");
  // `{ accessToken, asker: true }`: who tagged Tex in a group chat, on that person's own tag only (`askerIdentityHandler`).
  if (body.asker === true) {
    if (accessToken === null) return json({ identity: null });
    return json({ identity: await ctx.runQuery(internal.functions.texIdentity.askerForGateway, { hashedAccessToken: await hashToken(accessToken) }) });
  }
  // `{ accessToken, cards: true }`: whose member card a group chat's own tag may read (`memberCardsHandler`).
  if (body.cards === true) {
    if (accessToken === null) return json({ cards: null });
    return json({ cards: await ctx.runQuery(internal.functions.texIdentity.cardsForGateway, { hashedAccessToken: await hashToken(accessToken) }) });
  }
  // `{ accessToken, holders: "<workspace>" }`: who in this group chat is a member of a workspace it named.
  if (typeof body.holders === "string") {
    if (accessToken === null) return json({ holders: null });
    return json({ holders: await ctx.runQuery(internal.functions.texIdentity.holdersForGateway, { hashedAccessToken: await hashToken(accessToken), workspace: body.holders.slice(0, 80) }) });
  }
  const expected = stringField(body, "expectedWorkspaceId");
  // `{ accessToken, expectedWorkspaceId, groups: true }`: the group chats the person texting their own Tex is in.
  if (body.groups === true) {
    if (accessToken === null || expected === null) return json({ groups: null });
    return json({ groups: await ctx.runQuery(internal.functions.texIdentity.groupsForGateway, { hashedAccessToken: await hashToken(accessToken), expectedWorkspaceId: expected }) });
  }
  if (accessToken === null || expected === null) return json({ identity: null });
  const identity = await ctx.runQuery(internal.functions.texIdentity.forGateway, {
    hashedAccessToken: await hashToken(accessToken),
    expectedWorkspaceId: expected,
  });
  return json({ identity });
}

export { gatewayTextsOpenedHandler } from "./textsOpened";
