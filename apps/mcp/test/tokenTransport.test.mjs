import { check, controlPlane, env, accessTokenFor, worker } from "./harness.mjs";
import { pathTokenRoute, presentedToken } from "../src/http/presentedToken.js";

/**
 * The URL-token transport is counted before it is retired
 * (docs/decisions/gateway-protocol/token-transport.md): a request whose token
 * came in `/t/<token>/...` tells `/gateway/session` so, with a coarse route
 * name, and nothing else about the request; a header token sends no transport.
 *
 * Sabotage (temporary local edit, reverted): sending `{ transport: "path" }`
 * for header tokens fails "a header token says nothing about transport";
 * passing the raw path as the route fails "the route is a coarse name".
 */
export async function runTokenTransportChecks() {
  const ping = JSON.stringify({ jsonrpc: "2.0", id: 4401, method: "ping", params: {} });
  async function sessionCallFor(path, headers = {}) {
    const before = controlPlane.calls.length;
    const response = await worker.fetch(
      new Request(`https://x${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: ping }),
      env,
      { waitUntil() {} }
    );
    const call = controlPlane.calls.slice(before).find((entry) => entry.path === "/gateway/session");
    return { status: response.status, body: call?.body ?? null };
  }

  const token = accessTokenFor("priv-token");
  const viaPath = await sessionCallFor(`/t/${token}/mcp`);
  check("a URL token still works, unchanged", viaPath.status === 200);
  check("a URL token is reported as such, with its route", viaPath.body?.transport === "path" && viaPath.body?.route === "mcp");
  check(
    "the report carries the token to resolve and nothing else about the request",
    viaPath.body !== null && Object.keys(viaPath.body).sort().join(",") === "accessToken,route,transport"
  );

  const viaHeader = await sessionCallFor("/mcp", { Authorization: `Bearer ${token}` });
  check("a header token still works", viaHeader.status === 200);
  check(
    "a header token says nothing about transport",
    viaHeader.body !== null && viaHeader.body.transport === undefined && viaHeader.body.route === undefined
  );

  check(
    "the route is a coarse name, never the path",
    pathTokenRoute("/mcp") === "mcp" &&
      pathTokenRoute("/presence") === "presence" &&
      pathTokenRoute("/agent-activity") === "agent-activity" &&
      pathTokenRoute("/agent/try") === "agent" &&
      pathTokenRoute("/notes/secret-plan.md") === "other"
  );
  const request = new Request("https://x/mcp", { headers: { Authorization: "Bearer header-token-value-0000" } });
  check(
    "a token in the path wins over a header, as the route always read it",
    presentedToken(request, "path-token-value-00000", "/mcp").token === "path-token-value-00000"
  );
  const socketHeader = new Request("https://x/mcp", {
    headers: { "Sec-WebSocket-Protocol": "context.presence, context.token.subprotocol-token-0000" },
  });
  check("a subprotocol token is read on /presence only", presentedToken(socketHeader, null, "/presence").transport?.kind === "subprotocol");
  check("and is no token anywhere else", presentedToken(socketHeader, null, "/mcp").token === null);
  check("no token at all is no transport", presentedToken(new Request("https://x/mcp"), null, "/mcp").transport === null);
}
