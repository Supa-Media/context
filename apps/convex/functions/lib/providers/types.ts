/**
 * What every connector provider supplies (`registry.ts`). A provider is
 * added by writing one of these and its API's call rules; the link, the
 * consent round trip, the sealed token and the Settings row are shared
 * (`functions/connections.ts`, `docs/decisions/connectors.md`).
 */

export type ProviderId = "slack";

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

export type ProviderSpec = {
  id: ProviderId;
  /** The name people know it by, as copy says it. */
  name: string;
  clientIdEnvVar: string;
  clientSecretEnvVar: string;
  /** The app path the provider sends the person back to, registered with the provider. */
  callbackPath: string;
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
