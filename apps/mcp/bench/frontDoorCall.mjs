/**
 * WHICH MODEL CALL IS TEX'S FRONT DOOR (bench side).
 *
 * A texted turn makes several model calls: the Front door's answer, and the reviewer's, the judges', the summaries'
 * and the threads'. The provider's request body says nothing about who asked, so each call's labels come from the
 * `cf-aig-metadata` header the gateway sends with it (`aiGateway.js`, `metadata: { feature, workspace, client }` from
 * `texEntryPoint/runTheModel.js`), kept by `modelLog.mjs` as `call.metadata`. The Front door answers a text as
 * `client: "texts"` (or `"texts-group"` in a group); everything else says its own client.
 *
 * A quiet row says why Tex stayed quiet from the Front door's own last call. When no call in the turn can be told
 * (no labels, or no Front door call), it falls back to the turn's last call, as it always did.
 */

/** The clients the Front door answers a text under: a one-to-one text and a group's. */
export const FRONT_DOOR_CLIENTS = new Set(["texts", "texts-group"]);

/** Whether a logged model call is the Front door's answer to a text. */
export function isFrontDoorCall(call) {
  const labels = call?.metadata;
  return labels?.feature === "assistant" && FRONT_DOOR_CLIENTS.has(labels.client);
}

/** The Front door's last call in a turn's calls, or null when none of them can be told. */
export function lastFrontDoorCall(calls) {
  return (Array.isArray(calls) ? calls : []).findLast(isFrontDoorCall) ?? null;
}

/** The one call a quiet row's words come from: the Front door's last, else the turn's last; [] when there is no call. */
export function quietCallsOf(calls) {
  const last = lastFrontDoorCall(calls) ?? (Array.isArray(calls) ? calls.at(-1) : undefined);
  return last ? [last] : [];
}
