/**
 * The control plane's door to the conversations backfill:
 * `POST /internal/threads/backfill` (`threadsBackfill.js`; run from
 * `apps/convex/functions/texThreadsBackfill.ts`).
 *
 * Two proofs, as for the Tex store's door (`texStore/door.js`):
 *
 * 1. `Authorization: Bearer <GATEWAY_SECRET>`;
 * 2. a ticket the control plane minted a few minutes ago, naming the owner
 *    (`person:<workspaceId>` or `chat:<groupKey>`) whose chat is replayed.
 *
 * The body is `{owner, dryRun}`. The chat's words stay here: they are read
 * from the owner's object, sorted, and written back to it, and the answer is
 * counts only.
 */

import { createControlPlane } from "../controlPlane.js";
import { json } from "../http/responses.js";
import { carriesGatewaySecret } from "../moves/mover.js";
import { aiGatewayConfig } from "./aiGateway.js";
import { classifyText } from "./conversationThreads.js";
import { ledgerFor, ONE_TO_ONE_CHAT } from "./ledger.js";
import { backfillThreads } from "./threadsBackfill.js";

export const THREADS_BACKFILL_PATH = "/internal/threads/backfill";
const OWNER = /^(?:person:([A-Za-z0-9_-]{1,64})|chat:([0-9a-f]{64}))$/;

/**
 * @param {Request} request
 * @param {object} env
 * @param {{controlPlane?: object|null, ledger?: object|null, request?: Function}} [deps]
 */
export async function handleThreadsBackfill(request, env, deps = {}) {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!(await carriesGatewaySecret(request, env))) return json({ error: "unauthorized" }, 401);
  const ticket = request.headers.get("x-tex-ticket") ?? "";
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  const owner = typeof body?.owner === "string" ? body.owner : "";
  const named = OWNER.exec(owner);
  if (ticket === "" || ticket.length > 256 || named === null) return json({ error: "bad_request" }, 400);
  let opened;
  try {
    opened = await (deps.controlPlane ?? createControlPlane(env)).openTexStoreTicket(ticket);
  } catch {
    return json({ error: "control_plane_unavailable" }, 503);
  }
  if (opened === null || !opened.owners.includes(owner)) return json({ error: "forbidden" }, 403);
  const place = named[1] ? { owner: { person: named[1] }, chat: ONE_TO_ONE_CHAT } : { owner: { chat: named[2] }, chat: named[2] };
  const ledger = deps.ledger ?? ledgerFor(env, place.owner);
  if (ledger === null) return json({ error: "tex_store_unavailable" }, 503);
  const config = aiGatewayConfig(env);
  if (config === null) return json({ error: "model_unavailable" }, 503);
  const metadata = { feature: "assistant", workspace: String(opened.workspaceId), client: "threads_backfill" };
  const classify = (input) => classifyText({ ...input, config, metadata, ...(deps.request ? { request: deps.request } : {}) });
  try {
    const counts = await backfillThreads({ ledger, chat: place.chat, classify, dryRun: body?.dryRun === true });
    console.log(JSON.stringify({ event: "tex_threads_backfill", ...counts }));
    return json(counts);
  } catch {
    return json({ error: "backfill_failed" }, 500);
  }
}
