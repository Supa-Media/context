/**
 * Every connector provider, by id: Slack, the apps reached through their
 * official MCP server (`mcpApps.ts`), and those whose API we describe as
 * tools (`docs/decisions/connectors.md`).
 */

import { slack } from "./slack";
import { airtable, atlassian, calendly, clickup, linear, monday, notion, planningCenter, todoist } from "./mcpApps";
import type { ConnectionScope, ProviderId, ProviderSpec } from "./types";

export const PROVIDERS: Partial<Record<ProviderId, ProviderSpec>> = {
  slack,
  "planning-center": planningCenter,
  linear,
  notion,
  atlassian,
  airtable,
  calendly,
  monday,
  clickup,
  todoist,
};

export function providerOf(id: unknown): ProviderSpec | null {
  return typeof id === "string" && Object.prototype.hasOwnProperty.call(PROVIDERS, id) ? (PROVIDERS[id as ProviderId] ?? null) : null;
}

/** A personal workspace's connection acts as its person; a shared workspace's acts as the app. */
export function scopeForWorkspaceKind(kind: "personal" | "shared"): ConnectionScope {
  return kind === "personal" ? "personal" : "workspace";
}

/**
 * Whether this deployment can connect the provider at all. A provider with
 * its own client needs both its variables set; one registered with the app
 * at first use is always available.
 */
export function providerAvailable(spec: ProviderSpec, env: Record<string, string | undefined> = process.env): boolean {
  if (spec.kind === "slack") return envClient(spec.clientIdEnvVar, spec.clientSecretEnvVar, env) !== null;
  if (spec.client.kind === "registered") return true;
  return envClient(spec.client.idEnvVar, spec.client.secretEnvVar, env) !== null;
}

function envClient(idVar: string, secretVar: string, env: Record<string, string | undefined>): { clientId: string; clientSecret: string } | null {
  const clientId = env[idVar];
  const clientSecret = env[secretVar];
  if (typeof clientId !== "string" || clientId === "" || typeof clientSecret !== "string" || clientSecret === "") return null;
  return { clientId, clientSecret };
}

/** Slack's client, or a standard provider's own (`env`) client, or null where this deployment has none set. */
export function providerClient(
  spec: ProviderSpec,
  env: Record<string, string | undefined> = process.env,
): { clientId: string; clientSecret: string } | null {
  if (spec.kind === "slack") return envClient(spec.clientIdEnvVar, spec.clientSecretEnvVar, env);
  if (spec.client.kind === "env") return envClient(spec.client.idEnvVar, spec.client.secretEnvVar, env);
  return null;
}

export type { ConnectionScope, ProviderId, ProviderSpec } from "./types";
