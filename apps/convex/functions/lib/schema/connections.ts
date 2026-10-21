import { defineTable } from "convex/server";
import { v } from "convex/values";
import { providerValidator } from "../providers/ids";

/**
 * Third-party apps connected through their own OAuth app (Slack first; Outlook,
 * GitHub and the rest after it), one shape for every provider
 * (`docs/decisions/connectors.md`). The provider's rules live in
 * `lib/providers/registry.ts`, never in these rows.
 *
 * Google keeps its own `googleConnections`: it syncs mail, calendar and chat
 * into notes, which no connector here does. A connector is a token Tex calls
 * the provider's API with, and nothing is copied into the bucket.
 */
const provider = providerValidator;

export const connectionTables = {
  /**
   * A link an agent asked for, finished by the person on a signed-in page
   * (`/connect/<provider>/<token>`), the way `vaultRequests` is. Ids and
   * times only.
   */
  providerConnectLinks: defineTable({
    hashedToken: v.string(),
    provider,
    /** Where the connection will belong: the workspace the agent's grant cleared. */
    workspaceId: v.id("workspaces"),
    /** The only person who may finish it: whoever's grant asked. */
    userId: v.id("users"),
    /** The client that asked, so a group chat's link can only ever make a workspace connection. */
    clientId: v.string(),
    expiresAt: v.number(),
    usedAt: v.optional(v.number()),
  })
    .index("by_hashed_token", ["hashedToken"])
    .index("by_expires", ["expiresAt"])
    .index("by_workspace", ["workspaceId"]),

  /**
   * The parked half of a connect, between leaving for the provider's consent
   * screen and its callback; the shape `googleConnectAttempts` argues for.
   * `encryptedVerifier` holds a PKCE verifier for a provider that takes one
   * (`registry.ts`), and its presence is what `lib/connectAttempts.ts` sweeps
   * by, so this table is cascaded with its workspace without being listed.
   */
  providerConnectAttempts: defineTable({
    hashedState: v.string(),
    /** The secret the starting browser keeps and hands back; it never travels through the provider. */
    hashedCompletion: v.string(),
    encryptedVerifier: v.optional(v.string()),
    provider,
    workspaceId: v.id("workspaces"),
    startedBy: v.id("users"),
    linkId: v.id("providerConnectLinks"),
    expiresAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_hashed_state", ["hashedState"])
    .index("by_expiresAt", ["expiresAt"])
    .index("by_workspace", ["workspaceId"]),

  /**
   * One connected account of one provider, held by one workspace. A personal
   * workspace's connection acts as its person; a shared workspace's acts as
   * the provider's app (Slack's bot member "Tex"), so a group chat never acts
   * as any one member (`docs/decisions/connectors.md`).
   */
  providerConnections: defineTable({
    provider,
    workspaceId: v.id("workspaces"),
    /** `personal` acts as the person who connected it; `workspace` as the app. Fixed by the workspace's kind. */
    scope: v.union(v.literal("personal"), v.literal("workspace")),
    connectedBy: v.id("users"),
    /** Sealed with `encryptSecret`, bound to `workspaceId`; opened only in `functions/connections.ts`. */
    encryptedAccessToken: v.string(),
    encryptedRefreshToken: v.optional(v.string()),
    accessTokenExpiresAt: v.optional(v.number()),
    grantedScopes: v.array(v.string()),
    /** The provider's id for the account the token acts as (a Slack user or bot user). */
    externalAccountId: v.string(),
    /** The provider's organisation (a Slack team), its id and the name people know it by. */
    externalTeamId: v.string(),
    externalTeamName: v.string(),
    connectedAt: v.number(),
    updatedAt: v.number(),
    /** Set when the provider stopped honouring the token; the person reconnects. */
    reconnectRequiredAt: v.optional(v.number()),
    /**
     * An MCP app's tools that say they change nothing, as its server last
     * listed them: only these run without the person's yes. Names only.
     */
    readOnlyTools: v.optional(v.array(v.string())),
    toolsListedAt: v.optional(v.number()),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_workspace_provider_team", ["workspaceId", "provider", "externalTeamId"]),

  /**
   * The OAuth client Context registered with an app's authorization server
   * (RFC 7591), one per provider and callback address, shared by every
   * workspace on this deployment: it identifies Context to the app, never a
   * person. A secret, where the app issues one, is sealed to the platform.
   */
  providerOAuthClients: defineTable({
    provider,
    redirectUri: v.string(),
    clientId: v.string(),
    encryptedClientSecret: v.optional(v.string()),
    authorizationEndpoint: v.string(),
    tokenEndpoint: v.string(),
    revocationEndpoint: v.optional(v.string()),
    resource: v.optional(v.string()),
    scopes: v.optional(v.array(v.string())),
    registeredAt: v.number(),
  }).index("by_provider_redirect", ["provider", "redirectUri"]),
};
