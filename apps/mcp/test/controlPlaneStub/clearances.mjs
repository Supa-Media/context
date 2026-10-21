/**
 * The control plane's three gateway clearances, for the stub: who may act on
 * a workspace as its owner, as an owner or editor, and on their own Google
 * account. Each answers the request's grant and the workspace it names.
 */

export function createClearances(grantForAccessToken, coveredContexts) {
  /**
   * The owner clearance the three link routes share.
   *
   * Lifted out rather than repeated three times: three copies is how one of
   * them ends up missing the `context:private` line, which is exactly the
   * mistake a stub must not teach the tests to accept.
   */
  async function clearedOwner(body) {
    const grant = await grantForAccessToken(body.accessToken);
    if (!grant) return null;
    const named = coveredContexts(grant).find(
      (entry) => entry.workspaceId === body.expectedWorkspaceId,
    );
    if (!named || named.role !== "owner") return null;
    if (!grant.scopes.includes("context:write") || !grant.scopes.includes("context:private")) {
      return null;
    }
    return { workspaceId: named.workspaceId, actorUserId: grant.userId };
  }

  /** The real route's owner-or-editor clearance (`gatewayEditorClearance`). */
  async function clearedEditor(body) {
    const grant = await grantForAccessToken(body.accessToken);
    if (!grant) return null;
    const named = coveredContexts(grant).find(
      (entry) => entry.workspaceId === body.expectedWorkspaceId,
    );
    if (!named || (named.role !== "owner" && named.role !== "editor")) return null;
    if (!grant.scopes.includes("context:write")) return null;
    return { workspaceId: named.workspaceId, actorUserId: grant.userId, role: named.role };
  }

  /**
   * Whose own account one email or calendar change acts on
   * (`apps/convex/functions/lib/controlPlane/ownAccount.ts`): a group chat's
   * grant for the chat's own workspace, whatever its role, or an editor's.
   */
  async function clearedOwnAccount(body) {
    const grant = await grantForAccessToken(body.accessToken);
    if (grant?.clientId === "context_texts_group") {
      return grant.workspaceId === body.expectedWorkspaceId ? { workspaceId: grant.workspaceId, actorUserId: grant.userId } : null;
    }
    return await clearedEditor(body);
  }

  return { clearedOwner, clearedEditor, clearedOwnAccount };
}
