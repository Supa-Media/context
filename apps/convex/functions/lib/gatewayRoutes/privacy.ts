/**
 * `POST /gateway/privacy`: the gateway's half of the access rows. The gateway's store writes one row's access
 * through `apps/mcp/src/store/privacyAuthority.js`, and each of that store's calls to the control plane arrives
 * here (`setAccess`, `addGrantees`). There is no `privacy.md` to write.
 *
 * Both proofs, as `/gateway/binding`: the gateway secret (the factory) and the
 * person's access token. The workspace is the grant's, compared with the one
 * the gateway names and used only after it matches, so no request can change
 * the access of a workspace its token does not reach.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { hashToken } from "../crypto";
import { json, stringField } from "../gatewayAuth";
import { addGranteesOp, setAccessOp } from "./privacySetAccess";

/** The grant scope that may change a workspace's notes, and so its access. */
const SCOPE_WRITE = "context:write";

export async function gatewayPrivacyHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const refused = () => json({ ok: false });
  const accessToken = stringField(body, "accessToken");
  const expected = stringField(body, "expectedWorkspaceId");
  const op = stringField(body, "op");
  if (accessToken === null || expected === null || op === null) return refused();
  // The id the gateway named is compared, never looked up: it must be the one the proof reaches.
  let reached: string | undefined;
  let actor: { userId: Id<"users">; role: "owner" | "editor" } | undefined;
  if (accessToken !== null) {
    const session = await ctx.runQuery(internal.functions.controlPlane.resolveGrantByAccessToken, {
      hashedAccessToken: await hashToken(accessToken),
    });
    const entry = session?.workspaces.find((workspace) => workspace.workspaceId === expected);
    // Only a grant that may write the workspace ever writes its `privacy.md`
    // (a move carries its exceptions): the gateway decides which rules, and
    // this refuses everyone else, so a gateway bug is never a member
    // rewriting who sees what.
    const writes = entry !== undefined && (entry.role === "owner" || entry.role === "editor") &&
      (session?.scopes ?? []).includes(SCOPE_WRITE);
    reached = writes ? entry.workspaceId : undefined;
    if (writes && session) actor = { userId: session.actorUserId, role: entry.role as "owner" | "editor" };
  }
  if (reached === undefined) return refused();
  const workspaceId = reached as Id<"workspaces">;

  if (op === "setAccess") {
    // A tier or list set on one row. Only meaningful once the rows are the truth; `nodesAccess.setAccess` says so.
    if (actor === undefined) return refused();
    return await setAccessOp(ctx, body, workspaceId, actor);
  }
  if (op === "addGrantees") {
    // People named on one row by an AI client, after the person's yes. The rows decide; owner only.
    if (actor === undefined) return refused();
    return await addGranteesOp(ctx, body, workspaceId, actor);
  }
  return refused();
}
