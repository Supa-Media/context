/**
 * Which way a request carried its access token, and the session it resolves to.
 *
 * The token reaches the gateway one of two ways: an `Authorization: Bearer`
 * header, or the `/t/<token>/...` path fallback for a client that cannot set
 * one. Both resolve identically (`resolveSession`). The path form puts the
 * token where browser history, proxy logs and referrers keep it, so it is on
 * its way out, and taking it out without breaking somebody's connection first
 * needs to know who still uses it (docs/decisions/gateway-protocol/token-transport.md).
 *
 * So the control plane is told the transport, and for the path form a coarse
 * name for the route. Never the token (the control plane hashes it to find the
 * grant, as for every resolve), never the path past the route, never a slug,
 * never a note: what is recorded is "this grant used a URL token for /mcp,
 * around this hour".
 */
import { bearerToken, resolveSession } from "../session.js";

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

export const PRESENCE_PROTOCOL = "context.presence";
const TOKEN_PROTOCOL_PREFIX = "context.token.";

/** The live file tree's socket (`live/treeRoute.js`), which offers its token the same way. */
export { TREE_PROTOCOL as TREE_SOCKET_PROTOCOL };

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
  // Only the presence and tree sockets read a subprotocol token: everywhere else the
  // header is the way, and a header that names a socket protocol is no token.
  const offered =
    path === "/presence" ? subprotocolToken(request) : path === TREE_SOCKET_PATH ? subprotocolToken(request, TREE_PROTOCOL) : null;
  if (offered) return { token: offered, transport: { kind: "subprotocol" } };
  const header = bearerToken(request);
  return { token: header, transport: header ? { kind: "header" } : null };
}

/**
 * `resolveSession` for the token this request presented, telling the control
 * plane how it came. Same refusals, same session.
 */
export async function resolvePresentedSession(request, { pathToken, path, slug, controlPlane }) {
  const { token, transport } = presentedToken(request, pathToken, path);
  return await resolveSession(token, slug, controlPlane, transport);
}
