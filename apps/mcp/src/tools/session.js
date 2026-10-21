/**
 * `callToolForSession` — the one path from a client's tool call to a tool: cross-context routing,
 * the per-call scope refusals, argument validation, and then `callTool`. Read off THIS FILE by
 * toolArguments.test.mjs and crossContext.test.mjs (see test/gatewaySource.mjs).
 */

import { withMailFooter } from "../mail/footer.js";
import { AGENT_ACTIVITY_TOOLS, recordAgentActivity } from "../live/agentActivity.js";
import { activityHintOf } from "../live/activityHint.js";
import { recordAgentRead } from "../live/readLog.js";
import { callTool } from "./dispatch.js";
import { inWordsOf, translateV2Params } from "./v2/translate.js";
import { disabledToolNames, disabledToolRefusal } from "../plugins/enablement.js";
import {
  FORM_TOOLS,
  isUsableContextName,
  ROUTING_PLANNING_TOOLS,
  toolIsWriting,
  toolDefinitions,
} from "./registry.js";
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
import { measuredCall, reportToolUsage } from "../mcp/usage.js";
import { splitMessageAnchor } from "../search/commsIndex.js";
import { canonicalToolName, coercedArguments, toolArgumentRefusal } from "./advertised.js";
import { toolError } from "./results.js";
import { toolMoveNoteAcrossContexts } from "./moves/acrossContexts.js";
import { NoteCapReached, asRelocation } from "../store/noteCap.js";
import { recordRead } from "../privacy/egress.js";
import { createPending, findPending, takeDone } from "./approvals.js";
import { HELD_GATES } from "./heldGates.js";
import { irreversibleOf } from "./irreversible.js";
import { wordsOfTurn } from "../agent/conversation.js";
import { actsOnOwnAccount } from "../agent/groupTurn.js";
import { wideningOf } from "../privacy/widening.js";
import { loadPrivacyState } from "../privacy/state.js";
import { PrivacyOverrides } from "../privacy/engine.js";
import { recordChange } from "../activity/record.js";
import { CHAOS_TOOLS, chaosLines, takeChaos, withChaosLines, within } from "../chaos/report.js";
import { changeChaos } from "../chaos/change.js";

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

/**
 * THE ASK-FIRST GATE, at the one place every AI client's call passes.
 *
 * Only the few calls nobody can take back wait for the person: an email and a
 * calendar change (`HELD_GATES`, each with its exact copy), claiming a
 * workspace's @handle, which is never freed, and inviting people, whose email
 * cannot be unsent (`irreversible.js`). Everything else runs at once.
 * The widening holds that once sat here — a link, a publish, a visibility
 * change, a write into another workspace, held for a yes as a guard against
 * prompt injection — were removed by the owner on 2026-10-17 ("everything
 * needed approval"; docs/decisions/privacy-and-sharing/agent-egress.md).
 *
 * A held call is a pending approval in the connection's own context and the
 * model is told, in band, what it would have done and who can allow it. Never
 * thrown, never silent: a refusal the model cannot read is one it retries.
 * `supplied` — the arguments as the client sent them, `context` included — is
 * what is stored and what is replayed, so an approved call routes exactly as
 * the asked one did.
 */
async function egressGate(suppliedName, supplied, args, { store, session, target, targetStore, into, personSaid }) {
  // Read by the name it is dispatched under (`archive_chat` is `save_context`);
  // stored and replayed as supplied, so a released call routes as asked.
  const name = canonicalToolName(suppliedName);
  // An email or a calendar change always waits for a yes to its exact copy.
  if (Object.hasOwn(HELD_GATES, name)) return await HELD_GATES[name](supplied, { store, session, target });
  if (typeof session.sharingJudge === "function" && session.egress?.approved !== true) {
    const refused = await judgedGate(name, suppliedName, args, { store, session, target, targetStore, into, personSaid });
    if (refused) return refused;
  }
  const held = irreversibleOf(name, args, { into: typeof target.workspaceSlug === "string" ? `@${target.workspaceSlug}` : null });
  if (held === null || session.egress?.approved === true) return null;
  const { because, ...claim } = held;
  const userId = session.actorUserId;
  const released = await takeDone(store, {
    name: suppliedName,
    args: supplied,
    userId,
    clientId: session.actorClientId,
  });
  if (released) return released;
  const ledger = session.egress?.ledger ?? null;
  const texting = session.egress?.texting === true;
  const existing = await findPending(store, { name: suppliedName, args: supplied, userId });
  const record =
    existing?.record ??
    (await createPending(store, {
      name: suppliedName,
      args: supplied,
      actor: store.actor,
      // The asking connection's own tier and scopes, for the trail: the
      // replay runs as the person who approved (`replayAsAsked`).
      tier: session.scope,
      scopes: session.scopes,
      widening: claim,
      workspaceId: target.workspaceId,
      texting,
      armed: false, // armed by `textedAsk` once the ask goes out whole
    }));
  if (record === null) {
    return toolError(
      `Not done: this would ${claim.summary}, and the person has too many approvals waiting already. ` +
        "Ask them to clear some first.",
    );
  }
  if (ledger && !ledger.asked.some((asked) => asked.id === record.id)) ledger.asked.push(record);
  // `held` tells the turn (and so the turn log and the bench) that this call
  // was not refused but is waiting for the person; it runs when they say yes.
  return {
    ...toolError(
      texting
        ? `Not done yet: this would ${claim.summary}. It needs the person's OK first, because ${because}. ` +
            "Tell them plainly what you want to do; they will be asked to reply YES to allow it, and it runs then. " +
            "Don't call this again in this turn."
        : `Not done: this would ${claim.summary}. It needs the person's approval first, because ${because}. ` +
            "They can approve it in the Context app. " +
            "Once they have, call this tool again with exactly the same arguments and it will run.",
    ),
    held: true,
  };
}

