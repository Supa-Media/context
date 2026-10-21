/**
 * Every connector provider, by id. Outlook, GitHub and the rest are one entry
 * each here plus their call rules beside `slack.ts`
 * (`docs/decisions/connectors.md`).
 */

import { slack } from "./slack";
import type { ConnectionScope, ProviderId, ProviderSpec } from "./types";

export const PROVIDERS: Partial<Record<ProviderId, ProviderSpec>> = { slack };

export function providerOf(id: unknown): ProviderSpec | null {
  return typeof id === "string" && Object.prototype.hasOwnProperty.call(PROVIDERS, id) ? (PROVIDERS[id as ProviderId] ?? null) : null;
}

/** A personal workspace's connection acts as its person; a shared workspace's acts as the app. */
export function scopeForWorkspaceKind(kind: "personal" | "shared"): ConnectionScope {
  return kind === "personal" ? "personal" : "workspace";
}

/** The OAuth app's client, or null where this deployment has none set: the connector is then off. */
export function providerClient(
  spec: ProviderSpec,
  env: Record<string, string | undefined> = process.env,
): { clientId: string; clientSecret: string } | null {
  const clientId = env[spec.clientIdEnvVar];
  const clientSecret = env[spec.clientSecretEnvVar];
  if (typeof clientId !== "string" || clientId === "" || typeof clientSecret !== "string" || clientSecret === "") return null;
  return { clientId, clientSecret };
}

export type { ConnectionScope, ProviderId, ProviderSpec } from "./types";
