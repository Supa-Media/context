/**
 * TEX CALLS CONTEXT'S TOOLS HERE, AND NOWHERE ELSE.
 *
 * Tex is becoming its own service, an MCP client of Context like any other
 * (docs/decisions/texting-assistant/tex-service.md). Every tool call Tex makes
 * as a person goes through `callContextTool`, which takes an MCP `tools/call`
 * request's params (`{ name, arguments }`) and answers with its result.
 *
 * Today the call is answered in-process by the gateway's own MCP dispatcher
 * (`callToolForSession`), so every gate an MCP client meets still runs: the
 * Lab test chat's sandbox, cross-context routing, privacy, staff-only tools.
 * When Tex moves to its own Worker, this file is where the in-process call is
 * swapped for MCP over a service binding, and no caller changes.
 */

import { callToolForSession } from "../../../apps/mcp/src/tools/session.js";

/**
 * One MCP `tools/call` as the person `session` stands for.
 * `options.legacy` keeps the pre-v2 tool names for the few callers that still use them.
 */
export function callContextTool(store, session, params, options) {
  return callToolForSession(params, store, session, options);
}

/** A `(name, args) => result` dispatcher for one person, the shape Tex's turn and jobs pass around. */
export function contextTools(store, session, options) {
  return (name, args) => callContextTool(store, session, { name, arguments: args }, options);
}
