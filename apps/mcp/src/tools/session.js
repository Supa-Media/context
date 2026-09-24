/**
 * `callToolForSession` — the one path from a client's tool call to a tool:
 * cross-context routing, the per-call scope refusals, argument validation,
 * and then `callTool`. Read off THIS FILE by toolArguments.test.mjs and
 * crossContext.test.mjs (see test/gatewaySource.mjs).
 */

import { AGENT_ACTIVITY_TOOLS, recordAgentActivity } from "../live/agentActivity.js";
import { callTool } from "./dispatch.js";
import { disabledToolNames, disabledToolRefusal } from "../plugins/enablement.js";
import { FORM_TOOLS, isUsableContextName, toolIsWriting } from "./registry.js";
import {
  hasScope,
  participatesInForms,
  SCOPE_WRITE,
  SessionRefusal,
  StorageUnavailable,
  writesAnywhere,
} from "../session.js";
import { isPlumbing } from "../privacy/engine.js";
import { normalizePath } from "../notes/paths.js";
import { pluginForTool } from "../plugins/catalog.js";
import { reportToolUsage } from "../mcp/usage.js";
import { splitMessageAnchor } from "../search/commsIndex.js";
import { toolArgumentRefusal } from "./advertised.js";
import { toolError } from "./results.js";
import { toolMoveNoteAcrossContexts } from "./moves/acrossContexts.js";
import { NoteCapReached, asRelocation } from "../store/noteCap.js";

/**
 * Tools that rearrange notes inside one context. A move adds nothing, so on a
 * context at its free-tier note cap these run inside `asRelocation` and are
 * never refused for it; a move *into* a context from another one is not here.
 */
const RELOCATING_TOOLS = new Set([
  "move_note",
  "move_notes",
  "move_folder",
  "archive_note",
  "materialize_move",
]);

/**
 * A create refused at the free tier's note cap, as the sentence that says what
 * still works — never an unhandled throw. Anything else is rethrown.
 */
async function answeringNoteCap(run) {
  try {
    return await run();
  } catch (error) {
    if (error instanceof NoteCapReached) return toolError(error.message);
    throw error;
  }
}

