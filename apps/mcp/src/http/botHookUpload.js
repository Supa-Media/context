/**
 * `PUT /api/bot-hook`: a bot hands Context its webhook's header from its own
 * shell (the owner, 2026-11-25: a Grok bot holds its secret in an environment
 * variable and may not see it). `manage area` with `webhook.header_from_shell`
 * answers with the command (`tools/notes/setArea.js`); the bot runs it:
 *
 *   curl -X PUT -H 'Authorization: Bearer <ticket>' --data-binary "Bearer $SECRET" <origin>/api/bot-hook
 *
 * The ticket in the header is the whole authority, minted by the person's own
 * grant for one bot, address and header name, once, for ten minutes; the body
 * is the header's value. Both go to the control plane, which spends the ticket
 * and seals the value (`apps/convex/functions/botHookTickets.ts`). Nothing
 * here keeps or logs the value, and no answer carries it.
 */

import { createControlPlane } from "../controlPlane.js";
import { json } from "./responses.js";

export const BOT_HOOK_PATH = "/api/bot-hook";

const TICKET_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;
const VALUE_MAX = 4096;

export async function handleBotHookUpload(request, env, deps = {}) {
  if (request.method !== "PUT") return new Response(null, { status: 405, headers: { Allow: "PUT" } });
  const ticket = /^Bearer (\S+)$/.exec(request.headers.get("authorization") || "")?.[1] ?? "";
  if (!TICKET_PATTERN.test(ticket)) return json({ error: "send the command's ticket as Authorization: Bearer <ticket>" }, 401);
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > VALUE_MAX) return json({ error: "the header's value is too long" }, 413);
  const text = await request.text();
  if (text.length > VALUE_MAX) return json({ error: "the header's value is too long" }, 413);
  // A shell's echo adds a newline; the value itself is one line.
  const value = text.replace(/\r?\n$/, "");
  if (value.trim() === "" || /[\r\n]/.test(value)) return json({ error: "send the header's value, on one line, as the body" }, 400);
  if (/\$[A-Za-z_]/.test(value)) return json({ error: "the variable wasn't filled in: use double quotes around it, and check it is set in this shell" }, 400);
  const controlPlane = deps.controlPlane ?? createControlPlane(env);
  let answer;
  try {
    answer = await controlPlane.botHookTicket(ticket, value);
  } catch {
    return json({ error: "Context can't be reached right now; run the command again" }, 503);
  }
  if (answer?.error) return json({ error: answer.error }, 403);
  return json({ saved: true, host: answer.host, headerEnds: answer.headerEnds }, 200);
}
