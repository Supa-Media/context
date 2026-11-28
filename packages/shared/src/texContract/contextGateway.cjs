/**
 * WHAT TEX STILL TAKES FROM THE GATEWAY IT RUNS IN, HANDED OVER AT START-UP RATHER THAN IMPORTED.
 *
 * Tex is becoming its own service, an MCP client of Context like any other
 * (docs/decisions/texting-assistant/tex-service.md). Until it moves out, the gateway answers a few of its needs
 * in-process: an MCP `tools/call` as one person, a call of an action only Tex's own code makes, marking a turn's egress ledger for a read, the privacy engine's
 * answers about a key, the egress judge, and the control-plane client. The gateway connects them here once, when its dispatcher loads
 * (`apps/mcp/src/tools/session.js`), and Tex reaches them only through `packages/tex/gateway/contextMcp.js`, so Tex's
 * code imports no gateway module and each of these is one named seam to swap for MCP when it moves.
 *
 * Nothing here decides anything: each function is the gateway's own, unchanged, so every gate and privacy rule still
 * runs where it ran.
 */

/** The names the gateway must hand over, every one a function. */
const CONTEXT_GATEWAY_PARTS = Object.freeze(["callTool", "callTexAction", "recordRead", "controlPlane", "isPlumbing", "readsAsChat", "teamCanSee", "judgeWords"]);

let connected = null;

/**
 * Connect the gateway's parts. Once per isolate: connecting again with the very same functions is a no-op, and with
 * any other is refused, so nothing loaded later can swap the dispatcher Tex calls through.
 */
function connectContextGateway(parts) {
  const given = {};
  for (const name of CONTEXT_GATEWAY_PARTS) {
    if (typeof parts?.[name] !== "function") throw new TypeError(`connectContextGateway: ${name} must be a function`);
    given[name] = parts[name];
  }
  if (connected !== null) {
    if (CONTEXT_GATEWAY_PARTS.every((name) => connected[name] === given[name])) return;
    throw new Error("connectContextGateway: the gateway is already connected");
  }
  connected = Object.freeze(given);
}

/** The gateway's parts, or a loud failure when no gateway has connected (Tex code run without one). */
function contextGateway() {
  if (connected === null) throw new Error("contextGateway: no gateway has connected (apps/mcp/src/tools/session.js connects it)");
  return connected;
}

module.exports = { CONTEXT_GATEWAY_PARTS, connectContextGateway, contextGateway };