/**
 * THE SHARING JUDGE (`SHARING_JUDGE = "on"`; the owner, 2026-10-17 and
 * 2026-10-18: "ship the judge for sharing approvals and turn it on in
 * production").
 *
 * A call that would let more people see something (`privacy/widening.js`)
 * runs when the person's own words ask for it, as a small model with almost
 * no context reads them (`privacy/judge.js`); otherwise the model is told to
 * ask them in the chat and call again. Nothing is held, nobody taps anything.
 *
 * The words are the person's message when this gateway ran the turn itself
 * (`session.egress.turn`, set by `/agent`; `wordsOfTurn`), and only then: a model's
 * `person_said` is never read for such a turn, and a turn of ours with no
 * person behind it (a dream, a try-it run) has no words. An MCP client's chat
 * is never seen here, so its `person_said` is the client's report of them.
 *
 * An ordinary write into another workspace the caller belongs to
 * (`elsewhereOnly`) is not judged: it names no link, no publication and
 * nobody new, and it was the friction approvals were removed for.
 */
async function judgedGate(name, suppliedName, args, { store, session, target, targetStore, into, personSaid }) {
  const writes =
    typeof into === "string" && into !== "" && toolIsWriting(name) && !ROUTING_PLANNING_TOOLS.has(name);
  const widening = await wideningOf(name, args, {
    into,
    writes,
    // The exact-note overrides are the owner's alone, so a team-tier caller is
    // measured without them, as `scope_info` shows that tier the folder rules.
    privacy: async () => {
      const privacy = await loadPrivacyState(targetStore);
      return { rules: privacy.rules, overrides: target.scope === "private" ? privacy.overrides : new PrivacyOverrides() };
    },
  });
  if (widening === null || widening.elsewhereOnly === true) return null;
  const ours = session.egress?.complete === true;
  const turn = session.egress?.turn;
  const own = turn ? turn.note ?? wordsOfTurn(turn.history ?? [], turn.question ?? "") : ours ? "" : null;
  const words = own ?? (typeof personSaid === "string" ? personSaid : "");
  const verdict = await session.sharingJudge({
    words,
    action: widening.summary,
    workspace: typeof target.workspaceSlug === "string" ? `@${target.workspaceSlug}` : undefined,
  });
  if (verdict.allow === true) {
    // Their yes, found in their words, is what the tools' own publish flag asks for.
    if (widening.publishes === true && advertisesTeamConfirmation(name)) args.confirm_team_publish = true;
    await recordChange(store, "judge_allow", session.scope, [], { tool: suppliedName, summary: widening.summary });
    return null;
  }
  const why = verdict.reason ? ` (${verdict.reason.replace(/\.$/, "")})` : "";
  return toolError(
    own !== null
      ? `Not done yet: this would ${widening.summary}, and the person's message doesn't ask for that${why}. ` +
          "Ask them plainly whether they want it; if they say yes, call it again then."
      : `Not done: this would ${widening.summary}, and Context runs that only when the person has asked for it${why}. ` +
          "Ask them in this chat. When they say so, call again with the same arguments and person_said set to " +
          "their words exactly as they wrote them, with your question first if they were answering it.",
  );
}

/** Whether the advertised schema for `name` takes `confirm_team_publish`. */
function advertisesTeamConfirmation(name) {
  const tool = toolDefinitions().find((entry) => entry.name === name);
  return Boolean(tool?.inputSchema?.properties?.confirm_team_publish);
}

/** Run one tool call for this session, enforcing scope. Shared by both eras. */
/** `@name/rest` → `{ name: "@name", rest }`, or null for a plain path. */
const BY_NAME = /^(@[a-z0-9][a-z0-9-]*)\/(.+)$/;

