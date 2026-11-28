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
 *
 * WHAT CONTEXT'S TOOLS ARE IS READ HERE TOO. `listContextTools` is MCP
 * `tools/list` for a session; the catalog below (every definition, the scope
 * sets, the six's action tables) is what that list and `orient`'s manual are
 * built from, static per deployment, so the service reads it once over MCP and
 * caches it. The readings beside it (a six call's carrying tool, an alias's
 * name, an argument check) are pure functions of that catalog. Nothing in Tex
 * imports a gateway tool module any other way (`apps/mcp/src/tools/texSurface.js`).
 */

import * as texSurface from "../../../apps/mcp/src/tools/texSurface.js";

/**
 * One MCP `tools/call` as the person `session` stands for.
 * `options.legacy` keeps the pre-v2 tool names for the few callers that still use them.
 */
export async function callContextTool(store, session, params, options) {
  // Loaded on the first call, not with this file: the dispatcher reaches the whole gateway, and Tex modules that only
  // read the catalog below are loaded early in it (an eager import here put them in its import cycle).
  const { callToolForSession } = await (dispatcher ??= import("../../../apps/mcp/src/tools/session.js"));
  return callToolForSession(params, store, session, options);
}
let dispatcher;

/** A `(name, args) => result` dispatcher for one person, the shape Tex's turn and jobs pass around. */
export function contextTools(store, session, options) {
  return (name, args) => callContextTool(store, session, { name, arguments: args }, options);
}

/**
 * One MCP `tools/call` of an action only Tex's own code makes, never its model (`tex_asks`, the held asks:
 * `asks.js`). It goes through the Tex service's door, not the dispatcher a model's calls take, which refuses it.
 */
export async function callTexAction(store, session, params) {
  const { callTexAction: callTexActionInGateway } = await (dispatcher ??= import("../../../apps/mcp/src/tools/session.js"));
  return callTexActionInGateway(params, store, session);
}

/**
 * MCP `tools/list` for `session`: `shape` "v2" (the six), "v1" (the older names) or "all" (every tool it may call,
 * unlisted ones included). `disabled`, when passed, is the plugin switches already read (`disabledContextTools`).
 */
export function listContextTools(store, session, options) {
  return texSurface.toolsForSession(session, store, options);
}

/** The tool names a context's owner turned off with its plugin, as a Set (unreadable settings mean none). */
export function disabledContextTools(store) {
  return texSurface.disabledToolNames(store);
}

// The catalog: every tool's definition, the scope sets and the six's action tables.
export const toolDefinitions = () => texSurface.toolDefinitions();
export const toolIsWriting = (name) => texSurface.toolIsWriting(name);
export const { PRIVATE_TIER_ONLY_TOOLS, STAFF_ONLY_TOOLS, UNLISTED_TOOLS, V2_ONLY_TOOLS, ACTIONS } = texSurface;

// Pure readings of a call against the catalog.
export const canonicalToolName = (name) => texSurface.canonicalToolName(name);
export const validateArguments = (schema, args) => texSurface.validateArguments(schema, args);
export const translateV2Params = (...args) => texSurface.translateV2Params(...args);
export const actionArguments = (...args) => texSurface.actionArguments(...args);
export const resultInV2Names = (result) => texSurface.resultInV2Names(result);
export const lastShownSend = (history) => texSurface.lastShownSend(history);

// A file's words, as `read_file` takes them out (`tools/readFile.js`).
export const { MAX_FILE_BYTES, QUOTATION } = texSurface;
export const fileWords = (...args) => texSurface.fileWords(...args);
export const pdfPagesPart = (uri, bytes) => texSurface.pdfPagesPart(uri, bytes);
export const readableFileType = (path) => texSurface.readableFileType(path);
export const typeOfFile = (name, bytes) => texSurface.typeOfFile(name, bytes);
export const wordsWithoutPages = (read) => texSurface.wordsWithoutPages(read);

/** The tools a standing forward run may use (`tools/forwardRule.js`). */
export const standingForwardTools = (store, routine, offered) => texSurface.standingForwardTools(store, routine, offered);
