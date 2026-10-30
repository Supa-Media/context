/**
 * What the turn log (`apps/convex/functions/agentTurns.ts`) keeps of a turn's
 * trace, from `route.js`.
 */

/** The router's confidence as the turn log takes it: 0 to 1, or nothing. A number Clef got wrong never costs the turn its log. */
function confidenceOf(entry) {
  const value = entry.confidence;
  if (typeof value !== "number" || !Number.isFinite(value)) return {};
  return { confidence: Math.min(1, Math.max(0, value)) };
}

/**
 * A trace entry as the turn log takes it (`apps/convex/functions/agentTurns.ts`):
 * kinds, names, numbers and flags, never a word the router or a provider
 * wrote. The router's own word (`pick`) and a fallback's `from` stay in this
 * worker's log line; the status a provider answered is a number and goes, as
 * does the router's confidence in a think pick (a number from 0 to 1).
 */
export function wireTraceEntry(entry) {
  const base = { kind: entry.kind, ok: entry.ok !== false, ms: entry.ms ?? 0 };
  if (entry.kind === "tool") return { ...base, tool: entry.tool, ...(entry.held ? { held: true } : {}) };
  if (entry.kind === "router") return { ...base, tier: entry.tier, model: entry.model, ...confidenceOf(entry) };
  if (entry.kind === "fallback") return { ...base, model: entry.model, ...(typeof entry.status === "number" ? { status: entry.status } : {}) };
  return {
    ...base,
    // Which model ran the round: a planned turn has two (`modelPlan.js`).
    ...(typeof entry.model === "string" ? { model: entry.model } : {}),
    ...(entry.retried ? { retried: true } : {}),
    ...(entry.cut ? { cut: true } : {}),
    ...(typeof entry.status === "number" ? { status: entry.status } : {}),
  };
}

/**
 * Where a turn came from, for the turn log's `kind`: a routine's run, a
 * background job, a group chat, a person's own texts, or the app.
 */
export function turnKind({ runner, job, group, texting }) {
  if (runner) return "routine";
  if (job) return "job";
  if (group) return "group";
  return texting ? "one" : "app";
}

/** A text this old is not waiting, it was replayed: no wait is recorded for it. */
export const MAX_WAIT_MS = 24 * 60 * 60 * 1000;

/**
 * How long the text this turn answers waited before the gateway had it: from
 * `arrivedAt`, the time the texting Worker took in the first message the turn
 * covers, to `received`, when this route read the request. That wait is the
 * group pause, the decision, the queue and any retry, none of which the
 * turn's own `ms` sees. Nothing for a missing, future or day-old time; a
 * clock a little ahead of ours counts as no wait.
 */
export function waitBefore(arrivedAt, received) {
  if (typeof arrivedAt !== "number" || !Number.isFinite(arrivedAt)) return undefined;
  const wait = received - arrivedAt;
  if (wait > MAX_WAIT_MS || wait < -60_000) return undefined;
  return Math.max(0, Math.round(wait));
}

/**
 * The row `recordAgentTurn` keeps of a finished turn: names, outcomes, times
 * and token counts, never text. `waitMs` is `waitBefore`'s, when the Worker said when the text came in. `parts` is `meterParts(turn)` (`modelPlan.js`),
 * each model's own counts, which the control plane prices; a failed turn has
 * none and is priced from its own counts.
 */
export function turnReport({ provider, outcome, model, timing, usage, parts, kind, ms, waitMs }) {
  return {
    provider,
    model: typeof model === "string" ? model : "unknown",
    outcome,
    kind,
    ms,
    ...(typeof waitMs === "number" ? { waitMs } : {}),
    modelMs: timing?.modelMs ?? 0,
    toolMs: timing?.toolMs ?? 0,
    rounds: timing?.rounds ?? 0,
    inputTokens: usage?.input ?? 0,
    outputTokens: usage?.output ?? 0,
    ...(Array.isArray(parts) && parts.length > 0
      ? { usage: parts.filter((part) => typeof part.model === "string").map(({ model: name, input, output, cacheRead, cacheWrite }) => ({ model: name, input: input ?? 0, output: output ?? 0, cacheRead: cacheRead ?? 0, cacheWrite: cacheWrite ?? 0 })) }
      : {}),
    trace: Array.isArray(timing?.trace) ? timing.trace.map(wireTraceEntry) : [],
  };
}
