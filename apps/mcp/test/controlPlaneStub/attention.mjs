/**
 * `/gateway/attention/ask` for the stub: the real route's owner clearance
 * (`ownerClearanceForGateway`, as `clearedOwner` models it), then the answer a
 * test sets, or `soon`. Every cleared ask is kept; an uncleared one gets the
 * bare null, as the real route answers every caller who may not ask.
 */

export function createAttentionRoutes(clearedOwner) {
  const asks = [];
  const state = { answer: null };

  async function handle(path, body) {
    if (path !== "/gateway/attention/ask") return undefined;
    const cleared = await clearedOwner(body);
    if (!cleared) return { attention: null };
    asks.push({
      accessToken: body.accessToken,
      workspaceId: cleared.workspaceId,
      userId: cleared.actorUserId,
      urgency: body.urgency,
      deliver: body.deliver,
    });
    const answer =
      state.answer ?? (body.deliver ? { status: "soon", dueAt: Date.now() + 30_000, timeZone: "UTC" } : { status: "held", timeZone: "UTC" });
    return { attention: answer };
  }

  return { handle, asks, state };
}
