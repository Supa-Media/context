/**
 * Which way a request carried its access token, and the session it resolves to.
 *
 * The token reaches the gateway in an `Authorization: Bearer` header, or, on
 * the app's live sockets, as a subprotocol (below) or, from older app builds,
 * in a `/t/<token>/...` path. Every other route refuses the path form outright
 * (`route.js`, retired 2026-11-05); on the sockets it is still counted until
 * it is retired there too (docs/decisions/gateway-protocol/token-transport.md).
 *
 * So the control plane is told the transport, and for the path form a coarse
 * name for the route. Never the token (the control plane hashes it to find the
 * grant, as for every resolve), never the path past the route, never a slug,
 * never a note: what is recorded is "this grant used a URL token for /mcp,
 * around this hour".
 */
import { bearerToken, resolveSession } from "../session.js";
import { offeredTicket, redeemTicket } from "../live/ticket.js";

/**
 * A browser `WebSocket` cannot set an Authorization header, which is why the
 * app's presence socket used to put its token in the URL. It now offers two
 * subprotocols instead, `context.presence` and `context.token.<token>`: the
 * token rides in the `Sec-WebSocket-Protocol` request header, which history,
 * referrers and URL logs never see, and the gateway answers with
 * `context.presence` alone (`withPresenceProtocol`), so the token is never
 * echoed. Access tokens are base64url, which is a valid subprotocol token.
 */
import { TREE_PROTOCOL, TREE_SOCKET_PATH } from "../../../../packages/shared/src/treeFrames.cjs";
import { ACCESS_PROTOCOL, ACCESS_SOCKET_PATH } from "../../../../packages/shared/src/accessFrames.cjs";

export const PRESENCE_PROTOCOL = "context.presence";
/** The Tex page's socket (`http/texPage/live.js`), which offers its token the same way. */
export const TEX_PAGE_SOCKET_PATH = "/tex/page/live";
export const TEX_PAGE_PROTOCOL = "context.tex-page";
const TOKEN_PROTOCOL_PREFIX = "context.token.";

/** The live file tree's socket (`live/treeRoute.js`), which offers its token the same way. */
export { TREE_PROTOCOL as TREE_SOCKET_PROTOCOL };

/** The subprotocol each socket path speaks, for the sockets that take a ticket or a subprotocol token. */
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

/** The token a socket offered as a subprotocol beside `protocol`, or null. */
export function subprotocolToken(request, protocol = PRESENCE_PROTOCOL) {
  const offered = (request.headers.get("Sec-WebSocket-Protocol") || "").split(",").map((entry) => entry.trim());
  if (!offered.includes(protocol)) return null;
  const entry = offered.find((value) => value.startsWith(TOKEN_PROTOCOL_PREFIX));
  const token = entry === undefined ? "" : entry.slice(TOKEN_PROTOCOL_PREFIX.length);
  return token || null;
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
 * The only routes that still read a token in the URL: the live sockets, whose
 * older app builds put it there (`route.js`). Everything else answers
 * `retiredTokenPathResponse`.
 */
export const LIVE_SOCKET_PATHS = new Set(["/presence", "/agent-activity", TREE_SOCKET_PATH, ACCESS_SOCKET_PATH, TEX_PAGE_SOCKET_PATH]);

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
 * The request's token, from the path when it came there, else a socket's
 * subprotocol, else the header, and how it came.
 *
 * @param {Request} request
 * @param {string|null} pathToken
 * @param {string} path
 * @returns {{token: string|null, transport: {kind: "path", route: string} | {kind: "subprotocol"} | {kind: "header"} | null}}
 */
export function presentedToken(request, pathToken, path) {
  if (pathToken) return { token: pathToken, transport: { kind: "path", route: pathTokenRoute(path) } };
  // Only the presence, tree, access and Tex page sockets read a subprotocol token: everywhere else the
  // header is the way, and a header that names a socket protocol is no token.
  const protocol = socketProtocolFor(path);
  const offered = protocol === null ? null : subprotocolToken(request, protocol);
  if (offered) return { token: offered, transport: { kind: "subprotocol" } };
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
