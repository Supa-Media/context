import { check, controlPlane, env, accessTokenFor, worker } from "./harness.mjs";
import { isRetiredTokenPath, pathTokenRoute, presentedToken } from "../src/http/presentedToken.js";

/**
 * The token-in-URL fallback is retired (docs/decisions/gateway-protocol/token-transport.md).
 * `/t/<token>/...` and `/@slug/t/<token>/...` are refused with one fixed 410,
 * before the origin check and before any session is resolved, so a token in a
 * URL is never looked up: valid or not, the control plane never hears of it.
 * The live sockets included: they open on one-use tickets (`liveTicket.test.mjs`),
 * and a token offered as a socket subprotocol is no token either.
 *
 * Sabotage (temporary local edit, reverted): restoring the `/t/` strip in
 * `route.js` fails "a valid token in the URL is refused"; moving the refusal
 * below the session resolve fails "the control plane never sees it".
 */
export async function runTokenTransportChecks() {
  const ping = JSON.stringify({ jsonrpc: "2.0", id: 4401, method: "ping", params: {} });
  async function call(path, headers = {}) {
    const before = controlPlane.calls.length;
    const response = await worker.fetch(
      new Request(`https://x${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: ping }),
      env,
      { waitUntil() {} }
    );
    const sessionCalls = controlPlane.calls.slice(before).filter((entry) => entry.path === "/gateway/session");
    return { status: response.status, text: await response.text(), sessionCalls };
  }

  const token = accessTokenFor("priv-token");
  const answers = [];
  for (const path of [
    `/t/${token}/mcp`,
    `/@alice/t/${token}/mcp`,
    `/t/${token}/inbox`,
    `/t/${token}/collaboration`,
    `/t/${token}/tex/computer`,
    `/t/${token}/presence`,
    `/t/${token}/presence/tree`,
    `/t/${token}/presence/access`,
    `/t/${token}/agent-activity`,
    `/t/${token}/tex/page/live`,
    `/t/not-a-real-token-at-all-000000/mcp`,
    "/t/%zz/mcp",
    "/t",
  ]) {
    const answer = await call(path);
    check(`a token in the URL is refused (${path.replace(token, "<token>")})`, answer.status === 410);
    check(`and the control plane never sees it (${path.replace(token, "<token>")})`, answer.sessionCalls.length === 0);
    answers.push(answer.text);
  }
  check("a valid token in the URL is refused", answers[0] && !answers[0].includes("4401"));
  check("the refusal is the same bytes whatever the token", new Set(answers).size === 1);
  check("the refusal never echoes the token", !answers[0].includes(token));
  check("and names the header instead", answers[0].includes("Authorization header"));

  const evil = await call(`/t/${token}/mcp`, { Origin: "https://evil.example" });
  check("a token in the URL from any origin gets the same refusal", evil.status === 410 && evil.sessionCalls.length === 0);

  const viaHeader = await call("/mcp", { Authorization: `Bearer ${token}` });
  check("a header token still works", viaHeader.status === 200);
  check(
    "and sends the control plane the token and nothing else",
    viaHeader.sessionCalls.length === 1 && Object.keys(viaHeader.sessionCalls[0].body).join(",") === "accessToken"
  );

  check("a path token handed in directly is still counted with its coarse route", pathTokenRoute("/presence") === "presence" && presentedToken(new Request("https://x/presence"), "path-token-value-00000", "/presence").transport?.kind === "path");
  check(
    "only the `/t` segment itself is the retired form",
    isRetiredTokenPath("/t/x/mcp") && isRetiredTokenPath("/t") && !isRetiredTokenPath("/tex/computer") && !isRetiredTokenPath("/mcp") && !isRetiredTokenPath("/tree")
  );
  const socketHeader = new Request("https://x/mcp", {
    headers: { "Sec-WebSocket-Protocol": "context.presence, context.token.subprotocol-token-0000" },
  });
  check("a token offered as a subprotocol is no token, on a socket", presentedToken(socketHeader, null, "/presence").token === null);
  check("or anywhere else", presentedToken(socketHeader, null, "/mcp").token === null);
  check("no token at all is no transport", presentedToken(new Request("https://x/mcp"), null, "/mcp").transport === null);
}