/** The arguments that carry a path into the addressed context, and the context argument each pairs with. */
const PATH_ARGUMENTS = [
  ["path", "context"],
  ["note", "context"],
  ["prefix", "context"],
  ["source", "source_context"],
  ["destination", "destination_context"],
];

/**
 * Route a call from a path that opens with a workspace's name.
 *
 * Returns a refusal when the call's paths name more than one place, and
 * nothing when they agree.
 *
 * **A call names one place.** `move_note` is the exception that proves it: it
 * carries a context per side, so each path addresses its own end. Every other
 * tool routes the whole call, so the first path argument that speaks decides
 * where the call runs, and the rest are read there. A later path naming a
 * *different* workspace — including the plain path of a caller who named the
 * other side and not this one — has asked for two places at once, and is
 * refused rather than quietly collapsed into one of them. Routing
 * `{ source: "5-notes", destination: "@band/4-archive/5-notes" }` to `@band`
 * moved @band's folder and left the caller's where it was (found by reading,
 * 2026-10-10).
 */
function addressByPath(tool, args) {
  if (!args || typeof args !== "object") return;
  if (tool === "move_note") {
    for (const [field, into] of PATH_ARGUMENTS) {
      if (args[into] !== undefined && args[into] !== null) continue;
      const match = typeof args[field] === "string" ? BY_NAME.exec(args[field]) : null;
      if (!match) continue;
      args[into] = match[1];
      args[field] = match[2];
    }
    return;
  }
  // A call that addressed itself has already said where it is going; a name
  // inside a path is then part of the path, and fails as one.
  if (args.context !== undefined && args.context !== null) return;
  /** The workspace the first path argument named, `null` for "here". */
  let named = null;
  /** The argument that named it, and so the one a disagreement is measured against. */
  let decidedBy = null;
  for (const [field] of PATH_ARGUMENTS) {
    if (typeof args[field] !== "string") continue;
    const match = BY_NAME.exec(args[field]);
    if (decidedBy === null) {
      decidedBy = field;
      named = match ? match[1] : null;
      if (match) args[field] = match[2];
      continue;
    }
    // Plain, and so read in the place already named — which is how
    // `{ source: "@band/gigs", destination: "4-archive/gigs" }` moves inside @band.
    if (!match) continue;
    if (match[1] === named) {
      args[field] = match[2];
      continue;
    }
    return (
      "that call names more than one workspace: " +
      `${decidedBy} is ${named ? `in ${named}` : "in this context"} and ${field} opens with ${match[1]}. ` +
      "A path that names a workspace has to be the only workspace the call names."
    );
  }
  if (named !== null) args.context = named;
}

export async function callToolForSession(params, store, session) {
  const { error, params: call, v2 } = translateV2Params(params, store); // v2 → the existing call, before any gate
  if (error) return toolError(error);
  const result = await measuredCall(store, session, call, (routed) => routeToolCall(call, store, session, routed));
  return inWordsOf(v2, result);
}

