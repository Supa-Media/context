/**
 * Which Google OAuth client a grant belongs to, and whether the agent client
 * is switched on. Pure configuration, read from the deployment's
 * environment; see `functions/googleClients.ts` for the design.
 */

import { v } from "convex/values";

export type GoogleClientRole = "standard" | "agent";
export const googleClientRole = v.union(v.literal("standard"), v.literal("agent"));

export const STANDARD_CLIENT_ID_ENV_VAR = "GOOGLE_OAUTH_CLIENT_ID";
export const STANDARD_CLIENT_SECRET_ENV_VAR = "GOOGLE_OAUTH_CLIENT_SECRET";
export const AGENT_CLIENT_ID_ENV_VAR = "GOOGLE_AGENT_OAUTH_CLIENT_ID";
export const AGENT_CLIENT_SECRET_ENV_VAR = "GOOGLE_AGENT_OAUTH_CLIENT_SECRET";
export const AGENT_CLIENT_ACTIVE_ENV_VAR = "GOOGLE_AGENT_CLIENT_ACTIVE";

type Env = Record<string, string | undefined>;
const set = (value: string | undefined): value is string => typeof value === "string" && value.length > 0;

/**
 * Whether AI is switched onto the agent client: the flag alone. It is the
 * intent, so a switched-on deployment whose agent client id or secret has
 * gone missing fails closed rather than quietly reading through the standard
 * grant again.
 */
export function agentClientActive(env: Env = process.env): boolean {
  return env[AGENT_CLIENT_ACTIVE_ENV_VAR]?.trim() === "true";
}

/** Whether the agent client is configured, so a person can give it consent, switched on or not. */
export function agentClientConfigured(env: Env = process.env): boolean {
  return set(env[AGENT_CLIENT_ID_ENV_VAR]);
}

/** The client a role's grant was issued to. Null when it is not configured. */
export function googleClientFor(role: GoogleClientRole, env: Env = process.env): { clientId: string; clientSecret?: string } | null {
  const id = env[role === "agent" ? AGENT_CLIENT_ID_ENV_VAR : STANDARD_CLIENT_ID_ENV_VAR];
  const secret = env[role === "agent" ? AGENT_CLIENT_SECRET_ENV_VAR : STANDARD_CLIENT_SECRET_ENV_VAR];
  if (!set(id)) return null;
  return set(secret) ? { clientId: id, clientSecret: secret } : { clientId: id };
}

/**
 * Which grant a role mints from. The person's own use: always the standard
 * grant. AI: the agent grant once switched on, with nothing to fall back to;
 * before that, the agent grant for an account whose owner already allowed AI
 * access (the per-account rollout that proves the agent client before the
 * switch), and the standard grant for everyone else.
 */
export function grantFor(role: GoogleClientRole, hasAgentGrant: boolean, env: Env = process.env): GoogleClientRole {
  if (role === "standard") return "standard";
  if (agentClientActive(env)) return "agent";
  return hasAgentGrant && agentClientConfigured(env) ? "agent" : "standard";
}
