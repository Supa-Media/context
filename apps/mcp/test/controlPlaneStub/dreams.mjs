/**
 * `/gateway/dreams/start` for the stub: the real route's owner clearance
 * (`ownerClearanceForGateway`, as `clearedOwner` models it), then the answer a
 * test sets, or `started`. Every cleared ask is kept; an uncleared one gets the
 * bare null, as the real route answers every caller who may not ask.
 */

export function createDreamRoutes(clearedOwner) {
  const asks = [];
  const state = { answer: { status: "started" } };

  async function handle(path, body) {
    if (path !== "/gateway/dreams/start") return undefined;
    const cleared = await clearedOwner(body);
    if (!cleared) return { dream: null };
    asks.push({ accessToken: body.accessToken, workspaceId: cleared.workspaceId, userId: cleared.actorUserId });
    return { dream: state.answer };
  }

  return { handle, asks, state };
}
