/**
 * What every connector provider supplies (`registry.ts`). A provider is
 * added by writing one of these; the link, the consent round trip, the sealed
 * token and the Settings row are shared (`functions/connections.ts`,
 * `docs/decisions/connectors.md`).
 *
 * Three kinds of provider, by how Tex calls them once connected:
 *  - `slack`: the Slack Web API through `slack_api`, its own call rules.
 *  - `mcp`: the app's official remote MCP server; Tex gets that server's tools.
 *  - `tools`: an app with no official MCP server, whose API we describe as a
 *    few tools of our own (`ProviderTool`), so Tex calls it the same way.
 */

export type { ProviderId } from "./ids";
import type { ProviderId } from "./ids";

/** `personal` acts as the person who connected it; `workspace` as the provider's app, for everyone. */
export type ConnectionScope = "personal" | "workspace";

export type ExchangedToken = {
  accessToken: string;
  refreshToken?: string;
  /** Milliseconds from now, for a provider whose tokens expire. */
  expiresInMs?: number;
  accountId: string;
  teamId: string;
  teamName: string;
  scopes: string[];
};

/** Where a standard OAuth provider sends people and swaps codes; discovered for an MCP server. */
export type OAuthEndpoints = {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
};

/** An OAuth client to start a consent with: the deployment's own, or one registered with the provider. */
export type OAuthClient = {
  clientId: string;
  clientSecret?: string;
  endpoints: OAuthEndpoints;
  /** RFC 8707's resource, for an MCP server: the token is minted for it alone. */
  resource?: string;
  /** The scopes an MCP server says it takes, asked for when the registry names none. */
  scopes?: string[];
};

/** Who a token acts as, asked of the provider once it is exchanged. */
export type Identity = { accountId: string; teamId: string; teamName: string };

/** One tool Tex sees for a connected app: an MCP server's own, or one of ours over its API. */
export type AppTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Only a tool that says it changes nothing runs without the person's yes. */
  readOnly: boolean;
};

/** A tool of ours over a provider's API, for a provider with no official MCP server. */
export type ProviderTool = AppTool & {
  run(accessToken: string, args: Record<string, unknown>): Promise<{ status: number; body: unknown }>;
};

type ProviderBase = {
  id: ProviderId;
  /** The name people know it by, as copy says it. */
  name: string;
  /** What Tex can do there, in a few words, for the list of apps it can reach. */
  about: string;
  /** The app path the provider sends the person back to, registered with the provider. */
  callbackPath: string;
};

/** Slack: its own consent and exchange, and its Web API's call rules (`slack.ts`). */
export type SlackSpec = ProviderBase & {
  kind: "slack";
  clientIdEnvVar: string;
  clientSecretEnvVar: string;
  authorizeUrl(options: { clientId: string; redirectUri: string; state: string; scope: ConnectionScope }): string;
  exchange(options: {
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
    scope: ConnectionScope;
  }): Promise<ExchangedToken | null>;
  revoke(accessToken: string): Promise<void>;
};

/** A standard OAuth 2 provider with PKCE (`oauth.ts`): an MCP server, or an API we describe as tools. */
export type StandardSpec = ProviderBase & {
  /**
   * `env` names the deployment's own client in two variables; `registered`
   * means the client is registered with the provider at first use (OAuth
   * dynamic client registration, as MCP servers offer) and kept per deployment.
   */
  client: { kind: "env"; idEnvVar: string; secretEnvVar: string; endpoints: OAuthEndpoints } | { kind: "registered" };
  /** The scopes asked for; empty asks for the provider's default. */
  scopes: readonly string[];
  /** Extra authorize parameters a provider needs, e.g. Atlassian's `audience`. */
  authorizeParams?: Record<string, string>;
} & (
    | { kind: "mcp"; serverUrl: string }
    | { kind: "tools"; tools: readonly ProviderTool[]; identify(accessToken: string): Promise<Identity | null> }
  );

export type ProviderSpec = SlackSpec | StandardSpec;
