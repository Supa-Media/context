import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import { askerIdentityHandler, texterIdentityHandler } from "./lib/texIdentity/identity";

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
