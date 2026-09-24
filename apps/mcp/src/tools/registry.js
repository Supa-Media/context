/**
 * The tool registry: what `tools/list` offers, which tools are private-tier
 * only or existence-masked, and the `context` addressing argument every
 * definition carries. Moved verbatim out of `src/index.js`.
 */

import { baseToolDefinitions } from "./schemas.js";

/**
 * Tools a connection that reads at the private tier *nowhere* must not even be
 * shown.
 *
 * `list_plugins` is here because it reads a prefix the privacy manifest does
 * not reach, so it is the context owner's however harmless the read is.
 *
 * The two encryption tools are here for a stronger reason, and the listing is
 * where it has to be enforced. `callTool` answers both with the byte-identical
 * `unknown tool: …` an invented name gets — `docs/decisions/encryption.md`'s
 * "a team-tier caller does not even learn the tool exists". A refusal that
 * says "unknown tool" while `tools/list` has already handed the same caller
 * the name, the description and the sentence "export this context's workspace
 * data key(s) in the clear" is not masking anything; it is a masked answer
 * about a capability the same connection was just advertised. Both halves or
 * neither.
 */
export const PRIVATE_TIER_ONLY_TOOLS = new Set([
  "list_plugins",
  "export_encryption_keys",
  "rotate_encryption_keys",
  "materialize_move",
  "migrate_storage_layout",
  /*
    The three link tools, because minting and revoking a share is the owner's.

    The control plane refuses a non-owner anyway — `ownerClearanceForGateway`
    wants `owner`, `context:write` and `context:private` off a live grant — so
    this is the listing half of the same answer: a connection that could never
    mint one is not shown three tools that would always refuse. The refusal
    there is the control; this is what stops an agent spending a turn finding
    that out.
  */
  "create_link",
  "list_links",
  "revoke_link",
]);

/**
 * The subset of those whose *existence* is masked, not merely refused.
 *
 * `list_plugins` and `set_encryption` answer a lower tier with a plain
 * "permission denied": what they do is not itself sensitive. A workspace's key
 * material is, so `callTool` answers these two with the byte-identical
 * `unknown tool: …` an invented name gets.
 *
 * It is a named set rather than two inline `scope !== "private"` lines because
 * argument validation has to consult the same list. A masked tool must not be
 * validated: telling a team-tier caller that `export_encryption_keys` does not
 * take an argument named `x`, when the same caller sending no arguments is
 * told the tool does not exist, is an existence oracle built out of the guard
 * that was supposed to close one. Two readers, one list, no drift.
 *
 * **Exported so the suite has no third copy.** `toolArguments.test.mjs` walks
 * this set, and it walked a hand-copied literal of it — so a fifth name added
 * here was covered by nothing. Measured before this line was written: adding
 * one reddened **nothing** across the whole gateway suite.
 *
 * What that silence would hide is worse than an untested tool. Membership here
 * *disables* `toolArgumentRefusal` as well as *enabling* the dispatch refusal,
 * so a name wired into one reader and not the other is a tool that is still
 * callable and no longer argument-checked — the two readers failing apart in
 * the one direction this comment promises they cannot.
 */
export const EXISTENCE_MASKED_TOOLS = new Set([
  "export_encryption_keys",
  "rotate_encryption_keys",
  "materialize_move",
  "migrate_storage_layout",
]);

/**
 * The tools a connection without `context:write` may still call.
 *
 * They write — `toolIsWriting` says so, from their own annotations, and that is
 * correct — but what they write is one response inside one file an editor
 * named, in a shape this gateway renders. The authority for them is the form's
 * own `submit` policy rather than the grant's write scope, because the whole
 * point of a form is to collect answers from people who may not write notes.
 *
 * `participatesInForms` is the floor underneath that: the grant must still have
 * asked for write, so a client somebody deliberately connected read-only cannot
 * submit either. Two gates, and this set is only the first of them.
 *
 * It exempts the *call*, never the listing. `toolsForSession` needs no branch
 * for it: a connection that can take part in a form is, by construction, one
 * whose person owns their own workspace — that is where the username a response is
 * recorded under comes from — so `writesAnywhere` is already true of it and the
 * full list is already offered. A listing branch would only ever have fired for
 * a connection whose submissions `mutateFormResponses` then refuses for want of
 * a name, which is a tool offered to somebody who cannot use it.
 */
