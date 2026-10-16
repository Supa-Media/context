/**
 * What a connection is offered and what it may call: the advertised tool
 * list, the alias and unlisted tables, and argument validation against the
 * advertised schema. TOOL_NAME_ALIASES and UNLISTED_TOOLS are read off THIS
 * FILE by toolArguments.test.mjs (see test/gatewaySource.mjs).
 */

import { disabledToolNames } from "../plugins/enablement.js";
import {
  PRIVATE_TIER_ONLY_TOOLS,
  EXISTENCE_MASKED_TOOLS as registryExistenceMaskedTools,
  toolDefinitions as registryToolDefinitions,
  toolExistenceMasked,
} from "./registry.js";
import { readsPrivateAnywhere, writesAnywhere } from "../session.js";
import { validateArguments } from "../toolArguments.js";

export const toolDefinitions = registryToolDefinitions;
export const EXISTENCE_MASKED_TOOLS = registryExistenceMaskedTools;

/**
 * Names still dispatched that `tools/list` no longer advertises.
 *
 * `archive_chat` is what `save_context` shipped as, and a client holding a
 * cached tool list still calls it. It is a live dispatch path, so it needs a
 * schema like every other one — the alias resolves to the schema of the tool
 * it became, which is exactly what such a client is sending arguments for.
 * A dispatch case with neither a definition nor an entry here fails the
 * census test rather than quietly skipping validation.
 */
const TOOL_NAME_ALIASES = new Map([["archive_chat", "save_context"]]);

/**
 * Tools still defined and still dispatched that `tools/list` no longer offers.
 *
 * `create_form` is the first. It shipped to close a real gap — an agent asked
 * for "an intake form" had to know the block's keys, its field types, that
 * `max` is mandatory on a `line` — and that gap was closed a better way
 * instead. PR #782 found the reason: a client caches `tools/list` and
 * re-fetches on its own schedule, so a tool added after it connected is not
 * callable by name however correct it is. The fix was to put the block's
 * grammar into `write_note`'s description, which every client already holds.
 * `write_note` now says, in as many words, that it makes forms and that no
 * separate tool is needed.
 *
 * That leaves `create_form` rendering a block `write_note` would have accepted
 * as text, through the same write path, behind a name most clients never see.
 * A second way to do one thing is a second thing to keep true: every rule
 * about the block — a new field type, a new key, a refusal — has to be taught
 * twice, and the copy nobody can call is the copy that quietly rots.
 *
 * It is unlisted rather than deleted because a client that *did* fetch it is
 * still holding it, and a tool that vanishes mid-session is an error in
 * somebody's chat rather than a tidier server. The dispatch case and the
 * schema both stay, so such a call still works and its arguments are still
 * validated against what this server advertises now — the same arrangement
 * `archive_chat` has had since it was renamed.
 */
const UNLISTED_TOOLS = new Set(["create_form"]);

/**
 * The six tools an MCP client is offered since v2 (decided 2026-10-16,
 * docs/decisions/gateway-protocol/six-tools.md). Every other tool is still
 * defined, still validated and still answered by name, for a client holding
 * a copy of the list from before; it is simply no longer offered. The texting
 * assistant, whose list is built fresh every turn, keeps the full list
 * (`shape: "v1"`) until its own prompts move.
 */
export const V2_TOOLS = new Set(["orient", "search", "fetch", "write", "manage", "send"]);

/** The v2-only names, which the full (v1) list does not show. */
const V2_ONLY_TOOLS = new Set(["write", "manage", "send"]);

/** The advertised schema for a name, for `v2/translate.js`. */
export function advertisedSchema(name) {
  return advertisedSchemaFor(name);
}

/**
 * The name a tool is known by in the dispatch table: an alias resolved, any
 * other name unchanged. The egress gate classifies a call by this, never by
 * the spelling the client used, because a gate that reads the old name of
 * `save_context` as a tool it has never heard of lets that name publish.
 */
export function canonicalToolName(name) {
  return TOOL_NAME_ALIASES.get(name) ?? name;
}

/**
 * The advertised `inputSchema` for a tool name, alias resolved.
 *
 * Built once per isolate. `toolDefinitions()` rebuilds the advertised objects
 * from constants on every call and is already called twice per tool call; a
 * third rebuild to answer "what did we advertise for this name" would be pure
 * waste on the hot path. Nothing mutates the result, and every input to it is
 * a module constant, so there is nothing to invalidate.
 */
let advertisedSchemas = null;
function advertisedSchemaFor(name) {
  if (!advertisedSchemas) {
    advertisedSchemas = new Map(toolDefinitions().map((tool) => [tool.name, tool.inputSchema]));
  }
  return advertisedSchemas.get(TOOL_NAME_ALIASES.get(name) ?? name) ?? null;
}

