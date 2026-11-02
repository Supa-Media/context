/**
 * The control plane's door to Tex's notes: `POST /internal/tex-store`.
 *
 * Tex's notes live in Durable Objects only this Worker can reach
 * (`texStore.js`), and the control plane does some of its own reading and
 * writing of notes (Download as folders, emptying the trash, filing a shared
 * edit), so it calls here for the Tex keys among them
 * (`apps/convex/functions/lib/texStore.ts`). Two proofs, as for the mover
 * (`moves/mover.js`):
 *
 * 1. `Authorization: Bearer <GATEWAY_SECRET>`;
 * 2. a ticket the control plane minted a few minutes ago for one workspace,
 *    naming the owners (`person:<workspaceId>`, its group chats) it may
 *    reach. The secret alone opens nothing.
 *
 * The call itself (`x-tex-call`) and its body pass to the owner's object as
 * the gateway's own would (`texStore/wire.js`); the answer comes back as it is.
 */

import { createControlPlane } from "../controlPlane.js";
import { json } from "../http/responses.js";
import { carriesGatewaySecret } from "../moves/mover.js";
import { texStoreStub } from "./wire.js";

export const TEX_STORE_PATH = "/internal/tex-store";
const OWNER = /^(person|chat):([A-Za-z0-9_-]{1,64})$/;

/**
 * @param {Request} request
 * @param {object} env
 * @param {{controlPlane?: {openTexStoreTicket: (ticket: string) => Promise<{workspaceId: string, owners: string[]}|null>}|null}} [deps]
 */
export async function handleTexStoreDoor(request, env, { controlPlane = null } = {}) {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!(await carriesGatewaySecret(request, env))) return json({ error: "unauthorized" }, 401);
  const ticket = request.headers.get("x-tex-ticket") ?? "";
  const owner = request.headers.get("x-tex-owner") ?? "";
  const call = request.headers.get("x-tex-call");
  const named = OWNER.exec(owner);
  if (ticket === "" || ticket.length > 256 || named === null || !call) return json({ error: "bad_request" }, 400);
  let opened;
  try {
    opened = await (controlPlane ?? createControlPlane(env)).openTexStoreTicket(ticket);
  } catch {
    return json({ error: "control_plane_unavailable" }, 503);
  }
  if (opened === null || !opened.owners.includes(owner)) return json({ error: "forbidden" }, 403);
  const stub = texStoreStub(env, { [named[1]]: named[2] });
  if (stub === null) return json({ error: "tex_store_unavailable" }, 503);
  return await stub.fetch(
    new Request("https://tex-store.internal/door", { method: "POST", headers: { "x-tex-call": call }, body: await request.arrayBuffer() }),
  );
}
