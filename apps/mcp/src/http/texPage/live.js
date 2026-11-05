/**
 * `GET /tex/page/live?handle=<handle>&chat=<me|groupKey>` — the Tex page's
 * socket (decided by the owner, 2026-11-02). It authorizes like `/tex/page`
 * (`page.js`): the console's own client, the page's own handle, a chat the
 * person is in now, and a key they are not in is refused exactly as one that
 * names nothing. It opens on a one-use ticket offered as a subprotocol beside
 * `context.tex-page` (`live/ticket.js`), so no token is on the socket, and the
 * ticket is never echoed back.
 *
 * Then the upgrade goes to the chat's own Tex object (`texStore/pageLive.js`),
 * on a request built from nothing but the viewer this route decided: their
 * deadline (the grant's expiry, at most five minutes), the chat as the texting
 * Worker knows it, and their time zone. No header the client sent reaches the
 * object. When the deadline passes the object closes the socket (4001) and
 * the app comes back through here, so a person taken out of a chat, or a
 * revoked grant, stops hearing it within that time.
 */

import { resolvePresentedSession, TEX_PAGE_PROTOCOL, TEX_PAGE_SOCKET_PATH } from "../presentedToken.js";
import { SessionRefusal } from "../../session.js";
import { createControlPlane } from "../../controlPlane.js";
import { forbiddenResponse, unauthorizedResponse } from "../../oauth.js";
import { json } from "../responses.js";
import { texStoreStub } from "../../texStore/wire.js";
import { PAGE_LIVE_PATH, PAGE_SOCKET_MAX_MS, PAGE_VIEWER_HEADER } from "../../texStore/pageLive.js";
import { PageRefusal, chatOf, checkViewer, loadPage } from "./page.js";

export { TEX_PAGE_SOCKET_PATH };

const upgradedResponse = (headers, webSocket) => new Response(null, { status: 101, headers, webSocket });

export async function handleTexPageLive(request, env, { slug, pathToken, origin }, deps = {}) {
  if (request.method !== "GET") return new Response(null, { status: 405 });
  if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") return new Response("expected a websocket upgrade", { status: 426 });
  if (!env.TEX_STORE) return json({ error: "page_live_unavailable" }, 501);
  const controlPlane = deps.controlPlane ?? createControlPlane(env);
  let session;
  try {
    session = await resolvePresentedSession(request, { pathToken, path: TEX_PAGE_SOCKET_PATH, slug, controlPlane, env });
  } catch (error) {
    if (!(error instanceof SessionRefusal)) throw error;
    return error.status === 403 ? forbiddenResponse(origin, null, error) : unauthorizedResponse(origin, slug, error);
  }
  const url = new URL(request.url);
  let page;
  let chat;
  try {
    checkViewer(session, url.searchParams.get("handle"));
    page = await loadPage(controlPlane, session);
    chat = chatOf(page, url.searchParams.get("chat") ?? "me");
  } catch (error) {
    if (!(error instanceof PageRefusal)) throw error;
    return error.response();
  }
  const stub = texStoreStub(env, chat.owner);
  if (stub === null) return json({ error: "page_live_unavailable" }, 501);
  const expiresAt = typeof session.expiresAt === "number" ? session.expiresAt : Infinity;
  const viewer = {
    deadline: Math.min(expiresAt, Date.now() + PAGE_SOCKET_MAX_MS),
    chat: chat.jobsChat,
    ...(typeof page.timeZone === "string" ? { timeZone: page.timeZone } : {}),
  };
  const forwarded = new Request(`https://tex-store.internal${PAGE_LIVE_PATH}`, {
    headers: { Upgrade: "websocket", [PAGE_VIEWER_HEADER]: JSON.stringify(viewer) },
  });
  const response = await stub.fetch(forwarded);
  console.log(JSON.stringify({ event: "tex_page_live", outcome: response.status === 101 ? "opened" : "refused", workspace_id: session.workspaceId ?? null, grant_id: session.grantId ?? null }));
  if (response.status !== 101) return response;
  const headers = new Headers(response.headers);
  headers.set("Sec-WebSocket-Protocol", TEX_PAGE_PROTOCOL);
  return (deps.upgraded ?? upgradedResponse)(headers, response.webSocket);
}
