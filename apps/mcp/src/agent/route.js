/**
 * `/agent` — one question answered by a model that calls tools through the
 * very dispatcher an MCP client's calls go through (`callToolForSession`).
 */

import { recordedTurn } from "./loggedTurn.js";
import { afterTurn } from "./deferred.js";
import { texEntry } from "./texTiming.js";
import { turnStages } from "./turnStages.js";
import { texEntryPoint } from "./texEntryPoint.js"; // the turn itself, one step per line


/**
 * One agent turn over HTTP.
 *
 * ## Why it is a route here rather than a tool, or a server of its own
 *
 * It is here because it must spend the *same* session, the same scope clamp and
 * the same store as `/mcp`. A second service would need a second answer to "may
 * this caller read that note", and the second answer is the one that drifts —
 * this worker has one privacy engine and one authority decision, and the agent
 * is a caller of them rather than a peer.
 *
 * It is not a tool because a tool is something a *model* invokes, and this is
 * the thing that invokes models.
 *
 * ## What comes back
 *
 * Whole turns, not a stream. A turn that finishes is worth more than a turn
 * that renders prettily, and adding SSE later changes `turn.js` and this
 * function without touching the authority above them. `steps` names the tools
 * that ran, in order, so the app can show what the agent did — names only, no
 * arguments: a path or a query is a fact about what somebody is looking for in
 * their own notes.
 *
 * ## Every refusal is the client's to read, and none of them is a reason
 *
 * A provider that errored is `model_unavailable` with no detail. The reason
 * lives in this deployment's own logs, because a provider's error body quotes
 * the request that produced it — the customer's question and their notes.
 */
export function handleAgent(request, env, store, session, controlPlane, options = {}) {
  const stages = turnStages(env), later = [], tex = texEntry(env, { who: session.workspaceId, later }); stages.watch(store); tex.watch(store); return recordedTurn(store, (outcome) => texEntryPoint(request, env, store, session, controlPlane, { ...options, stages, later, tex }, outcome), { defer: () => tex.lean }).finally(() => (tex.responded(), stages.flush(), afterTurn(store, later))); // every exit of a named turn is recorded (`loggedTurn.js`), with where its time went (`turnStages.js`)
}