export const FORM_TOOLS = new Set(["submit_form", "update_submission", "retract_submission", "vote_form"]);

/** Is this tool's existence hidden from a caller at this visibility tier? */
export function toolExistenceMasked(name, scope) {
  return EXISTENCE_MASKED_TOOLS.has(name) && scope !== "private";
}

/** Something that could name a context: a non-empty string, and nothing else. */
export function isUsableContextName(value) {
  return typeof value === "string" && value.trim() !== "";
}

/** Tools that change something, derived from the definitions so it cannot drift. */
export function toolIsWriting(name) {
  const tool = toolDefinitions().find((entry) => entry.name === name);
  // An unknown tool is treated as writing. `callTool` rejects it anyway, and a
  // gate that fails open on a name it does not recognize is a gate that a typo
  // in a future tool definition quietly disables.
  return !tool || tool.annotations?.readOnlyHint !== true;
}

/**
 * The `context` argument, declared once and added to every tool.
 *
 * Added centrally rather than written into each schema, because the failure to
 * design against is a tool added next year that quietly cannot be addressed:
 * `additionalProperties: false` means a client's `context` on that one tool is
 * rejected by its own schema, and the agent has no way to tell that from "you
 * may not reach that context".
 */
const CONTEXT_ARGUMENT = {
  type: "string",
  description:
    'Optional. Another context to act in, as "@name" — a workspace someone shared with you, or ' +
    "one you belong to. Omit it to act in your own. Call orient with the same argument " +
    "first: every folder map, search and listing is per context.",
};

/**
 * The same fact, in the one field every client renders.
 *
 * A property blurb is not nothing, but a client is free to summarise the schema,
 * reorder it, or show a model the tool without it; the description is the field
 * that always arrives. A connected ChatGPT holding this exact schema told its
 * user three times that the write action "doesn't expose the workspace
 * selector", and never tried — the argument was there, and the sentence a model
 * reads when it is deciding what a tool can do was not.
 *
 * Appended in the same map that adds the property, so the two cannot drift and
 * the tool added next year gets both or neither.
 */
const CONTEXT_ARGUMENT_SENTENCE =
  ' Works in another context too: pass context: "@name" for any workspace you reach ' +
  "(orient lists them and says what you may do in each).";

/**
 * The two tools whose schema is somebody else's contract.
 *
 * `search` and `fetch` exist in OpenAI's deep-research shape so ordinary
 * ChatGPT chats can call something at all; those chats pass what that contract
 * defines and nothing else, so an extra property buys them nothing and risks
 * being read as a violation of it. Cross-context reach is available to them
 * through the ordinary tools when a client can see the ordinary tools.
 */
const FOREIGN_CONTRACT_TOOLS = new Set(["search", "fetch"]);

/**
 * Every tool, with the addressing argument folded in.
 *
 * Exported so a **client's** own suite can check what it sends against what is
 * advertised. `apps/desktop/test/toolContract.test.mjs` does exactly that: the
 * gateway holds every call to this schema now (#346), and a first-party client
 * that sends a property the schema does not name gets a uniform refusal on
 * every call of that kind, which is the failure shape an evening of meetings
 * was mistakenly attributed to. Cheaper to assert than to diagnose.
 */
export function toolDefinitions() {
  return baseToolDefinitions().map((tool) => {
    if (FOREIGN_CONTRACT_TOOLS.has(tool.name)) return tool;
    const schema = tool.inputSchema || { type: "object" };
    return {
      ...tool,
      // Concatenated rather than templated, so a definition that somehow has no
      // description gets the sentence alone instead of the word "undefined" in
      // the field a model reads to decide what the tool does.
      description: `${tool.description || ""}${CONTEXT_ARGUMENT_SENTENCE}`.trim(),
      inputSchema: {
        ...schema,
        properties: { ...(schema.properties || {}), context: CONTEXT_ARGUMENT },
      },
    };
  });
}