async function routeToolCall(params, store, session, routed) {
  // Read as the advertised types: a stale client sends an argument its copy lacks as text (`advertised.js`).
  const supplied = coercedArguments(params?.name, params?.arguments);
  const args = supplied && typeof supplied === "object" && !Array.isArray(supplied) ? { ...supplied } : {};

  /**
   * The addressed context, if the call named one.
   *
   * **Everything below this point runs against the addressed context, and nothing above it
   * decided anything** (the v2 translation above only renames the call). This function and
   * `toolsForSession` are the only two places authority is decided, and a call into somebody
   * else's workspace is clamped by *their* membership, not the connected one's. Resolving a
   * context anywhere else — in a tool, in a path parser — is a second authority decision, and
   * the second one is the one that drifts.
   *
   * `context` is dropped from the arguments before the tool sees them: it addresses the call, it
   * is not an input to any tool, and a tool that grew an argument of that name would otherwise be
   * handed a routing token.
   */
  /*
    THE `@name/path` SUGAR, in the same one place. A path that opens with a
    workspace's name (`@band/gigs/show.md`), as a search across workspaces
    writes it (`search.js`), addresses the call the way `context: "@band"`
    with `gigs/show.md` does: the name goes to `context`, the rest stays the
    path. Only when the call named no context itself; a call that names one
    and also writes another's name into the path has said two things, and is
    left to be refused as a path that does not exist there. Planned in
    CLAUDE.md as sugar over the same routing; measured on 2026-10-10 when a
    cheap model passed the prefixed path as-is 120 times in one round.
  */
  const crossed = addressByPath(params?.name, args);
  if (crossed) return toolError(crossed);
  const requested = args.context;
  delete args.context;
  // The person's words, for the sharing judge only (`judgedGate`); never a tool's input.
  const personSaid = args.person_said;
  delete args.person_said;

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
      routed.workspaceId = target.workspaceId;
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
      routed.workspaceId = destinationTarget.session.workspaceId;
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
    !(FORM_TOOLS.has(params?.name) && participatesInForms(target)) &&
    !(ROUTING_PLANNING_TOOLS.has(params?.name) && writesAnywhere(session)) &&
    // A group chat's email or calendar change is its tagger's own, not the workspace's (`groupTurn.js`).
    !actsOnOwnAccount(session, params?.name)
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

  // After every refusal above, so a call that would not have run anyway is
  // never held for a person to look at; before dispatch, which is the point.
  {
    const held = await egressGate(params?.name, supplied, args, {
      store,
      session,
      target,
      targetStore,
      into: target.workspaceId === session.workspaceId ? null : `@${target.workspaceSlug}`,
      personSaid,
    });
    if (held) return held;
  }

  // A move inside one context adds no note, so it runs in the cap's
  // relocation window (`store/noteCap.js`); everything else is capped.
  const dispatch = async () => await callTool(params?.name, args, targetStore, target.scope);
  let result = await answeringNoteCap(() =>
    RELOCATING_TOOLS.has(params?.name) ? asRelocation(targetStore, dispatch) : dispatch()
  );
  // Whether the model now holds words from outside the workspace, for the turn's ledger.
  if (!toolIsWriting(params?.name)) {
    recordRead(session.egress?.ledger, { name: params?.name, args, result });
  }
  noteAgentActivity(targetStore, params?.name, args, result);
  result = await reportingChaos(targetStore, params?.name, args, target.scope, result);
  // When the caller joined a note's mail, the news rides on every answer.
  result = await withMailFooter(result, args, params?.name, { store, session, targetStore, target });
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
 *
 * Whether a write created its note, and which notes a move moved, come from
 * the handler's hint (`live/activityHint.js`); without one a write is an
 * edit, as it always was, and a move records nothing. A move is notes only:
 * a folder's images travel with it but are not dots on the map.
 */
function noteAgentActivity(store, name, args, result) {
  const kind = AGENT_ACTIVITY_TOOLS.get(name);
  if (!kind || !result || result.isError) return;
  const hint = activityHintOf(result);
  if (kind === "move") {
    const notePath = (value) => {
      const path = normalizePath(value);
      return path && path.endsWith(".md") && !isPlumbing(path) ? path : null;
    };
    const moves = (Array.isArray(hint?.moves) ? hint.moves : [])
      .map((move) => ({ kind: "move", from: notePath(move?.from), path: notePath(move?.to) }))
      .filter((move) => move.from && move.path && move.from !== move.path);
    recordAgentActivity(store, moves);
    return;
  }
  const text = typeof result.content?.[0]?.text === "string" ? result.content[0].text : "";
  // The header only: a note whose own text has a `path:` line must not move
  // its mark to a path it merely mentions.
  const header = text.split("\n\n", 1)[0];
  const reported = kind === "read" ? header.match(/^path: (.+)$/m)?.[1] : undefined;
  const raw = reported ?? (name === "fetch" ? args?.id : args?.path);
  const path = splitMessageAnchor(normalizePath(raw) ?? "").path;
  if (!path || isPlumbing(path)) return;
  const done = kind === "read" ? "read" : hint?.created === true ? "create" : "edit";
  recordAgentActivity(store, [{ kind: done, path }]);
  // A read is also kept, for the trail and the replay (`live/readLog.js`).
  if (done === "read") recordAgentRead(store, { tool: name, path });
}

/**
 * End a write's answer with what it did to the chaos score (`chaos/report.js`).
 *
 * The count was started by the change itself (`chaos/change.js`); a save of
 * an existing note's text starts none (the editor saves on every pause), so
 * for `write_note` one is started here, for that note alone, which counts its
 * new length against the facts' old one. Never throws, and never holds
 * an answer longer than `WAIT_MS`.
 */
async function reportingChaos(store, name, args, scope, result) {
  const started = takeChaos(store);
  if (!CHAOS_TOOLS.has(name) || !result || result.isError) return result;
  // A comment or a website action changes no folder.
  if (args?.comment !== undefined || args?.site !== undefined) return result;
  try {
    let report = started === undefined ? null : await within(started);
    if (started === undefined && name === "write_note" && typeof args?.path === "string") {
      const path = normalizePath(args.path);
      if (path) report = await within(changeChaos(store, { files: [path] }));
    }
    return withChaosLines(result, chaosLines(report, scope === "private" ? "all" : "team"));
  } catch {
    return result;
  }
}
