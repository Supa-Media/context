/**
 * Which way a request carried its access token, and the session it resolves to.
 *
 * The token reaches the gateway in an `Authorization: Bearer` header and
 * nowhere else. The app's live sockets, which cannot set one, present a
 * one-use ticket instead (`live/ticket.js`), minted with the header. A token in
 * the URL (`/t/<token>/...`) is refused outright (`route.js`), and a token
 * offered as a socket subprotocol is no token
 * (docs/decisions/gateway-protocol/token-transport.md).
 *
 * So the control plane is told the transport, and for the path form a coarse
 * name for the route. Never the token (the control plane hashes it to find the
 * grant, as for every resolve), never the path past the route, never a slug,
 * never a note: what is recorded is "this grant used a URL token for /mcp,
 * around this hour".
 */
import { bearerToken, resolveSession } from "../session.js";
import { offeredTicket, redeemTicket } from "../live/ticket.js";
import { TREE_PROTOCOL, TREE_SOCKET_PATH } from "../../../../packages/shared/src/treeFrames.cjs";
import { ACCESS_PROTOCOL, ACCESS_SOCKET_PATH } from "../../../../packages/shared/src/accessFrames.cjs";

export const PRESENCE_PROTOCOL = "context.presence";
/** The Tex page's socket (`http/texPage/live.js`), which offers its ticket the same way. */
export const TEX_PAGE_SOCKET_PATH = "/tex/page/live";
export const TEX_PAGE_PROTOCOL = "context.tex-page";

/** The live file tree's socket (`live/treeRoute.js`), which offers its ticket the same way. */
export { TREE_PROTOCOL as TREE_SOCKET_PROTOCOL };

/** The subprotocol each socket path speaks, for the sockets that take a ticket. */
function socketProtocolFor(path) {
  if (path === "/presence") return PRESENCE_PROTOCOL;
  if (path === TREE_SOCKET_PATH) return TREE_PROTOCOL;
  if (path === ACCESS_SOCKET_PATH) return ACCESS_PROTOCOL;
  if (path === TEX_PAGE_SOCKET_PATH) return TEX_PAGE_PROTOCOL;
  return null;
}

/** Whether a socket offered `protocol` among its subprotocols, so the 101 must name it. */
export function offersProtocol(request, protocol = PRESENCE_PROTOCOL) {
  return (request.headers.get("Sec-WebSocket-Protocol") || "").split(",").map((entry) => entry.trim()).includes(protocol);
}

/**
 * The room's answer, naming the one subprotocol the gateway accepted. A
 * browser that offered subprotocols drops a 101 that names none.
 */
export function withPresenceProtocol(response) {
  const headers = new Headers(response.headers);
  headers.set("Sec-WebSocket-Protocol", PRESENCE_PROTOCOL);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers, webSocket: response.webSocket });
}

/**
 * `/t/<token>/...` once carried a token in the URL. `path` is the route after
 * the workspace selector came off, so `/@slug/t/...` is caught too.
 *
 * @param {string} path
 */
export function isRetiredTokenPath(path) {
  return path === "/t" || path.startsWith("/t/");
}

/**
 * The answer to a token in the URL: the same bytes whatever the token, so it
 * says nothing about whether the token was real, and it names the header.
 */
export function retiredTokenPathResponse() {
  return new Response(
    JSON.stringify({
      error: "invalid_request",
      error_description: "Tokens in the URL are not accepted. Send the access token in the Authorization header.",
    }),
    { status: 410, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }
  );
}

/** The only route names a path-token use is recorded under. */
export const PATH_TOKEN_ROUTES = Object.freeze(["mcp", "agent", "inbox", "collaboration", "presence", "agent-activity", "other"]);

/**
 * `path` is the route after the workspace selector and the `/t/<token>`
 * prefix came off, e.g. `/mcp`; anything not named here is "other".
 *
 * @param {string} path
 * @returns {string}
 */
export function pathTokenRoute(path) {
  const under = (prefix) => path === prefix || path.startsWith(`${prefix}/`);
  if (path === "/mcp") return "mcp";
  if (under("/agent-activity")) return "agent-activity";
  if (under("/agent")) return "agent";
  if (path === "/inbox") return "inbox";
  if (path === "/collaboration") return "collaboration";
  if (under("/presence")) return "presence";
  return "other";
}

/**
 * The request's token: the `Authorization` header's, and only that. A path
 * token handed in is still read and counted, for a caller outside `route.js`.
 *
 * @param {Request} request
 * @param {string|null} pathToken
 * @param {string} path
 * @returns {{token: string|null, transport: {kind: "path", route: string} | {kind: "header"} | null}}
 */
export function presentedToken(request, pathToken, path) {
  if (pathToken) return { token: pathToken, transport: { kind: "path", route: pathTokenRoute(path) } };
  const header = bearerToken(request);
  return { token: header, transport: header ? { kind: "header" } : null };
}

/**
 * `resolveSession` for the token this request presented, telling the control
 * plane how it came. Same refusals, same session.
 */
export async function resolvePresentedSession(request, { pathToken, path, slug, controlPlane, env }) {
  // A socket that offered a ticket (`live/ticket.js`) is answered by the ticket alone: a ticket that does not
  // open is refused, never read as "no ticket" and passed on to a token offered beside it.
  const protocol = !pathToken && env ? socketProtocolFor(path) : null;
  const ticket = protocol === null ? null : offeredTicket(request, protocol);
  if (ticket !== null) return await redeemTicket(env, ticket, { socket: path, slug, controlPlane });
  const { token, transport } = presentedToken(request, pathToken, path);
  return await resolveSession(token, slug, controlPlane, transport);
}
