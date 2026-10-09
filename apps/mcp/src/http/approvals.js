/**
 * `/approvals` — the app's side of the egress gate: what is waiting for this
 * person, and their yes or no.
 *
 * First-party only. The gate exists so that nothing a model can call widens
 * who sees something, and a route an MCP client could reach with its own
 * token would be exactly that: the model approving itself. So the caller
 * must be the console's own client (`context_console`, minted by the control
 * plane for a signed-in person and never registrable), and the record must
 * have been raised for the same person. A texted YES is the other first-party
 * surface (`agent/route.js`).
 *
 *  - `GET /approvals` → `{ approvals: [{ id, summary, tool, args, client, created_at, expires_at }] }`
 *    (`args` exactly as the client sent them: what would run, for the person
 *    to look at before saying yes)
 *  - `POST /approvals` with `{ id, action: "approve" | "deny" }` →
 *    `{ status, result? }`, where `result` is the tool's own answer text.
 *
 * An approved call runs once, here, through the same dispatcher an AI
 * client's call goes through, under this person's own session marked
 * approved; its result is kept for an hour so the client that asked can call
 * again and be handed it (`tools/approvals.js`).
 */

import { callToolForSession } from "../tools/session.js";
import { listPending, replayAsAsked, settlePending } from "../tools/approvals.js";
import { json } from "./responses.js";

/** The console's client (`CONSOLE_CLIENT_ID` in `apps/convex/functions/agentGrant.ts`). */
const CONSOLE_CLIENT_ID = "context_console";

export async function handleApprovals(request, store, session) {
  if (session.actorClientId !== CONSOLE_CLIENT_ID) {
    return json({ error: "forbidden", error_description: "Only the Context app can answer approvals." }, 403);
  }
  if (request.method === "GET") {
    const waiting = await listPending(store, { userId: session.actorUserId });
    return json({
      approvals: waiting.map(({ record }) => ({
        id: record.id,
        summary: record.summary,
        tool: record.tool,
        args: record.args,
        audience: record.audience,
        client: record.actor?.client ?? null,
        created_at: record.created_at,
        expires_at: record.expires_at,
      })),
    });
  }
  if (request.method !== "POST") return new Response(null, { status: 405 });
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_request", error_description: "Expected a JSON body." }, 400);
  }
  const id = typeof body?.id === "string" ? body.id : "";
  const action = body?.action === "approve" || body?.action === "deny" ? body.action : null;
  if (!id || action === null) {
    return json({ error: "invalid_request", error_description: "Pass id and action: approve or deny." }, 400);
  }
  const settled = await settlePending(store, id, {
    userId: session.actorUserId,
    action,
    actorScope: session.scope,
    run: (record) =>
      replayAsAsked(store, session, record, (approver) =>
        callToolForSession({ name: record.tool, arguments: record.args }, store, approver),
      ),
  });
  if (settled.status === "not_found") return json({ error: "not_found" }, 404);
  const text = settled.result?.content?.[0]?.text;
  return json({
    status: settled.status,
    summary: settled.record?.summary ?? null,
    ...(settled.status === "approved"
      ? { result: typeof text === "string" ? text : "", ok: settled.result?.isError !== true }
      : {}),
  });
}
