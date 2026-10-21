/**
 * Slack, through Context's own Slack app ("Tex by Context"; the manifest is in
 * `docs/decisions/connectors.md`). OAuth v2, token rotation off, so a token
 * lasts until it is revoked and there is nothing to refresh.
 *
 * One app gives two kinds of token, and the workspace's kind picks which:
 * a personal workspace asks only for user scopes, so Tex acts as the person;
 * a shared workspace asks only for bot scopes, so Tex acts as its own bot
 * member and sees only the channels it is invited to. A group chat's Tex,
 * which everybody in the chat steers, therefore never holds anyone's own
 * Slack (the owner, 2026-10-21, on #2021's rule for logins).
 *
 * Registers nothing and opens no credential; `functions/connections.ts` does.
 */

import type { ConnectionScope, ExchangedToken, SlackSpec } from "./types";

export const SLACK_CLIENT_ID_ENV_VAR = "SLACK_CLIENT_ID";
export const SLACK_CLIENT_SECRET_ENV_VAR = "SLACK_CLIENT_SECRET";

const AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";
const API_ORIGIN = "https://slack.com/api/";

/** Kept equal to the manifest's `oauth_config.scopes.user`. */
export const SLACK_USER_SCOPES = [
  "channels:read",
  "channels:history",
  "groups:read",
  "groups:history",
  "im:read",
  "im:history",
  "mpim:read",
  "mpim:history",
  "users:read",
  "users:read.email",
  "search:read",
  "chat:write",
  "reactions:read",
  "reactions:write",
  "files:read",
  "team:read",
] as const;

/** Kept equal to the manifest's `oauth_config.scopes.bot`. */
export const SLACK_BOT_SCOPES = [
  "channels:read",
  "channels:history",
  "groups:read",
  "groups:history",
  "im:history",
  "mpim:history",
  "users:read",
  "chat:write",
  "reactions:read",
  "reactions:write",
  "files:read",
  "team:read",
] as const;

/*
  The Web API methods Tex may call. Anything else is refused before Slack is
  asked, so a planted "admin.users.remove" never leaves. `held` methods put
  words in front of other people that they read the moment they land; the
  gateway holds those for the person's YES (`apps/mcp/src/tools/irreversible.js`)
  and the control plane only checks they are on this list.
*/
export const SLACK_READ_METHODS = [
  "auth.test",
  "bots.info",
  "chat.getPermalink",
  "conversations.history",
  "conversations.info",
  "conversations.list",
  "conversations.members",
  "conversations.replies",
  "files.info",
  "reactions.get",
  "search.messages",
  "team.info",
  "users.conversations",
  "users.info",
  "users.list",
  "users.lookupByEmail",
  "users.profile.get",
] as const;

/** Changes that are easy to take back and tell nobody anything: a reaction, opening a DM. */
export const SLACK_QUIET_WRITE_METHODS = ["conversations.open", "reactions.add", "reactions.remove"] as const;

/** Words other people read as soon as they land. Held for a YES by the gateway. */
export const SLACK_HELD_METHODS = [
  "chat.delete",
  "chat.meMessage",
  "chat.postMessage",
  "chat.scheduleMessage",
  "chat.update",
] as const;

const ALLOWED = new Set<string>([...SLACK_READ_METHODS, ...SLACK_QUIET_WRITE_METHODS, ...SLACK_HELD_METHODS]);

export function slackMethodAllowed(method: string): boolean {
  return ALLOWED.has(method);
}

const READS = new Set<string>(SLACK_READ_METHODS);

/** A method that changes nothing in Slack. Every other allowed call is audited. */
export function slackMethodReads(method: string): boolean {
  return READS.has(method);
}

export function slackScopesFor(scope: ConnectionScope): readonly string[] {
  return scope === "personal" ? SLACK_USER_SCOPES : SLACK_BOT_SCOPES;
}

function slackAuthorizeUrl(options: { clientId: string; redirectUri: string; state: string; scope: ConnectionScope }): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set(options.scope === "personal" ? "user_scope" : "scope", slackScopesFor(options.scope).join(","));
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("state", options.state);
  return url.toString();
}

type SlackAccess = {
  ok?: unknown;
  error?: unknown;
  access_token?: unknown;
  scope?: unknown;
  bot_user_id?: unknown;
  team?: { id?: unknown; name?: unknown } | null;
  authed_user?: { id?: unknown; access_token?: unknown; scope?: unknown } | null;
};

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * `oauth.v2.access`'s answer, read for the half the scope asked for: the
 * user's token for a personal connection, the bot's for a workspace one.
 * Null for anything else, an answer carrying the other half included.
 */
export function readSlackAccess(body: SlackAccess, scope: ConnectionScope): ExchangedToken | null {
  if (body?.ok !== true) return null;
  const teamId = text(body.team?.id);
  const teamName = text(body.team?.name);
  if (teamId === null || teamName === null) return null;
  if (scope === "personal") {
    const user = body.authed_user;
    const accessToken = text(user?.access_token);
    const accountId = text(user?.id);
    if (accessToken === null || accountId === null || !accessToken.startsWith("xoxp-")) return null;
    return { accessToken, accountId, teamId, teamName, scopes: (text(user?.scope) ?? "").split(",").filter(Boolean) };
  }
  const accessToken = text(body.access_token);
  const accountId = text(body.bot_user_id);
  if (accessToken === null || accountId === null || !accessToken.startsWith("xoxb-")) return null;
  return { accessToken, accountId, teamId, teamName, scopes: (text(body.scope) ?? "").split(",").filter(Boolean) };
}

async function slackExchange(options: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  scope: ConnectionScope;
}): Promise<ExchangedToken | null> {
  const response = await fetch(`${API_ORIGIN}oauth.v2.access`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: options.clientId,
      client_secret: options.clientSecret,
      code: options.code,
      redirect_uri: options.redirectUri,
    }),
  });
  if (!response.ok) return null;
  return readSlackAccess((await response.json()) as SlackAccess, options.scope);
}

async function slackRevoke(accessToken: string): Promise<void> {
  await fetch(`${API_ORIGIN}auth.revoke`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

/**
 * The arguments of one Web API call as Slack's form encoding wants them: a
 * string stays as it is, anything else (blocks, a number, a boolean) is
 * JSON. Form encoding is the one every method takes.
 */
export function slackForm(args: Record<string, unknown>): URLSearchParams {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    form.set(key, typeof value === "string" ? value : JSON.stringify(value));
  }
  return form;
}

/** Slack answers 200 with `ok: false` for most failures; these mean the token is gone. */
export const SLACK_TOKEN_GONE = new Set(["invalid_auth", "token_revoked", "account_inactive", "not_authed", "token_expired"]);

export async function slackCall(accessToken: string, method: string, args: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${API_ORIGIN}${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: slackForm(args),
    redirect: "manual",
  });
  const raw = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    body = { ok: false, error: "not_json" };
  }
  return { status: response.status, body };
}

export const slack: SlackSpec = {
  kind: "slack",
  id: "slack",
  name: "Slack",
  about: "read channels and DMs, search messages, react, and post as the person",
  clientIdEnvVar: SLACK_CLIENT_ID_ENV_VAR,
  clientSecretEnvVar: SLACK_CLIENT_SECRET_ENV_VAR,
  callbackPath: "/connect/slack",
  authorizeUrl: slackAuthorizeUrl,
  exchange: slackExchange,
  revoke: slackRevoke,
};
