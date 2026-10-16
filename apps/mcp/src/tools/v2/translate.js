/**
 * A v2 call, translated into the one existing tool call it stands for.
 *
 * Runs first in `callToolForSession`, before routing, so everything that
 * decides authority (the context a call reaches, the write gate, the egress
 * gate, argument validation against the existing tool's schema, audit) sees
 * the translated call and decides it exactly as it did before v2. This file
 * decides nothing about access: every answer it can give is a function of the
 * caller's own arguments and the published action table.
 */

import { validateArguments } from "../../toolArguments.js";
import { ACTION_TOOLS, ACTIONS, actionOf } from "./actions.js";
import { translateFetch, translateSearch } from "./searchFetch.js";

/** v2 names that are translated here. `orient` is answered by itself. */
export const TRANSLATED_TOOLS = new Set([...ACTION_TOOLS, "search", "fetch"]);

/** Longest action name echoed back in a refusal. */
const ECHO_CAP = 40;

function listOf(tool) {
  return Object.keys(ACTIONS[tool]).join(", ");
}

/**
 * `{ params }` to call instead, or `{ error }` to answer with.
 *
 * @param {{name?: string, arguments?: object}} params
 * @param {{schemaFor: (name: string) => object | null, coerce?: Function, app?: {client?: string | null}}} options
 *   `schemaFor` is the advertised schema lookup (`advertised.js`), passed in
 *   so this module does not import the registry it is listed in.
 */
export function translateV2Params(params, { schemaFor, coerce = (_name, args) => args, app = {} }) {
  const name = params?.name;
  if (!TRANSLATED_TOOLS.has(name)) return { params };
  // Read as the advertised types first, as `routeToolCall` does: an app
  // whose copy of `args` has no type sends it as JSON text.
  const supplied = coerce(name, params?.arguments);
  const args = supplied && typeof supplied === "object" && !Array.isArray(supplied) ? supplied : {};

  const schema = schemaFor(name);
  if (schema) {
    const refusal = validateArguments(schema, args);
    if (refusal) return { error: refusal };
  }

  let translated;
  if (name === "search") translated = translateSearch(args, app);
  else if (name === "fetch") translated = translateFetch(args, app);
  else translated = translateAction(name, args);
  if (translated.error) return { error: translated.error };

  const out = { ...translated.arguments };
  const addressed = addressing(args, out);
  if (addressed.error) return { error: addressed.error };
  return { params: { ...params, name: translated.name, arguments: out }, v2: { tool: name, action: translated.action } };
}

function translateAction(tool, args) {
  const action = actionOf(tool, args);
  if (typeof action !== "string" || action === "") {
    return { error: `${tool} needs an action: one of ${listOf(tool)}. orient lists what each takes.` };
  }
  if (!Object.hasOwn(ACTIONS[tool], action)) {
    const shown = action.length > ECHO_CAP ? `${action.slice(0, ECHO_CAP)}…` : action;
    return {
      error: `${tool} has no action "${shown}". Its actions: ${listOf(tool)}. orient lists what each takes.`,
    };
  }
  const entry = ACTIONS[tool][action];
  const call = { path: args.path, content: args.content, expected_etag: args.expected_etag, args: args.args };
  return { name: entry.tool, arguments: entry.take(call), action };
}

/**
 * `context` and `mailbox` belong to the call, not the action: carried to the
 * top of the translated arguments, where routing reads them. One written
 * inside `args` counts too, but a call that names two different contexts is
 * refused rather than guessed at.
 */
function addressing(args, out) {
  for (const key of ["context", "mailbox"]) {
    const outer = args[key];
    const inner = out[key];
    if (outer !== undefined && inner !== undefined && outer !== inner) {
      return { error: `that call names two different values for ${key}; pass it once.` };
    }
    if (outer !== undefined) out[key] = outer;
  }
  return {};
}
