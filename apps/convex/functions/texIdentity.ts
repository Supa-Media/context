import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import { askerIdentityHandler, texterIdentityHandler } from "./lib/texIdentity/identity";
import { texterGroupsHandler } from "./lib/texIdentity/groups";
import { memberCardsHandler } from "./lib/texIdentity/cards";

/** Who is texting Tex, for the gateway (`lib/texIdentity/identity.ts`). */
const identityValidator = v.union(
  v.null(),
  v.object({
    name: v.union(v.string(), v.null()),
    handle: v.string(),
    phones: v.array(v.string()),
    emails: v.array(v.string()),
    google: v.array(v.object({ address: v.string(), products: v.array(v.string()) })),
  }),
);

export const forGateway = internalQuery({
  args: { hashedAccessToken: v.string(), expectedWorkspaceId: v.string() },
  returns: identityValidator,
  handler: texterIdentityHandler,
});

/** Who tagged Tex in a group chat, for their own ask of their personal Tex (`lib/texIdentity/identity.ts`). */
export const askerForGateway = internalQuery({
  args: { hashedAccessToken: v.string() },
  returns: identityValidator,
  handler: askerIdentityHandler,
});

/** The group chats the grant's own person is in, for their 1:1 Tex (`lib/texIdentity/groups.ts`). */
export const groupsForGateway = internalQuery({
  args: { hashedAccessToken: v.string(), expectedWorkspaceId: v.string() },
  returns: v.union(v.null(), v.array(v.object({ key: v.string(), name: v.string(), people: v.array(v.string()), lastSeenAt: v.number() }))),
  handler: texterGroupsHandler,
});

/** Whose member card a group chat's turn may read: the people its tag was minted for (`lib/texIdentity/cards.ts`). */
export const cardsForGateway = internalQuery({
  args: { hashedAccessToken: v.string() },
  returns: v.union(v.null(), v.array(v.object({ handle: v.string(), workspaceId: v.string() }))),
  handler: memberCardsHandler,
});