/** Run one tool call for this session, enforcing scope. Shared by both eras. */
export async function callToolForSession(params, store, session) {
  const supplied = params?.arguments;
  const args =
    supplied && typeof supplied === "object" && !Array.isArray(supplied) ? { ...supplied } : {};

  /**
   * The addressed context, if the call named one.
   *
   * **Everything below this point runs against the addressed context, and
   * nothing above it decided anything.** That is why the routing is here: this
   * function and `toolsForSession` are the only two places authority is
   * decided, and a call into somebody else's workspace has to be clamped by *their*
   * membership rather than by the one the client happens to be connected to.
   * Resolving a context anywhere else — in a tool, in a path parser — is a
   * second authority decision, and the second one is the one that drifts.
   *
   * `context` is dropped from the arguments before the tool sees them: it
   * addresses the call, it is not an input to any tool, and a tool that ever
   * grew an argument of that name would otherwise be handed a routing token.
   */
  const requested = args.context;
  delete args.context;

  let target = session;
  let targetStore = store;
  /*
    Present but unusable is a refusal, never a fall-through to the default.
    A `context` of `123`, of `""`, or of an object is a client that meant to
    address somewhere else and failed to say where — and quietly serving the
    context it did not ask for is how a note gets written into the wrong workspace.
    Absent is the only thing that means "here".
  */
  if (requested !== undefined && requested !== null && !isUsableContextName(requested)) {
    return toolError("this connection has no access to that context");
  }
  if (isUsableContextName(requested)) {
    // A deployment that never installed the opener — a self-host shim, a test
    // harness — refuses rather than silently serving the default context. The
    // failure a person can act on is "that did not happen"; the one they cannot
    // is a note filed in the wrong workspace.
    if (typeof store.openContext !== "function") {
      return toolError("this connection cannot address another context");
    }
    try {
      ({ session: target, store: targetStore } = await store.openContext(requested));
    } catch (error) {
      // One answer for a name that is not covered, a name that is not a name,
      // and a name nobody has ever registered — the refusal `selectWorkspace`
      // gives the URL form, for the reason it gives: a distinguishable answer
      // is an existence oracle over a global namespace.
      if (error instanceof SessionRefusal) {
        return toolError("this connection has no access to that context");
      }
      // Reachable, and its bucket is not. Said plainly, because it is the one
      // failure here the person can fix — and said WITHOUT the reason, because
      // `StorageUnavailable`'s own doc comment reserves that for this gateway's
      // structured logs: "It never reaches a caller: `index.js` answers every
      // one of these with the same 503." Interpolating `error.message` here
      // made that false, and the reasons it published are plumbing state
      // (`workspace mismatch` — the two-party disagreement signal — plus
      // `no proof of authorization`, `refresh token in binding`,
      // `cross-provider credential`, `binding not allowed`, `unknown
      // provider`), pollable by any member of any covered context.
      if (error instanceof StorageUnavailable) {
        // Named, and the action attributed to whoever can take it. This branch
        // is reached only on the cross-context hop, so it is by definition
        // about another context — often one the caller is a `member` of and
        // cannot reconnect. The identically-worded 503 is about the caller's
        // own context, where "reconnect it" is advice they can act on.
        return toolError(
          `${target?.name || "that context"} has no reachable storage right now; ` +
            "its owner can reconnect it from their dashboard.",
        );
      }
      throw error;
    }
  }

  if (
    params?.name === "move_note" &&
    (args.source_context !== undefined || args.destination_context !== undefined)
  ) {
    if (
      (args.source_context !== undefined && !isUsableContextName(args.source_context)) ||
      (args.destination_context !== undefined && !isUsableContextName(args.destination_context))
    ) {
      return toolError("this connection has no access to that context");
    }
    const openNamedContext = async (name) => {
      if (!isUsableContextName(name)) return { session: target, store: targetStore };
      if (typeof store.openContext !== "function") {
        throw new SessionRefusal(403, "insufficient_scope", "This connection cannot address another context.");
      }
      return store.openContext(name);
    };
    let sourceTarget;
    let destinationTarget;
    try {
      sourceTarget = await openNamedContext(args.source_context);
      destinationTarget = await openNamedContext(args.destination_context);
    } catch (error) {
      if (error instanceof SessionRefusal) {
        return toolError("this connection has no access to that context");
      }
      if (error instanceof StorageUnavailable) {
        return toolError(
          "one of those contexts has no reachable storage right now; its owner can reconnect it from their dashboard.",
        );
      }
      throw error;
    }
    const crossArgs = { ...args };
    delete crossArgs.source_context;
    delete crossArgs.destination_context;
    const badArguments = toolArgumentRefusal(params?.name, supplied, target.scope);
    if (badArguments) return toolError(badArguments);
    if (!hasScope(sourceTarget.session, SCOPE_WRITE)) {
      return toolError(
        writesAnywhere(session)
          ? `permission denied: you have read-only access to @${sourceTarget.session.workspaceSlug}.`
          : "permission denied: this connection holds a read-only grant. " +
              "Reconnect the client with write access from the Context dashboard."
      );
    }
    if (!hasScope(destinationTarget.session, SCOPE_WRITE)) {
      return toolError(
        writesAnywhere(session)
          ? `permission denied: you have read-only access to @${destinationTarget.session.workspaceSlug}.`
          : "permission denied: this connection holds a read-only grant. " +
              "Reconnect the client with write access from the Context dashboard."
      );
    }
    if (
      sourceTarget.session.workspaceId !== destinationTarget.session.workspaceId &&
      destinationTarget.session.scope === "private" &&
      sourceTarget.session.scope !== "private"
    ) {
      return toolError(
        "permission denied: moving a note into a private owner workspace from another workspace requires owner access to both contexts."
      );
    }
    if (sourceTarget.session.workspaceId === destinationTarget.session.workspaceId) {
      // One context on both sides: a relocation, never refused by the cap.
      const result = await answeringNoteCap(() =>
        asRelocation(sourceTarget.store, () =>
          (callTool)(params?.name, crossArgs, sourceTarget.store, sourceTarget.session.scope)
        )
      );
      reportToolUsage(store, params?.name, sourceTarget.session.workspaceId);
      return result;
    }
    const result = await answeringNoteCap(() =>
      toolMoveNoteAcrossContexts(
        sourceTarget.store,
        sourceTarget.session,
        destinationTarget.store,
        destinationTarget.session,
        crossArgs.source,
        crossArgs.destination,
        crossArgs.expected_source_etag,
        crossArgs.confirm_team_publish === true
      )
    );
    reportToolUsage(store, params?.name, sourceTarget.session.workspaceId);
    reportToolUsage(store, params?.name, destinationTarget.session.workspaceId);
    return result;
  }

  // Enforced here as well as filtered in `toolsForSession`: the listing is a
  // courtesy, this is the control. A client that remembers a tool name from a
  // wider grant, or simply guesses one, gets refused.
  //
  // Read off `target`, never `session`: the grant's write scope survives only
  // where the caller's role in *that* context can back it up, so a `member` in
  // somebody's workspace is refused here even holding a full-access grant.
  if (
    toolIsWriting(params?.name) &&
    !hasScope(target, SCOPE_WRITE) &&
    !(FORM_TOOLS.has(params?.name) && participatesInForms(target))
  ) {
    /*
      Two refusals, because there are two causes and the fix differs. A grant
      that was never given write is a reconnection; a role that cannot back one
      up is not — telling somebody to reconnect for write they can never hold
      in that context sends them round a loop that cannot end. The second case
      only became reachable when one connection started covering several
      contexts, and it names the context because that is now the part in doubt.
    */
    return toolError(
      writesAnywhere(session)
        ? `permission denied: you have read-only access to @${target.workspaceSlug}.`
        : "permission denied: this connection holds a read-only grant. " +
            "Reconnect the client with write access from the Context dashboard."
    );
  }
  /*
    The arguments have to match the schema this gateway advertised for this
    tool, and this is the one place that is checked.

    Ordering, which is the whole of the security argument here:

      - After routing, because the addressing argument is `context`'s alone to
        interpret and it is refused above on its own terms — a `context` of
        `123` is "no access to that context", not a type complaint, and
        `crossContext.test.mjs` pins that. By the time we get here `context` is
        absent or a usable string, so validating the *supplied* object (the one
        that still has it) checks it like any other advertised property.
      - After the scope gate, so a read-only connection is told it holds a
        read-only grant rather than being handed the argument shape of a tool
        its own `tools/list` does not show it.
      - Before `callTool`, which is the point: no handler, no privacy manifest
        read, no storage round trip happens for a call whose arguments we never
        said we would take. That is also why an argument naming another
        workspace is refused identically whether that workspace exists or not
        — nothing is looked up to answer it.
  */
  const badArguments = toolArgumentRefusal(params?.name, supplied, target.scope);
  if (badArguments) return toolError(badArguments);

  /*
    The Context-plugin switch, enforced here as well as filtered out of the
    listing — the listing is cached for a minute and a client can remember a
    tool name for far longer than that, so this is the control.

    Two things about where it sits.

    **After the argument check**, which reverses the order scope uses, because
    this one costs a storage read and the comment above is a promise that a
    call with arguments we never advertised reaches no storage at all. A
    malformed call to a switched-off tool is answered as malformed; the person
    fixing it hits this refusal on the next attempt.

    **Read off `targetStore`**, never the connection's own. The switch belongs
    to the context the call was routed to, so a cross-context call into a
    workspace whose owner turned forms off is refused with that owner's setting
    and not with the caller's.
  */
  if (pluginForTool(params?.name)) {
    const off = await disabledToolNames(targetStore);
    if (off.has(params?.name)) return toolError(disabledToolRefusal(params?.name));
  }

  // A move inside one context adds no note, so it runs in the cap's
  // relocation window (`store/noteCap.js`); everything else is capped.
  const dispatch = async () => await callTool(params?.name, args, targetStore, target.scope);
  const result = await answeringNoteCap(() =>
    RELOCATING_TOOLS.has(params?.name) ? asRelocation(targetStore, dispatch) : dispatch()
  );
  noteAgentActivity(targetStore, params?.name, args, result);
  // Counted after the call, against the context the call was *routed to* —
  // `target`, never `session`. A cross-context call is activity in the workspace it
  // reached, and attributing it to the connection's default context would
  // quietly make one tenant's figures include another's work.
  reportToolUsage(store, params?.name, target.workspaceId);
  return result;
}

/**
 * Record that an agent read or wrote a note, after the call succeeded.
 *
 * Reads the path the handler *reported* where it reports one: `read_note`
 * follows a forwarding entry for a moved note, and the mark belongs on the
 * row the note is on now rather than the address the agent was holding. A
 * refusal records nothing, so "not found" costs the same with or without
 * this.
 */
function noteAgentActivity(store, name, args, result) {
  const kind = AGENT_ACTIVITY_TOOLS.get(name);
  if (!kind || !result || result.isError) return;
  const text = typeof result.content?.[0]?.text === "string" ? result.content[0].text : "";
  // The header only: a note whose own text has a `path:` line must not move
  // its mark to a path it merely mentions.
  const header = text.split("\n\n", 1)[0];
  const reported = kind === "read" ? header.match(/^path: (.+)$/m)?.[1] : undefined;
  const raw = reported ?? (name === "fetch" ? args?.id : args?.path);
  const path = splitMessageAnchor(normalizePath(raw) ?? "").path;
  if (!path || isPlumbing(path)) return;
  recordAgentActivity(store, kind, path);
}
