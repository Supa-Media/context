/**
 * TEX CALLS CONTEXT HERE, AND NOWHERE ELSE.
 *
 * Tex is becoming its own service, an MCP client of Context like any other
 * (docs/decisions/texting-assistant/tex-service.md). Every tool call Tex makes
 * as a person goes through `callContextTool`, which takes an MCP `tools/call`
 * request's params (`{ name, arguments }`) and answers with its result.
 *
 * Today the call is answered in-process by the gateway's own MCP dispatcher
 * (`callToolForSession`), so every gate an MCP client meets still runs: the
 * Lab test chat's sandbox, cross-context routing, privacy, staff-only tools.
 * The gateway hands that dispatcher, and the few other parts Tex still takes
 * from it, over at start-up (`texContract/contextGateway.cjs`), so no Tex file
 * imports a gateway module. When Tex moves to its own Worker, this file is
 * where each is swapped for MCP over a service binding, and no caller changes.
 */

import { contextGateway } from "../../shared/src/texContract/contextGateway.cjs";

/**
 * One MCP `tools/call` as the person `session` stands for.
 * `options.legacy` keeps the pre-v2 tool names for the few callers that still use them.
 */
export function callContextTool(store, session, params, options) {
  return contextGateway().callTool(params, store, session, options);
}

/** A `(name, args) => result` dispatcher for one person, the shape Tex's turn and jobs pass around. */
export function contextTools(store, session, options) {
  return (name, args) => callContextTool(store, session, { name, arguments: args }, options);
}

/**
 * One MCP `tools/call` of an action only Tex's own code makes, never its model (`tex_asks`, the held asks:
 * `asks.js`). It goes through the Tex service's door, not the dispatcher a model's calls take, which refuses it.
 */
export function callTexAction(store, session, params) {
  return contextGateway().callTexAction(params, store, session);
}

/**
 * Mark a turn's egress ledger for a call's result as the gateway's dispatcher marks it (`privacy/egress.js`
 * `recordRead`): a mailbox day, a meeting, a sheet, a stranger's frontmatter make the turn untrusted.
 */
export function recordContextRead(ledger, call) {
  contextGateway().recordRead(ledger, call);
}

/** The control-plane client for this deployment (`apps/mcp/src/controlPlane.js` `createControlPlane`). */
export function controlPlaneFor(env) {
  return contextGateway().controlPlane(env);
}

/** Whether a key is the store's own plumbing, never a note anybody wrote (`privacy/engine.js` `isPlumbing`). */
export function isPlumbingKey(key) {
  return contextGateway().isPlumbing(key);
}

/** Whether a grant's names read as its chat's home only (`privacy/engine.js` `readsAsChat`). */
export function namesReadAsChat(names) {
  return contextGateway().readsAsChat(names);
}

/**
 * Whether `path` is one the store's members read, by its own rules (`privacy/state.js` and `engine.js` `canSee` at
 * `team`). False when the rules can't be read.
 */
export function teamCanSee(store, path) {
  return contextGateway().teamCanSee(store, path);
}

/**
 * Ask the egress judge whether the person's own words ask for an action (`privacy/judge.js` `judgeWords`): the same
 * question, asked the same way, as for an MCP client's call. Never throws: anything but a clear yes is a no.
 */
export function judgeContextWords(input, config, options) {
  return contextGateway().judgeWords(input, config, options);
}
