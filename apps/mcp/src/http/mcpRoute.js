/**
 * `/mcp`: one MCP request, every step timed by the MCP entry point
 * (`mcp/mcpEntryPoint.js`). The function between the markers holds only
 * high-level steps, each `await mcp.step("name", ...)`, so where a call's time
 * goes is read off `mcp_entry` rather than guessed (Dev2, 2026-11-02).
 *
 * The checks are the ones `route.js` asks of every transport path, in the
 * same order: the session (a refusal before anything is read), the read
 * scope, then the store. Nothing here decides who may see what; the store
 * and the tools do, exactly as before.
 */

import { forbiddenResponse, unauthorizedResponse } from "../oauth.js";
import { resolvePresentedSession } from "./presentedToken.js";
import { attachPinnedDoors } from "./pinnedDoors.js";
import { attachContextOpener, namedContextsIn, onceEach, peekBody, prefetchNamedContexts } from "./contextOpener.js";
import { hasScope, SCOPE_READ, SessionRefusal, StorageUnavailable, storeForSession } from "../session.js";
import { json } from "./responses.js";
import { createControlPlane } from "../controlPlane.js";
import { decorateRequestStore } from "./requestStore.js";
import { handleMcp } from "../mcp/handlers.js";
import { callOf, mcpEntry } from "../mcp/mcpEntryPoint.js";
import { PINNED_CONTEXT_NAME } from "../orient/globalNote.js";
import { judgeFor } from "../privacy/judge.js";

export async function serveMcp(request, env, ctx, { slug, pathToken, origin }) {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  // MCP ENTRY POINT: begin
  const mcp = mcpEntry(env);
  const controlPlane = createControlPlane(env, { fetchImpl: mcp.fetchFor("cp") });
  const session = await mcp.step("session", () => sessionOrRefusal(request, { pathToken, slug, controlPlane, origin }));
  if (session instanceof Response) return mcp.done(session);
  mcp.workspace = session.workspaceId;
  mcp.client = session.actorClientName;
  armSharingJudge(session, env);
  const body = await mcp.step("read_body", () => peekBody(request));
  mcp.call = callOf(body);
  const refusal = scopeRefusal(session, origin);
  if (refusal) return mcp.done(refusal);
  const openOnce = onceEach((target) => mcp.step("open_other_context", () => storeForSession(target, env, controlPlane)).then(mcp.watch));
  prefetchNamedContexts(session, namedContextsIn(body), openOnce);
  const store = await mcp.step("open_store", () => storeOrRefusal(session, env, controlPlane));
  if (store instanceof Response) return mcp.done(store);
  equip(mcp.watch(store), { session, env, controlPlane, ctx, request, origin, openOnce, mcp });
  const response = await mcp.step("answer", () => handleMcp(request, store, session));
  return mcp.done(response);
  // MCP ENTRY POINT: end
}

/** The session this request's token resolves to, or the refusal `route.js` gives every transport path. */
async function sessionOrRefusal(request, { pathToken, slug, controlPlane, origin }) {
  try {
    return await resolvePresentedSession(request, { pathToken, path: "/mcp", slug, controlPlane });
  } catch (error) {
    if (!(error instanceof SessionRefusal)) throw error;
    // A 403 drops the slug from its challenge, so "a context you cannot reach"
    // and "a name nobody registered" are byte-identical (`route.js`).
    return error.status === 403 ? forbiddenResponse(origin, null, error) : unauthorizedResponse(origin, slug, error);
  }
}

/** The sharing judge (the owner, 2026-10-18), on the session before any other workspace's is derived from it: off unless set. */
function armSharingJudge(session, env) {
  if (env.SHARING_JUDGE !== "on") return;
  const judge = judgeFor(env);
  if (judge) session.sharingJudge = judge;
}

/** `/mcp` asks for read; every write is checked per call by the connection's clamp. */
function scopeRefusal(session, origin) {
  if (hasScope(session, SCOPE_READ)) return null;
  return forbiddenResponse(origin, null, {
    description: `This connection does not hold the ${SCOPE_READ} scope.`,
    scope: [SCOPE_READ],
  });
}

/** The session's own store, or the 503 for a workspace with no reachable storage: a refusal, never a fallback. */
async function storeOrRefusal(session, env, controlPlane) {
  try {
    return await storeForSession(session, env, controlPlane);
  } catch (error) {
    if (!(error instanceof StorageUnavailable)) throw error;
    return json(
      {
        error: "storage_unavailable",
        error_description: "This context has no reachable storage. Reconnect it from the dashboard.",
      },
      503,
    );
  }
}

/** Everything the request's store carries for the tools, laid on in one place; the other workspaces it opens are timed too. */
function equip(store, { session, env, controlPlane, ctx, request, origin, openOnce, mcp }) {
  decorateRequestStore(store, { session, env, controlPlane, ctx, request, origin });
  attachContextOpener(store, session, { env, controlPlane, origin, openOnce, pinnedName: PINNED_CONTEXT_NAME });
  attachPinnedDoors(store, session, (sibling) => mcp.step("open_pinned_context", () => storeForSession(sibling, env, controlPlane)).then(mcp.watch));
}
