/**
 * The control plane's door to a workspace object: `POST /internal/workspace-store`
 * (the copy and compare actions, Download as folders). The same two proofs as
 * Tex's door (`texStore/door.js`): the gateway secret, and a ticket the control
 * plane minted minutes ago for one workspace. The object opened is the
 * ticket's workspace, never one the caller names, and a `ws.*` call's body is
 * rewritten to name that workspace, so a ticket for one workspace cannot pin
 * or reach another's object.
 */

import { createControlPlane } from "../controlPlane.js";
import { json } from "../http/responses.js";
import { carriesGatewaySecret } from "../moves/mover.js";
import { workspaceStub } from "./api.js";

export const WORKSPACE_STORE_PATH = "/internal/workspace-store";
const CALL = "x-tex-call";

function opOf(call) {
  try {
    return JSON.parse(decodeURIComponent(call))?.op ?? null;
  } catch {
    return null;
  }
}

/**
 * @param {Request} request
 * @param {object} env
 * @param {{controlPlane?: {openTexStoreTicket: (ticket: string) => Promise<{workspaceId: string, owners: string[]}|null>}|null}} [deps]
 */
export async function handleWorkspaceStoreDoor(request, env, { controlPlane = null } = {}) {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!(await carriesGatewaySecret(request, env))) return json({ error: "unauthorized" }, 401);
  const ticket = request.headers.get("x-workspace-ticket") ?? "";
  const call = request.headers.get(CALL);
  const op = call ? opOf(call) : null;
  if (ticket === "" || ticket.length > 256 || typeof op !== "string") return json({ error: "bad_request" }, 400);
  let opened;
  try {
    opened = await (controlPlane ?? createControlPlane(env)).openTexStoreTicket(ticket);
  } catch {
    return json({ error: "control_plane_unavailable" }, 503);
  }
  if (opened === null || typeof opened.workspaceId !== "string" || opened.workspaceId === "") return json({ error: "forbidden" }, 403);
  const stub = workspaceStub(env, opened.workspaceId);
  if (stub === null) return json({ error: "workspace_store_unavailable" }, 503);
  let body = await request.arrayBuffer();
  if (op.startsWith("ws.")) {
    let fields;
    try {
      fields = JSON.parse(new TextDecoder().decode(body) || "{}");
    } catch {
      return json({ error: "bad_request" }, 400);
    }
    body = new TextEncoder().encode(JSON.stringify({ ...fields, workspaceId: opened.workspaceId }));
  }
  return await stub.fetch(new Request("https://workspace-store.internal/door", { method: "POST", headers: { [CALL]: call }, body }));
}
