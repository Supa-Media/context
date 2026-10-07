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
import { readsPrivateAnywhere } from "../session.js";
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
 * **Every connection is shown every write tool, a read-only grant included.**
 * This used to hide them from a grant that could write nowhere, on the grounds
 * that advertising a tool and then refusing every call makes a client look
 * broken. What actually broke was the opposite. A client caches `tools/list`
 * for the life of a chat and this server sends no `listChanged` (see
 * `protocol.js`), so a chat that listed tools while its grant was read-only
 * kept that list after its person reconnected with write access: it could read,
 * and `write_note`, `save_context` and `remember` were simply not there, in
 * that chat only. A listed tool that refuses with a reason can be recovered
 * from: the refusal says to reconnect, and the next call works. A missing one
 * cannot, because an agent cannot ask for a tool it was never told about.
 *
 * Nothing about authority moved. `callToolForSession` refuses every write a
 * read-only grant attempts, and it always had to, because a client can name a
 * tool it was never shown.
 *
 * Shared by both protocol eras on purpose. The filtering here and the
 * enforcement in `callToolForSession` are the only two places authority is
 * decided, so adding a protocol revision can never quietly add a second, laxer
 * copy of either.
 */
export async function toolsForSession(session, store) {
  const offered = toolDefinitions();
  // Tier is still filtered; see `PRIVATE_TIER_ONLY_TOOLS`. Offered to a
  // connection that owns one of the contexts it covers, and refused per call
  // in the ones it does not.
  const scoped = readsPrivateAnywhere(session)
    ? offered
    : offered.filter((tool) => !PRIVATE_TIER_ONLY_TOOLS.has(tool.name));
  /*
    A second filter, and the only one that asks the *bucket* a question.

    A Context plugin somebody turned off takes its tools out of the listing, so
    a client is not shown four form tools for a context whose owner does not
    want forms. This listing is `CACHEABLE` for a minute, so a toggle can take
    that long to reach a connected client — which is exactly why the refusal in
    `callToolForSession` is the control and this is the courtesy, the same
    division tier already keeps one filter above.

    Unreadable settings mean the defaults, never an empty list: see
    `enablement.js`. A storage failure here would otherwise present as a client
    that suddenly speaks a quarter of the protocol.
  */
  const off = await disabledToolNames(store);
  const enabled = off.size === 0 ? scoped : scoped.filter((tool) => !off.has(tool.name));
  // Last, so that everything above still reasons about the whole surface: an
  // unlisted tool is one this server stopped *recommending*, not one it
  // stopped answering. See `UNLISTED_TOOLS`.
  return enabled.filter((tool) => !UNLISTED_TOOLS.has(tool.name));
}
