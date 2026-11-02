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
import { mcpEntry } from "../mcp/mcpEntryPoint.js";

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
export async function handleWorkspaceStoreDoor(request, env, deps = {}) {
  // Every door call is one `mcp_entry` point under "door": its op, its workspace, how long the ticket check and
  // the object took, so the control plane's background traffic can be read by op instead of guessed at.
  const door = mcpEntry(env, { surface: "door" });
  return door.done(await serveDoor(request, env, deps, door));
}

async function serveDoor(request, env, { controlPlane = null } = {}, door) {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!(await carriesGatewaySecret(request, env))) return json({ error: "unauthorized" }, 401);
  const ticket = request.headers.get("x-workspace-ticket") ?? "";
  const call = request.headers.get(CALL);
  const op = call ? opOf(call) : null;
  if (ticket === "" || ticket.length > 256 || typeof op !== "string") return json({ error: "bad_request" }, 400);
  door.call = op.replace(/[^A-Za-z0-9_.:-]/g, "");
  let opened;
  try {
    opened = await door.step("ticket", () => (controlPlane ?? createControlPlane(env)).openTexStoreTicket(ticket));
  } catch {
    return json({ error: "control_plane_unavailable" }, 503);
  }
  if (opened === null || typeof opened.workspaceId !== "string" || opened.workspaceId === "") return json({ error: "forbidden" }, 403);
  door.workspace = opened.workspaceId;
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
  return await door.step("object", () => stub.fetch(new Request("https://workspace-store.internal/door", { method: "POST", headers: { [CALL]: call }, body })));
}
