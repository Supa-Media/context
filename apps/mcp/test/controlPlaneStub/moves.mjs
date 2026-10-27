/**
 * `/gateway/moves/across` for the stub: the engine that carries a note into
 * another workspace (`lib/gatewayRoutes/moveAcross.ts` in the control plane).
 * The real route checks the caller owns the source and may write the
 * destination, with `context:write` and `context:private`; so does this, and
 * answers `{ move: null }` for every refusal, as it does. It moves nothing:
 * the bytes and rows are the engine's, proved in the control plane's own
 * tests, and a gateway test asserts what the gateway asked and that it wrote
 * nothing itself.
 */

export function createMoveRoutes(grantForAccessToken, coveredContexts) {
  const asks = [];
  const state = { answer: { status: "complete", movedObjects: 1, skipped: [] } };

  async function handle(path, body) {
    if (path !== "/gateway/moves/across") return undefined;
    const grant = await grantForAccessToken(body.accessToken);
    if (!grant) return { move: null };
    if (!grant.scopes.includes("context:write") || !grant.scopes.includes("context:private")) return { move: null };
    const reach = coveredContexts(grant);
    const source = reach.find((entry) => entry.workspaceId === body.sourceWorkspaceId);
    const destination = reach.find((entry) => entry.workspaceId === body.destinationWorkspaceId);
    if (source?.role !== "owner" || !["owner", "editor"].includes(destination?.role)) return { move: null };
    asks.push({
      sourceWorkspaceId: body.sourceWorkspaceId,
      destinationWorkspaceId: body.destinationWorkspaceId,
      from: body.from,
      to: body.to,
    });
    return { move: state.answer };
  }

  return { handle, asks, state };
}
