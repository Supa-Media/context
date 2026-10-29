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

/**
 * The canary: up to three workspaces, named by id in
 * `GOOGLE_CUTOVER_CANARY_WORKSPACES` (comma separated), that run as though
 * both cutover settings were on, `GOOGLE_AGENT_CLIENT_ACTIVE=true` and
 * `GOOGLE_CALENDAR_SCOPE=owned`, while everyone else runs on the global
 * values. It is how the final scopes are proven on a synthetic account
 * without asking every person for them before Google lists them. Only the
 * deployment's environment names a workspace, never a request, and a list
 * longer than three names nobody, so it cannot quietly become the rollout.
 * Any value that names no workspace (e.g. `none`) is the brake.
 */
export const CUTOVER_CANARY_ENV_VAR = "GOOGLE_CUTOVER_CANARY_WORKSPACES";
const CUTOVER_CANARY_LIMIT = 3;

export function cutoverCanary(workspaceId: string | undefined, env: Env = process.env): boolean {
  if (!set(workspaceId)) return false;
  const named = (env[CUTOVER_CANARY_ENV_VAR] ?? "").split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  return named.length <= CUTOVER_CANARY_LIMIT && named.includes(workspaceId);
}

/** The environment a workspace's Google calls read: the canary's settings on top for a canary workspace, unchanged for every other. */
export function googleEnvFor(workspaceId: string | undefined, env: Env = process.env): Env {
  if (!cutoverCanary(workspaceId, env)) return env;
  return { ...env, [AGENT_CLIENT_ACTIVE_ENV_VAR]: "true", GOOGLE_CALENDAR_SCOPE: "owned" };
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
