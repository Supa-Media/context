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

/** Whether the agent client is switched on: the flag, and a client id to use. */
export function agentClientActive(env: Env = process.env): boolean {
  return env[AGENT_CLIENT_ACTIVE_ENV_VAR] === "true" && set(env[AGENT_CLIENT_ID_ENV_VAR]);
}

/** The client a role's grant was issued to. Null when it is not configured. */
export function googleClientFor(role: GoogleClientRole, env: Env = process.env): { clientId: string; clientSecret?: string } | null {
  const id = env[role === "agent" ? AGENT_CLIENT_ID_ENV_VAR : STANDARD_CLIENT_ID_ENV_VAR];
  const secret = env[role === "agent" ? AGENT_CLIENT_SECRET_ENV_VAR : STANDARD_CLIENT_SECRET_ENV_VAR];
  if (!set(id)) return null;
  return set(secret) ? { clientId: id, clientSecret: secret } : { clientId: id };
}

/** Which grant a role mints from: the agent one only once the agent client is active. */
export function grantFor(role: GoogleClientRole, env: Env = process.env): GoogleClientRole {
  return role === "agent" && agentClientActive(env) ? "agent" : "standard";
}
