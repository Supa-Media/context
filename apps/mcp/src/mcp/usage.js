/**
 * Usage reporting to the control plane, and the `waitUntil` wrapper deferred
 * work goes through. Moved verbatim out of `src/index.js`.
 */

import { countTokens, requestText, responseParts } from "./tokens.js";

/**
 * The metrics one tool call is worth.
 *
 * Every call is an `mcp.tool_call`. Two tools are additionally counted as the
 * thing they are, because those are the figures the product is judged on: a
 * search, and a note written.
 *
 * **The tool's name is never what is reported** — it is matched against this
 * table and the *metric* is sent. That is the difference between counting how
 * busy the gateway is and keeping a record of what people do in their
 * contexts, and it is why this is a lookup rather than a passthrough.
 */
const USAGE_METRICS_BY_TOOL = new Map([
  ["search", ["search.query"]],
  ["search_notes", ["search.query"]],
  ["write_note", ["note.write"]],
  ["propose_note", ["note.write"]],
  ["save_context", ["note.write"]],
  ["submit_form", ["note.write"]],
]);

/**
 * One connection opening, counted once per request that opens one.
 *
 * Not a count of *people*, and the dashboard says so: a client that
 * reconnects on every call reports every time. The distinct-contexts figure
 * (`usageActiveDaily`) is the one that answers "how many workspaces are in use",
 * and this one answers "how much connecting is going on", which is a different
 * and also useful question.
 */
export function reportSessionUsage(store, workspaceId) {
  if (typeof store?.reportUsage !== "function") return;
  if (typeof workspaceId !== "string" || workspaceId === "") return;
  try {
    store.reportUsage([{ metric: "mcp.session", workspaceId }]);
  } catch {
    // As in `reportToolUsage`: a counter may not fail a request by any route.
  }
}

export function reportToolUsage(store, toolName, workspaceId) {
  if (typeof store?.reportUsage !== "function") return;
  if (typeof workspaceId !== "string" || workspaceId === "") return;
  const events = [{ metric: "mcp.tool_call", workspaceId }];
  for (const metric of USAGE_METRICS_BY_TOOL.get(toolName) ?? []) {
    events.push({ metric, workspaceId });
  }
  try {
    store.reportUsage(events);
  } catch {
    // `reportUsage` already swallows its own rejection; this catches a
    // synchronous throw from a host that refuses deferral in an unexpected
    // way. A counter must not be able to fail a tool call by any route.
  }
}

/**
 * Premium usage analytics for one tool call: tokens in and out, the call, a
 * failure, images and writes, by the grant's agent and the model.
 *
 * Built lazily, inside the deferred report, so tokenizing never delays the
 * answer. What leaves the gateway is counts, ids it already holds, a model
 * string and a method word; never the arguments or the answer themselves.
 * Whether the workspace is Premium is the control plane's to decide.
 *
 * `result` is null when the dispatch threw.
 */
export function reportBoundaryUsage(store, session, workspaceId, params, result) {
  if (typeof store?.reportUsage !== "function") return;
  if (typeof workspaceId !== "string" || workspaceId === "") return;
  const clientId = session?.actorClientId;
  // A legacy shared-token session has no agent to attribute to.
  if (typeof clientId !== "string" || clientId === "") return;
  const base = {
    workspaceId,
    clientId,
    ...(typeof session.actorUserId === "string" ? { userId: session.actorUserId } : {}),
    ...(typeof store.usageModel === "string" ? { model: store.usageModel } : {}),
  };
  const build = async () => {
    const response = responseParts(result);
    const [sent, returned] = await Promise.all([
      countTokens(requestText(params)),
      countTokens(response.text),
    ]);
    const failed = result === null || result?.isError === true;
    const hourly = [
      { ...base, metric: "mcp.request_tokens", method: sent.method, count: sent.count },
      { ...base, metric: "mcp.response_tokens", method: returned.method, count: returned.count },
      { ...base, metric: failed ? "mcp.failed_calls" : "mcp.calls", method: "count", count: 1 },
      { ...base, metric: "mcp.images", method: "count", count: response.images },
    ];
    if (!failed && (USAGE_METRICS_BY_TOOL.get(params?.name) ?? []).includes("note.write")) {
      hourly.push({ ...base, metric: "note.write", method: "count", count: 1 });
    }
    // Zero is not an event: the control plane reads a missing count as one.
    return { hourly: hourly.filter((event) => event.count > 0) };
  };
  try {
    store.reportUsage(build);
  } catch {
    // As in `reportToolUsage`.
  }
}

export function deferredWork(work) {
  if (typeof work !== "function") return work;
  return {
    then(resolve, reject) {
      return Promise.resolve().then(work).then(resolve, reject);
    },
  };
}