/**
 * The arguments with each top-level value a stale client sent as text read
 * as the type the advertised schema gives it, or `args` itself when nothing
 * needs reading.
 *
 * A client builds a call from its own copy of a tool. A property that copy
 * does not show has no type there, so a client such as Claude Code sends
 * what the model wrote as a string: `orient { tools: true }` arrived as
 * `tools: "true"` on 2026-10-15 and was refused. Every non-string argument
 * added after a client connected would be refused the same way, which
 * defeats `orient`'s live tool list (`tools/liveList.js`).
 *
 * Narrow on purpose. Only a top-level string, only where the schema's type
 * has no `string` in it (so a path or a note body is never reinterpreted),
 * and only text that is exactly that type: `true`/`false`, a whole number
 * for an integer, a finite number, or JSON that parses to an object or an
 * array. Anything else is left as sent, and `toolArgumentRefusal` refuses it
 * exactly as before; the result is validated in full either way.
 */
export function coercedArguments(name, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  const properties = advertisedSchemaFor(name)?.properties;
  if (!properties) return args;
  let out = args;
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== "string" || !Object.hasOwn(properties, key)) continue;
    const read = readAs(properties[key]?.type, value);
    if (read === undefined) continue;
    if (out === args) out = { ...args };
    out[key] = read;
  }
  return out;
}

/** `text` as one of `type`'s non-string types, or `undefined` when it is not one. */
function readAs(type, text) {
  const types = Array.isArray(type) ? type : [type];
  if (types.includes("string") || types.includes(undefined)) return undefined;
  for (const each of types) {
    if (each === "boolean" && (text === "true" || text === "false")) return text === "true";
    if (each === "integer" && /^-?\d{1,15}$/.test(text)) return Number(text);
    if (each === "number" && /^-?\d+(\.\d+)?$/.test(text)) return Number(text);
    if (each === "object" || each === "array") {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        continue;
      }
      const isArray = Array.isArray(parsed);
      if (each === "array" ? isArray : parsed !== null && typeof parsed === "object" && !isArray) return parsed;
    }
  }
  return undefined;
}

/**
 * The refusal for a tool call whose arguments are not what we advertised, or
 * `null` if the call may proceed.
 *
 * Two ways this deliberately says nothing. A name with no advertised schema —
 * an invented one, a typo — is passed through untouched so `callTool` answers
 * it with `unknown tool: …`; validating it first would let a caller tell a
 * misspelled tool from a real one by the shape of the complaint. And a tool
 * masked from this tier is passed through for the same reason, one step
 * stronger: see `EXISTENCE_MASKED_TOOLS`.
 */
export function toolArgumentRefusal(name, args, scope) {
  if (toolExistenceMasked(name, scope)) return null;
  const schema = advertisedSchemaFor(name);
  if (!schema) return null;
  return validateArguments(schema, args);
}

/**
 * The tools this connection may see.
 *
 * A read-only grant is not shown tools it cannot use. Advertising them and then
 * refusing every call makes a connected client look broken; it also invites an
 * agent to spend a turn discovering it.
 *
 * Shared by both protocol eras on purpose. The filtering here and the
 * enforcement in `callToolForSession` are the only two places authority is
 * decided, so adding a protocol revision can never quietly add a second, laxer
 * copy of either.
 */
export async function toolsForSession(session, store, { shape = "v2" } = {}) {
  const offered = writesAnywhere(session)
    ? toolDefinitions()
    : toolDefinitions().filter((tool) => tool.annotations?.readOnlyHint === true);
  // `readOnlyHint` is not the whole of the question — see
  // `PRIVATE_TIER_ONLY_TOOLS`. Offered to a connection that owns one of the
  // contexts it covers, and refused per call in the ones it does not.
  const scoped = readsPrivateAnywhere(session)
    ? offered
    : offered.filter((tool) => !PRIVATE_TIER_ONLY_TOOLS.has(tool.name));
  /*
    A third filter, and the only one that asks the *bucket* a question.

    A Context plugin somebody turned off takes its tools out of the listing, so
    a client is not shown four form tools for a context whose owner does not
    want forms. This listing is `CACHEABLE` for a minute, so a toggle can take
    that long to reach a connected client — which is exactly why the refusal in
    `callToolForSession` is the control and this is the courtesy, the same
    division scope already keeps two filters below.

    Unreadable settings mean the defaults, never an empty list: see
    `enablement.js`. A storage failure here would otherwise present as a client
    that suddenly speaks a quarter of the protocol.
  */
  const off = await disabledToolNames(store);
  const enabled = off.size === 0 ? scoped : scoped.filter((tool) => !off.has(tool.name));
  // Last, so that everything above still reasons about the whole surface: an
  // unlisted tool is one this server stopped *recommending*, not one it
  // stopped answering. See `UNLISTED_TOOLS`.
  const listed = enabled.filter((tool) => !UNLISTED_TOOLS.has(tool.name));
  return shape === "v1"
    ? listed.filter((tool) => !V2_ONLY_TOOLS.has(tool.name))
    : listed.filter((tool) => V2_TOOLS.has(tool.name));
}
