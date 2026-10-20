/**
 * `/gateway/dreams/start` for the stub: the real route's owner clearance
 * (`ownerClearanceForGateway`, as `clearedOwner` models it), then the answer a
 * test sets, or `started`. Every cleared ask is kept; an uncleared one gets the
 * bare null, as the real route answers every caller who may not ask.
 */

import { createAttentionRoutes } from "./attention.mjs";
import { createMailHealthRoutes } from "./mailHealth.mjs";

/**
 * Also answers `/gateway/attention/ask` (`attention.mjs`, as `.attention`): the
 * other owner-only Tex ask, kept here so the stub's router stays under 1,000 lines.
 * And the person's mailboxes (`mailHealth.mjs`, as `.mailHealth`), owner-only too.
 */
export function createDreamRoutes(clearedOwner) {
  const asks = [];
  const state = { answer: { status: "started" } };
  const attention = createAttentionRoutes(clearedOwner);
  const mailHealth = createMailHealthRoutes(clearedOwner);

  async function handle(path, body) {
    if (path === "/gateway/attention/ask") return await attention.handle(path, body);
    if (path.startsWith("/gateway/mail-health")) return await mailHealth.handle(path, body);
    if (path !== "/gateway/dreams/start") return undefined;
    const cleared = await clearedOwner(body);
    if (!cleared) return { dream: null };
    asks.push({ accessToken: body.accessToken, workspaceId: cleared.workspaceId, userId: cleared.actorUserId });
    return { dream: state.answer };
  }

  return { handle, asks, state, attention, mailHealth };
}
