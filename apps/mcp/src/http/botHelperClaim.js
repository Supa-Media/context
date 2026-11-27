/**
 * `POST /api/bot-helper`: a bot spends the one-time ticket `manage area { start_helper }` gave it, from its own shell,
 * and the answer is its helper's MCP config, written straight to a file (`docs/decisions/app-and-console/bot-helpers.md`):
 *
 *   (umask 077; curl -sS --fail-with-body -X POST -H 'Authorization: Bearer <ticket>' <origin>/api/bot-helper -o <file>)
 *
 * The ticket in the header is the whole authority: minted by the bot's own grant for one helper, once, for ten minutes.
 * The helper's token is minted by the control plane when the ticket is spent and goes only into this answer's body,
 * so it never passes through the bot's model or a chat. Nothing here keeps or logs it.
 */

import { createControlPlane } from "../controlPlane.js";
import { json } from "./responses.js";

export const BOT_HELPER_PATH = "/api/bot-helper";

const TICKET_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;

/** The config `claude --mcp-config` reads (and most MCP clients accept): one Context server, the token in a header. */
export function helperMcpConfig(origin, accessToken) {
  return { mcpServers: { context: { type: "http", url: `${origin.replace(/\/+$/, "")}/mcp`, headers: { Authorization: `Bearer ${accessToken}` } } } };
}

export async function handleBotHelperClaim(request, env, deps = {}) {
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  const ticket = /^Bearer (\S+)$/.exec(request.headers.get("authorization") || "")?.[1] ?? "";
  if (!TICKET_PATTERN.test(ticket)) return json({ error: "send the command's ticket as Authorization: Bearer <ticket>" }, 401);
  const controlPlane = deps.controlPlane ?? createControlPlane(env);
  let answer;
  try {
    answer = await controlPlane.botHelper("claim", { ticket });
  } catch {
    return json({ error: "Context can't be reached right now; run the command again" }, 503);
  }
  if (answer?.error || typeof answer?.accessToken !== "string") return json({ error: answer?.error ?? "no helper was started" }, 403);
  const origin = new URL(request.url).origin;
  return new Response(JSON.stringify(helperMcpConfig(origin, answer.accessToken), null, 2), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
